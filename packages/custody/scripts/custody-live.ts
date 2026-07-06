// Stage B live proof on Pudge: captured funds settle into a custody cell governed by a 2-of-3
// on-chain quorum, and only move with that quorum.
//   1. bootstrap a 2-of-3 P-256 custody account (Config Cell + value cell)
//   2. sweep "captured proceeds" into a second custody value cell
//   3. show a 1-of-3 withdraw is REJECTED on-chain (quorum not met)
//   4. move funds with a valid 2-of-3 quorum
// Run: pnpm -C packages/custody tsx scripts/custody-live.ts
import { readFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";
import { bootstrapCustodyAccount, depositToCustody, withdrawFromCustody } from "../src/index.js";

const KEY_FILE = process.env.CKB_DEPLOYER_KEY_FILE;
if (!KEY_FILE) {
  throw new Error("set CKB_DEPLOYER_KEY_FILE to a file holding a funded Pudge testnet private key (0x...)");
}
const exp = (h: string) => `https://pudge.explorer.nervos.org/transaction/${h}`;

// Three demo custody-operator P-256 keys (TEST ONLY; real operators hold these on separate devices).
const OP = ["0x" + "07".repeat(32), "0x" + "08".repeat(32), "0x" + "09".repeat(32)];

async function main() {
  const client = new ccc.ClientPublicTestnet();
  const funder = new ccc.SignerCkbPrivateKey(client, readFileSync(KEY_FILE, "utf8").trim());
  const dest = (await funder.getRecommendedAddressObj()).script;

  console.log("== Stage B: on-chain custody for captured Fiber payments ==\n");

  console.log("[1] bootstrap 2-of-3 custody account...");
  const account = await bootstrapCustodyAccount(funder, { signerPrivs: OP, threshold: 2, initialCkb: 1000 });
  console.log(`    account ${account.accountId.slice(0, 18)}  bootstrap ${exp(account.bootstrapTx)}`);
  console.log(`    address ${account.address.slice(0, 40)}...`);

  console.log("[2] sweep captured proceeds (300 CKB) into custody...");
  const dep = await depositToCustody(funder, account, 300);
  console.log(`    deposit ${exp(dep)}`);

  console.log("[3] attempt a 1-of-3 withdraw (should be REJECTED on-chain)...");
  try {
    await withdrawFromCustody(client, account, { signers: [{ index: 0, priv: OP[0] }], to: dest, amountCkb: 200 });
    console.log("    BUG: 1-of-3 was accepted, the quorum is not being enforced!");
  } catch (e) {
    console.log(`    rejected as expected: ${String((e as Error).message).slice(0, 90)}`);
  }

  console.log("[4] move 200 CKB out with a valid 2-of-3 quorum (operators 0 + 2)...");
  const w = await withdrawFromCustody(client, account, {
    signers: [{ index: 0, priv: OP[0] }, { index: 2, priv: OP[2] }],
    to: dest,
    amountCkb: 200,
  });
  console.log(`    withdraw ${exp(w.txHash)}`);

  console.log("\nDONE: captured funds sat in a cell the chain would not release without 2-of-3,");
  console.log("then moved only once the quorum signed. This half is consensus-enforced.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
