import test from "node:test";
import assert from "node:assert/strict";
import { MockFiberClient, ckbToShannonsHex } from "@trickle/core";
import { operatorPubkey } from "@trickle/auth";
import {
  AllowanceSession,
  BudgetExceededError,
  RateExceededError,
  SessionMeter,
  type Grant,
  signGrantMofN,
  verifyGrant,
} from "../src/index.js";

const PRIVS = [
  "0x1111111111111111111111111111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333333333333333333333333333",
];
const POLICY = { signers: PRIVS.map((p) => ({ pubkey: operatorPubkey(p) })), threshold: 2 };

function grant(over: Partial<Grant> = {}): Grant {
  return {
    payee: "02" + "ab".repeat(32),
    asset: "CKB",
    maxTotal: ckbToShannonsHex(1), // 1 CKB budget
    maxRate: "0",
    sessionId: "sess-1",
    nonce: "0x01",
    expiry: 4102444800, // year 2100
    ...over,
  };
}

test("grant: 2-of-3 sign and verify, with tamper and expiry rejection", () => {
  const g = grant();
  const sg = signGrantMofN(g, [{ index: 0, priv: PRIVS[0] }, { index: 2, priv: PRIVS[2] }]);
  assert.equal(verifyGrant(sg, { policy: POLICY }).ok, true);

  // a single signature is below quorum
  const one = signGrantMofN(g, [{ index: 0, priv: PRIVS[0] }]);
  assert.equal(verifyGrant(one, { policy: POLICY }).ok, false);

  // tampering the budget invalidates the signatures
  const tampered = { ...sg, grant: { ...sg.grant, maxTotal: ckbToShannonsHex(1000) } };
  assert.equal(verifyGrant(tampered, { policy: POLICY }).ok, false);

  // expired
  assert.equal(verifyGrant(sg, { policy: POLICY, nowSeconds: 9999999999 }).ok, false);
});

test("session: ticks settle, spend tracks, and the budget cap stops it", async () => {
  const client = new MockFiberClient();
  const g = grant({ maxTotal: ckbToShannonsHex(1) }); // 1 CKB
  const session = new AllowanceSession(client, g, { pollMs: 1 });

  const tick = ckbToShannonsHex(0.1); // 0.1 CKB
  const n = await session.stream(tick);
  assert.equal(n, 10); // exactly 10 ticks fit in 1 CKB
  assert.equal(session.ticks(), 10);
  assert.equal(session.spent(), BigInt(ckbToShannonsHex(1)));
  assert.equal(session.remaining(), 0n);

  // any further tick is refused locally, before hitting the node
  await assert.rejects(() => session.tick(tick), BudgetExceededError);
});

test("session: rate cap is enforced", async () => {
  const client = new MockFiberClient();
  let clock = 0;
  const g = grant({ maxTotal: ckbToShannonsHex(100), maxRate: ckbToShannonsHex(0.15) }); // 0.15 CKB/sec
  const session = new AllowanceSession(client, g, { pollMs: 1, nowMs: () => clock });

  await session.tick(ckbToShannonsHex(0.1)); // ok
  await assert.rejects(() => session.tick(ckbToShannonsHex(0.1)), RateExceededError); // 0.2 > 0.15 in same second
  clock += 1100; // a second passes
  await session.tick(ckbToShannonsHex(0.1)); // ok again
  assert.equal(session.ticks(), 2);
});

test("meter: provider releases units in proportion to value actually received", async () => {
  const client = new MockFiberClient();
  const g = grant({ maxTotal: ckbToShannonsHex(1) });
  const session = new AllowanceSession(client, g, { pollMs: 1 });

  // provider prices service at 0.1 CKB per unit, reads its settled inbound from the mock
  const meter = new SessionMeter({ pricePerUnit: ckbToShannonsHex(0.1), balanceReader: async () => client.receivedShannons });
  await meter.start();
  assert.equal(await meter.releasedUnits(), 0);

  await session.stream(ckbToShannonsHex(0.1), { ticks: 4 });
  assert.equal(await meter.releasedUnits(), 4); // 0.4 CKB received -> 4 units
  assert.equal(await meter.receivedShannons(), BigInt(ckbToShannonsHex(0.4)));
});

test("meter: real channel-balance reader, non-zero baseline, bursty inbound, floor attribution", async () => {
  // Model a real fnn channel: list_channels returns a cumulative local_balance that is already
  // non-zero (the channel is funded) and grows as keysend ticks settle. This exercises the meter
  // the way stream-live.ts uses it (balanceReader over channels[i].local_balance), not a counter
  // that conveniently starts at zero.
  let localBalance = BigInt(ckbToShannonsHex(101)); // ~101 CKB already in the channel
  const settle = (ckbAmt: number) => { localBalance += BigInt(ckbToShannonsHex(ckbAmt)); };
  const meter = new SessionMeter({ pricePerUnit: ckbToShannonsHex(0.1), balanceReader: async () => localBalance });
  await meter.start();

  // the pre-existing 101 CKB is the baseline and must not be attributed as received value
  assert.equal(await meter.receivedShannons(), 0n);
  assert.equal(await meter.releasedUnits(), 0);

  // ticks settle one at a time; the meter releases in lockstep
  for (let i = 1; i <= 4; i++) {
    settle(0.1);
    assert.equal(await meter.releasedUnits(), i);
  }

  // bursty inbound: three ticks land between polls (the provider did not read in between);
  // attribution must not over- or under-count across the burst
  settle(0.1); settle(0.1); settle(0.1);
  assert.equal(await meter.releasedUnits(), 7);
  assert.equal(await meter.receivedShannons(), BigInt(ckbToShannonsHex(0.7)));

  // value below one full unit releases nothing (floor), and the baseline never leaks in
  settle(0.05);
  assert.equal(await meter.releasedUnits(), 7);
  assert.equal(await meter.receivedShannons(), BigInt(ckbToShannonsHex(0.75)));

  // a spurious lower reading (transient reorg / mis-read) yields no negative release
  const low = new SessionMeter({ pricePerUnit: ckbToShannonsHex(0.1), balanceReader: async () => BigInt(ckbToShannonsHex(101)) });
  await low.start();
  localBalance = BigInt(ckbToShannonsHex(100.9));
  assert.equal(await low.releasedUnits(), 0);
});

test("meter: inbound from another payer on the same channel is conflated (one channel per payer)", async () => {
  // The meter gates on the channel's total settled-inbound delta, so a second payer settling on the
  // SAME channel is counted too. This encodes the documented limitation: per-payer attribution needs
  // a dedicated channel per payer until fnn exposes a receiver-side incoming-keysend view.
  let localBalance = BigInt(ckbToShannonsHex(50));
  const meter = new SessionMeter({ pricePerUnit: ckbToShannonsHex(0.1), balanceReader: async () => localBalance });
  await meter.start();
  localBalance += BigInt(ckbToShannonsHex(0.2)); // payer A: 2 units
  localBalance += BigInt(ckbToShannonsHex(0.3)); // payer B on the same channel: 3 units
  assert.equal(await meter.releasedUnits(), 5); // conflated: 5, not 2
});
