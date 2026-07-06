// On-chain custody for captured Fiber payments. Funds settle into a value cell under the
// ckb-smart-account M-of-N / WebAuthn lock, so moving them afterwards requires an on-chain-verified
// quorum (vs the app-layer capture gate). The bootstrap / deposit / withdraw flows are ported from
// ckb-smart-account, driven from a CCC signer.
import { ccc } from "@ckb-ccc/core";
import {
  type AuthRecord,
  blake2bCkb,
  encodeConfig,
  encodeRecoverWitness,
  fromHex,
  r1PubkeyAndHash,
  r1SigField,
  toHex,
  u64le,
} from "./encoding.js";
import { type CustodyDeployment, type DepRef, PUDGE_CUSTODY } from "./deployment.js";

export interface CustodyAccount {
  /** account id = the Config Cell's TYPE_ID hash; stable across key rotation; the lock args. */
  accountId: string;
  lock: { codeHash: string; hashType: string; args: string };
  address: string;
  configCell: { txHash: string; index: number };
  valueCell: { txHash: string; index: number };
  bootstrapTx: string;
  threshold: number;
  /** blake160 auth hashes of the P-256 signer keys, in authenticator order. */
  signerHashes: string[];
}

export interface BootstrapOptions {
  /** P-256 private keys of the N custody operators, "0x"+64 hex. */
  signerPrivs: string[];
  /** M, the number of signatures required to move funds. */
  threshold: number;
  /** initial custody value cell size in CKB (default 1000). */
  initialCkb?: number;
  recoveryDelayBlocks?: bigint;
}

/** The custody lock script for an account id. */
export function custodyLock(accountId: string, d: CustodyDeployment = PUDGE_CUSTODY): ccc.Script {
  return ccc.Script.from({ codeHash: d.lock.codeHash, hashType: d.lock.hashType, args: accountId });
}

/**
 * sighash-all with the whole lock field zeroed to placeholderLen, ported from ckb-smart-account
 * and kept byte-compatible so the sighash matches the on-chain lock. Each signer signs this exact digest.
 */
export function sighashAll(tx: ccc.Transaction, groupIdxs: number[], placeholderLen: number): Uint8Array {
  const parts: Uint8Array[] = [fromHex(tx.hash())];
  const first = groupIdxs[0];
  const w0 = ccc.WitnessArgs.fromBytes(fromHex(tx.witnesses[first]));
  const zeroed = ccc.WitnessArgs.from({
    lock: toHex(new Uint8Array(placeholderLen)),
    inputType: w0.inputType,
    outputType: w0.outputType,
  }).toBytes();
  parts.push(u64le(zeroed.length), zeroed);
  for (const idx of groupIdxs.slice(1)) {
    const w = fromHex(tx.witnesses[idx] ?? "0x");
    parts.push(u64le(w.length), w);
  }
  for (let j = tx.inputs.length; j < tx.witnesses.length; j++) {
    const w = fromHex(tx.witnesses[j] ?? "0x");
    parts.push(u64le(w.length), w);
  }
  return blake2bCkb(...parts);
}

const codeDep = (r: DepRef) => ccc.CellDep.from({ outPoint: { txHash: r.txHash, index: r.index }, depType: r.depType });

/** Bootstrap a fresh M-of-N P-256 custody account (Config Cell + initial value cell). */
export async function bootstrapCustodyAccount(
  funder: ccc.Signer,
  opts: BootstrapOptions,
  d: CustodyDeployment = PUDGE_CUSTODY,
): Promise<CustodyAccount> {
  const client = funder.client;
  const r1Code = fromHex(d.authLibecc.dataHash);
  const auths: AuthRecord[] = opts.signerPrivs.map((p) => ({
    algoId: 17,
    authHash: r1PubkeyAndHash(p).hash,
    perTxCap: 0n,
    authCodeHash: r1Code,
  }));
  const configData = encodeConfig({
    spendThreshold: opts.threshold,
    recoveryThreshold: 1,
    recoveryDelay: opts.recoveryDelayBlocks ?? 100n,
    authenticators: auths,
    guardians: [auths[0]],
  });

  const deployerScript = (await funder.getRecommendedAddressObj()).script;
  const typeId = await client.getKnownScript(ccc.KnownScript.TypeId);
  const tid = (args: string) => ccc.Script.from({ codeHash: typeId.codeHash, hashType: typeId.hashType, args });
  const PH = "0x" + "00".repeat(32);

  const tx = ccc.Transaction.from({
    outputs: [
      { lock: deployerScript, type: tid(PH), capacity: ccc.fixedPointFrom(450) },
      { lock: deployerScript, capacity: ccc.fixedPointFrom(opts.initialCkb ?? 1000) },
    ],
    outputsData: [toHex(configData), "0x"],
  });
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.TypeId);
  await tx.completeInputsByCapacity(funder);

  const configTid = tid(ccc.hashTypeId(tx.inputs[0], 0));
  const accountId = configTid.hash();
  const accountLock = custodyLock(accountId, d);
  tx.outputs[0].lock = accountLock;
  tx.outputs[0].type = configTid;
  tx.outputs[1].lock = accountLock;
  await tx.completeFeeBy(funder, 1000);

  const h = await funder.sendTransaction(tx);
  await client.waitTransaction(h, 0, 600_000);

  return {
    accountId,
    lock: { codeHash: accountLock.codeHash, hashType: accountLock.hashType, args: accountLock.args },
    address: ccc.Address.fromScript(accountLock, client).toString(),
    configCell: { txHash: h, index: 0 },
    valueCell: { txHash: h, index: 1 },
    bootstrapTx: h,
    threshold: opts.threshold,
    signerHashes: auths.map((a) => toHex(a.authHash)),
  };
}

