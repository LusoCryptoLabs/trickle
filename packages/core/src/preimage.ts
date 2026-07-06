import { sha256 } from "@noble/hashes/sha256";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import type { Hash256, HashAlgorithm } from "./types.js";

// Fiber (like Lightning) requires the preimage to be exactly 32 bytes, with
// payment_hash = hash(preimage).
const CKB_HASH_PERSONAL = new TextEncoder().encode("ckb-default-hash"); // 16 bytes

function strip0x(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

/** A fresh, cryptographically random 32-byte preimage as "0x"+64 hex. */
export function randomPreimage(): Hash256 {
  return "0x" + bytesToHex(randomBytes(32));
}

/** Deterministic 32-byte preimage from a label (handy for reproducible demos). */
export function deterministicPreimage(label: string): Hash256 {
  return "0x" + bytesToHex(sha256(new TextEncoder().encode(label)));
}

/** payment_hash = hash(preimage), matching the invoice's hash_algorithm. */
export function hashPreimage(preimage: Hash256, algo: HashAlgorithm = "sha256"): Hash256 {
  const bytes = hexToBytes(strip0x(preimage));
  if (bytes.length !== 32) {
    throw new Error(`preimage must be exactly 32 bytes, got ${bytes.length}`);
  }
  const digest =
    algo === "sha256"
      ? sha256(bytes)
      : blake2b(bytes, { dkLen: 32, personalization: CKB_HASH_PERSONAL });
  return "0x" + bytesToHex(digest);
}

/** True iff hash(preimage) === paymentHash under the given algorithm. */
export function verifyPreimage(preimage: Hash256, paymentHash: Hash256, algo: HashAlgorithm = "sha256"): boolean {
  try {
    return hashPreimage(preimage, algo).toLowerCase() === paymentHash.toLowerCase();
  } catch {
    return false;
  }
}
