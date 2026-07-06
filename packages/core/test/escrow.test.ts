import test from "node:test";
import assert from "node:assert/strict";
import {
  CaptureNotAuthorizedError,
  EscrowManager,
  EscrowNotHeldError,
  MemoryStore,
  MockFiberClient,
  ckbToShannonsHex,
  hashPreimage,
  randomPreimage,
  verifyPreimage,
} from "../src/index.js";

test("preimage: 32-byte hash roundtrip, and non-32-byte rejected", () => {
  const pre = randomPreimage();
  const h = hashPreimage(pre, "sha256");
  assert.ok(verifyPreimage(pre, h, "sha256"));
  assert.equal(verifyPreimage("0xdeadbeef", h, "sha256"), false);
  assert.throws(() => hashPreimage("0x1234", "sha256"));
});

test("capture path: authorize -> pay -> Authorized -> capture -> Captured", async () => {
  const client = new MockFiberClient();
  const store = new MemoryStore();
  const mgr = new EscrowManager(client, store);

  const e = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt", description: "demo" });
  assert.equal(e.state, "Pending");

  await client.sendPayment({ invoice: e.invoiceAddress }); // buyer pays the hold invoice
  const held = await mgr.refresh(e.id);
  assert.equal(held.state, "Authorized");

  const captured = await mgr.capture(e.id);
  assert.equal(captured.state, "Captured");
  assert.equal((await client.getPayment(e.id)).status, "Success");
});

test("cancel path: authorize -> pay -> refund -> Refunded", async () => {
  const client = new MockFiberClient();
  const store = new MemoryStore();
  const mgr = new EscrowManager(client, store);

  const e = await mgr.authorize({ amount: ckbToShannonsHex(2), currency: "Fibt" });
  await client.sendPayment({ invoice: e.invoiceAddress });
  await mgr.refresh(e.id);

  const refunded = await mgr.refund(e.id);
  assert.equal(refunded.state, "Refunded");
  assert.equal((await client.getPayment(e.id)).status, "Failed");
});

test("cannot capture before the hold is Authorized", async () => {
  const client = new MockFiberClient();
  const mgr = new EscrowManager(client, new MemoryStore());
  const e = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt" });
  await assert.rejects(() => mgr.capture(e.id), EscrowNotHeldError); // still Pending
});

test("authorizer gate blocks unauthorized capture and allows authorized", async () => {
  const client = new MockFiberClient();
  const store = new MemoryStore();
  let allow = false;
  const mgr = new EscrowManager(client, store, {
    authorizer: { authorize: async () => allow },
  });
  const e = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt" });
  await client.sendPayment({ invoice: e.invoiceAddress });
  await mgr.refresh(e.id);

  await assert.rejects(() => mgr.capture(e.id, { sig: "bad" }), CaptureNotAuthorizedError);
  allow = true;
  const ok = await mgr.capture(e.id, { sig: "good" });
  assert.equal(ok.state, "Captured");
});
