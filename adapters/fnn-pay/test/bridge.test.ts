import test from "node:test";
import assert from "node:assert/strict";
import { EscrowManager, MemoryStore, MockFiberClient, ckbToShannonsHex } from "@trickle/core";
import { FnnPayWebhookBridge } from "../src/index.js";

test("webhook bridge surfaces held funds and final states from the node", async () => {
  const client = new MockFiberClient();
  const mgr = new EscrowManager(client, new MemoryStore());
  const seen: string[] = [];
  const bridge = new FnnPayWebhookBridge(mgr, {
    onHeld: (e) => { seen.push("held:" + e.id.slice(0, 8)); },
    onCaptured: (e) => { seen.push("captured:" + e.id.slice(0, 8)); },
    onUnknown: () => { seen.push("unknown"); },
  });

  const e = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt" });

  // Buyer pays; fnn-pay would fire a "Received" webhook. The bridge re-reads the node.
  await client.sendPayment({ invoice: e.invoiceAddress });
  const held = await bridge.handleWebhook({ payment_hash: e.id, status: "Received" });
  assert.equal(held?.state, "Authorized");

  // Merchant captures (after app-layer auth), fnn-pay fires "Paid".
  await mgr.capture(e.id);
  const captured = await bridge.handleWebhook({ payment_hash: e.id, status: "Paid" });
  assert.equal(captured?.state, "Captured");

  // Unknown invoice does not throw.
  const unknown = await bridge.handleWebhook({ payment_hash: "0x" + "ff".repeat(32) });
  assert.equal(unknown, null);

  assert.deepEqual(seen.filter((s) => !s.startsWith("held:") ? true : true).slice(0, 3).map((s) => s.split(":")[0]), ["held", "captured", "unknown"]);
});
