import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils";

// The capture token is the thing a passkey / M-of-N signature commits to. It binds the capture
// decision to (which escrow, how much, this attempt), so a signature can never be replayed onto a
// different or larger capture:
//
//   token = SHA256( payment_hash[32] || amount_be[16] || nonce )
//
// For the passkey path the 32-byte token is the WebAuthn challenge; for the M-of-N path it is the
// message each operator signs.

function strip0x(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

function paymentHashBytes(paymentHash: string): Uint8Array {
  const b = hexToBytes(strip0x(paymentHash));
  if (b.length !== 32) throw new Error(`payment_hash must be 32 bytes, got ${b.length}`);
  return b;
}

function amountBe16(amount: string): Uint8Array {
  let v = BigInt(amount); // accepts "0x..." or decimal string
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("amount exceeds 128 bits");
  return out;
}

export interface CaptureToken {
  /** 32-byte SHA256 digest, "0x"+64 hex. */
  token: string;
  /** Random nonce bound into the token, "0x"+hex. Persist it to reconstruct the token at verify time. */
  nonce: string;
  paymentHash: string;
  amount: string;
}

/** Build (or reconstruct, if `nonce` is supplied) the capture token for an escrow. */
export function buildCaptureToken(paymentHash: string, amount: string, nonce?: string): CaptureToken {
  const n = nonce ? hexToBytes(strip0x(nonce)) : randomBytes(16);
  const digest = sha256(concatBytes(paymentHashBytes(paymentHash), amountBe16(amount), n));
  return { token: "0x" + bytesToHex(digest), nonce: "0x" + bytesToHex(n), paymentHash, amount };
}

/** The raw 32-byte token, for use as a WebAuthn challenge. */
export function captureTokenBytes(t: CaptureToken): Uint8Array {
  return hexToBytes(strip0x(t.token));
}