/** Sweep captured proceeds into a custody value cell under the account lock. */
export async function depositToCustody(funder: ccc.Signer, account: CustodyAccount, ckb: number): Promise<string> {
  const client = funder.client;
  const lock = ccc.Script.from(account.lock);
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: ccc.fixedPointFrom(ckb) }], outputsData: ["0x"] });
  await tx.completeInputsByCapacity(funder);
  await tx.completeFeeBy(funder, 1000);
  const h = await funder.sendTransaction(tx);
  await client.waitTransaction(h, 0, 600_000);
  return h;
}

export interface WithdrawSigner {
  index: number;
  priv: string;
}

export interface WithdrawOptions {
  /** the quorum that co-signs (length must be >= account.threshold, indices distinct). */
  signers: WithdrawSigner[];
  /** destination of the withdrawn funds: a ckt1 address or a CCC script. */
  to: string | ccc.Script;
  amountCkb: number;
  feeShannons?: bigint;
}

const OCCUPANCY_FLOOR = 6_100_000_000n; // ~61 CKB minimum cell capacity

/**
 * Move funds out of custody with an M-of-N P-256 quorum. The Config Cell is referenced as a cell dep
 * (the lock reads the policy from it); each signer signs the same sighash; the lock verifies the
 * quorum on-chain via ckb-auth. Returns the spend tx hash.
 */
export async function withdrawFromCustody(
  client: ccc.Client,
  account: CustodyAccount,
  opts: WithdrawOptions,
  d: CustodyDeployment = PUDGE_CUSTODY,
): Promise<{ txHash: string; fromCell: ccc.OutPoint }> {
  const accountLock = ccc.Script.from(account.lock);

  let valueCell: ccc.Cell | undefined;
  for await (const cell of client.findCellsByLock(accountLock)) {
    if (!cell.cellOutput.type) {
      valueCell = cell;
      break;
    }
  }
  if (!valueCell) throw new Error("no spendable custody value cell under the account lock");

  const valCap = valueCell.cellOutput.capacity;
  const send = ccc.fixedPointFrom(opts.amountCkb);
  const fee = opts.feeShannons ?? 200_000n;
  const change = valCap - send - fee;
  if (change < OCCUPANCY_FLOOR) {
    throw new Error(`change ${change} below cell occupancy floor; withdraw less or top up the cell`);
  }

  const toScript = typeof opts.to === "string" ? (await ccc.Address.fromString(opts.to, client)).script : opts.to;

  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: valueCell.outPoint }],
    outputs: [
      { lock: toScript, capacity: send },
      { lock: accountLock, capacity: change },
    ],
    outputsData: ["0x", "0x"],
    cellDeps: [
      codeDep(d.lock.dep),
      codeDep(d.authLibecc.dep),
      codeDep(d.secpDep),
      ccc.CellDep.from({ outPoint: { txHash: account.configCell.txHash, index: account.configCell.index }, depType: "code" }),
    ],
  });

  // MultiSpend (mode 5): placeholder witness sized for M P-256 sigs (128 bytes each), then sign.
  const placeholderSigs = opts.signers.map((s) => ({ index: s.index, signature: new Uint8Array(128) }));
  const ph = encodeRecoverWitness(5, placeholderSigs);
  tx.witnesses = [toHex(ccc.WitnessArgs.from({ lock: toHex(ph) }).toBytes())];

  const msg = sighashAll(tx, [0], ph.length);
  const sigs = opts.signers.map((s) => ({ index: s.index, signature: r1SigField(s.priv, msg) }));
  tx.witnesses[0] = toHex(ccc.WitnessArgs.from({ lock: toHex(encodeRecoverWitness(5, sigs)) }).toBytes());

  const h = await client.sendTransaction(tx);
  await client.waitTransaction(h, 0, 600_000);
  return { txHash: h, fromCell: valueCell.outPoint };
}
