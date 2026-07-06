// Live Trickle demo on two fnn v0.8.1 nodes: a pay-per-API-call metered session.
// Authorize a budget ONCE (2-of-3), then stream keysend ticks; the provider releases API calls as
// value actually settles, and the budget auto-stops the stream. Nothing is ever held, no cell.
// Run: pnpm -C packages/stream tsx scripts/stream-live.ts
import { FiberClient } from "@trickle/core";
import { operatorPubkey } from "@trickle/auth";
import { AllowanceSession, BudgetExceededError, SessionMeter, signGrantMofN, verifyGrant, type Grant } from "../src/index.js";

const PAYER_RPC = process.env.PAYER_RPC ?? "http://127.0.0.1:8227";
const PROVIDER_RPC = process.env.PROVIDER_RPC ?? "http://127.0.0.1:8237";
const ckb = (c: number) => "0x" + Math.round(c * 1e8).toString(16);
const toCkb = (s: bigint) => Number(s) / 1e8;

// three demo operator keys (TEST ONLY); 2-of-3 authorizes the budget once.
const OPS = ["0x" + "11".repeat(32), "0x" + "22".repeat(32), "0x" + "33".repeat(32)];
const POLICY = { signers: OPS.map((p) => ({ pubkey: operatorPubkey(p) })), threshold: 2 };

async function providerLocalBalance(): Promise<bigint> {
  const r = await fetch(PROVIDER_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "list_channels", params: [{}] }),
  });
  const d = await r.json();
  return BigInt(d.result.channels[0].local_balance);
}

async function main() {
  const payer = new FiberClient(PAYER_RPC);
  const provInfo = await new FiberClient(PROVIDER_RPC).getNodeInfo();
  const payee = provInfo.pubkey; // 66-hex, no 0x: the keysend target

  console.log("== Trickle: pay-per-API-call over Fiber (no holds, no cells) ==\n");

  // 1. authorize a 2 CKB budget at up to 1 CKB/sec, signed by a 2-of-3 quorum (one consent, not per tick)
  const grant: Grant = {
    payee, asset: "CKB", maxTotal: ckb(2), maxRate: ckb(1),
    sessionId: "api-" + Math.floor(Date.now() / 1000), nonce: "0x" + Math.floor(Date.now()).toString(16),
    expiry: Math.floor(Date.now() / 1000) + 3600,
  };
  const signed = signGrantMofN(grant, [{ index: 0, priv: OPS[0] }, { index: 2, priv: OPS[2] }]);
  console.log(`[1] budget authorized once: ${toCkb(BigInt(grant.maxTotal))} CKB to provider ${payee.slice(0, 14)}...  verify=${verifyGrant(signed, { policy: POLICY }).ok}`);

  // 2. provider meters: 0.1 CKB per API call, gating on value actually settled into its channel
  const PRICE = 0.1;
  const meter = new SessionMeter({ pricePerUnit: ckb(PRICE), balanceReader: providerLocalBalance });
  await meter.start();
  console.log(`[2] provider meter live: ${PRICE} CKB per API call, gating on settled inbound\n`);

  // 3. stream: each tick is a keysend that settles in ms; provider releases calls as value lands
  const session = new AllowanceSession(payer, grant);
  await session.stream(ckb(PRICE), {
    onTick: async (r) => {
      const calls = await meter.releasedUnits();
      console.log(`    tick ${String(r.cursor).padStart(2)}  paid ${PRICE} CKB  fee ${BigInt(r.fee)}  ->  provider released ${calls} API calls`);
    },
  });

  console.log(`\n[3] stream auto-stopped at the budget: spent ${toCkb(session.spent())} CKB over ${session.ticks()} ticks, ${toCkb(session.remaining())} CKB remaining`);

  // 4. the cap is enforced locally: one more tick is refused before it ever hits the node
  try {
    await session.tick(ckb(PRICE));
    console.log("[4] BUG: a tick past the budget was allowed");
  } catch (e) {
    console.log(`[4] further tick refused: ${(e as Error).name} (budget cap holds)`);
  }

  console.log(`\nDONE: ${await meter.releasedUnits()} API calls delivered, paid continuously, never held, never overspent.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
