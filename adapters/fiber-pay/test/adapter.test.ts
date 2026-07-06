import test from "node:test";
import assert from "node:assert/strict";
import { EscrowManager, MemoryStore, ckbToShannonsHex } from "@trickle/core";
import { MofNAuthorizer, buildCaptureToken, captureTokenBytes, operatorPubkey, signCaptureMofN } from "@trickle/auth";
import { FiberPayClientAdapter, type FiberPayRpcClient } from "../src/index.js";

// A stand-in for @fiber-pay/sdk's FiberRpcClient (param-object style), with the same hold lifecycle.
function fakeFiberPayClient(): FiberPayRpcClient {
  const invoices = new Map<string, string>(); // payment_hash -> status
  const k = (h: string) => h.toLowerCase();
  return {
    async newInvoice(p) { invoices.set(k(p.payment_hash), "Open"); return { invoice_address: "fibt_fp_" + p.payment_hash.replace(/^0x/, "") }; },
    async parseInvoice() { return {}; },
    async getInvoice(p) { return { status: invoices.get(k(p.payment_hash)) ?? "Open" }; },
    async cancelInvoice(p) { invoices.set(k(p.payment_hash), "Cancelled"); return { status: "Cancelled" }; },
    async settleInvoice(p) {
      if (invoices.get(k(p.payment_hash)) !== "Received") throw new Error("settle requires Received");
      invoices.set(k(p.payment_hash), "Paid");
    },
    async sendPayment(p) {
      const h = p.payment_hash ?? "0x" + (p.invoice ?? "").replace("fibt_fp_", "");
      if (invoices.get(k(h)) === "Open") invoices.set(k(h), "Received");
      return { payment_hash: h, status: "Inflight" };
    },
    async getPayment(p) { return { payment_hash: p.payment_hash, status: "Inflight" }; },
    async nodeInfo() { return { version: "0.8.1", pubkey: "0xfeed", chain_hash: "0x10639e08", peers_count: 2 }; },
  };
}

test("Trickle authorize-then-capture runs through a @fiber-pay/sdk-shaped client", async () => {
  const rpc = fakeFiberPayClient();
  const client = new FiberPayClientAdapter(rpc);
  const privs = [
    "0x1111111111111111111111111111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333333333333333333333333333",
  ];
  const policy = { signers: privs.map((p) => ({ pubkey: operatorPubkey(p) })), threshold: 2 };
  const mgr = new EscrowManager(client, new MemoryStore(), { authorizer: new MofNAuthorizer(policy) });

  const e = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt", description: "via fiber-pay" });
  await client.sendPayment({ invoice: e.invoiceAddress });
  const held = await mgr.refresh(e.id);
  assert.equal(held.state, "Authorized");

  const tok = buildCaptureToken(e.paymentHash, e.amount);
  const msg = captureTokenBytes(tok);
  const signatures = [
    { index: 0, signature: signCaptureMofN(msg, privs[0]) },
    { index: 1, signature: signCaptureMofN(msg, privs[1]) },
  ];
  const captured = await mgr.capture(e.id, { signatures, nonce: tok.nonce });
  assert.equal(captured.state, "Captured");

  // nodeInfo mapping (number peers_count -> hex)
  const info = await client.getNodeInfo();
  assert.equal(info.peers_count, "0x2");
});

test("adapter refund path", async () => {
  const client = new FiberPayClientAdapter(fakeFiberPayClient());
  const mgr = new EscrowManager(client, new MemoryStore());
  const e = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt" });
  await client.sendPayment({ invoice: e.invoiceAddress });
  await mgr.refresh(e.id);
  const r = await mgr.refund(e.id);
  assert.equal(r.state, "Refunded");
});
