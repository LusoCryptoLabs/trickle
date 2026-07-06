import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

// M-of-N capture authorization, ported from ckb-smart-account.
// Each operator signs the same capture token; we require `threshold`
// distinct valid signers, and the effective per-capture cap is the MIN of the caps of the signers
// that actually co-signed, so a low-trust capped key can never enable a larger capture than its own
// cap. Runs in the gateway over secp256k1 operator keys (application layer, not on-chain).

function toBytes(h: string): Uint8Array {
  return hexToBytes(h.startsWith("0x") ? h.slice(2) : h);
}

export interface MofNSigner {
  /** secp256k1 public key, 33-byte compressed, "0x"+hex. */
  pubkey: string;
  /** Optional per-capture cap in the same units as the amount (0 / undefined = unlimited). */
  perTxCap?: string | bigint;
}

export interface MofNPolicy {
  signers: MofNSigner[];
  threshold: number;
}

export interface MofNSignature {
  index: number;
  /** raw 64-byte compact r||s, "0x"+hex. */
  signature: string;
}

export interface MofNResult {
  ok: boolean;
  reason?: string;
  count: number;
  effectiveCap?: bigint;
}

/**
 * @param message the 32-byte capture token each operator signed.
 * @param amount optional capture amount to check against the effective cap.
 */
export function verifyMofN(
  message: Uint8Array,
  sigs: MofNSignature[],
  policy: MofNPolicy,
  amount?: string | bigint,
): MofNResult {
  const n = policy.signers.length;
  const seen = new Set<number>();
  let count = 0;
  let effCap = 0n;

  for (const { index, signature } of sigs) {
    if (index < 0 || index >= n || seen.has(index)) {
      return { ok: false, reason: `duplicate or out-of-range signer index ${index}`, count };
    }
    const signer = policy.signers[index];
    let valid = false;
    try {
      valid = secp256k1.verify(toBytes(signature), message, toBytes(signer.pubkey));
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: `invalid signature from signer ${index}`, count };
    seen.add(index);
    const cap = signer.perTxCap ? BigInt(signer.perTxCap) : 0n;
    if (cap !== 0n) effCap = effCap === 0n ? cap : cap < effCap ? cap : effCap;
    count += 1;
  }

  if (count < policy.threshold) {
    return { ok: false, reason: `quorum not met (${count}/${policy.threshold})`, count };
  }
  if (amount !== undefined && effCap !== 0n && BigInt(amount) > effCap) {
    return { ok: false, reason: "per-capture cap exceeded", count, effectiveCap: effCap };
  }
  return { ok: true, count, effectiveCap: effCap };
}

// Helpers for operators to produce signatures (and for tests/demos)

/** Sign a capture token with a secp256k1 operator key. Returns raw 64-byte compact hex. */
export function signCaptureMofN(message: Uint8Array, privkey: string): string {
  const sig = secp256k1.sign(message, toBytes(privkey));
  return "0x" + bytesToHex(sig.toCompactRawBytes());
}

/** Derive the compressed public key for an operator private key. */
export function operatorPubkey(privkey: string): string {
  return "0x" + bytesToHex(secp256k1.getPublicKey(toBytes(privkey), true));
}
