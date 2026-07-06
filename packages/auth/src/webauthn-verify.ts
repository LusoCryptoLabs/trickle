import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

// Server-side verification of a WebAuthn (ES256 / P-256) assertion: base64url-decode the challenge
// from clientDataJSON and require it to equal the expected challenge, reconstruct
// digest = SHA256(authData || SHA256(clientDataJSON)), then check the P-256 signature against the
// credential public key.

export interface PasskeyAssertion {
  /** authenticatorData bytes, "0x"+hex. */
  authenticatorData: string;
  /** clientDataJSON bytes, "0x"+hex. */
  clientDataJSON: string;
  /** ECDSA signature, raw 64-byte r||s or ASN.1 DER, "0x"+hex. */
  signature: string;
  /** credential public key: 64-byte X||Y, or 65-byte 0x04||X||Y, "0x"+hex. */
  pubkey: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

function strip0x(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}
function toBytes(h: string): Uint8Array {
  return hexToBytes(strip0x(h));
}
function b64urlFromBytes(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function normalizePubkey(pub: Uint8Array): Uint8Array {
  if (pub.length === 65 && pub[0] === 0x04) return pub;
  if (pub.length === 64) return concatBytes(Uint8Array.of(0x04), pub);
  if (pub.length === 33 && (pub[0] === 0x02 || pub[0] === 0x03)) return pub; // compressed
  throw new Error(`unexpected P-256 public key length ${pub.length}`);
}

/**
 * Verify a passkey assertion over `expectedChallenge` (the 32-byte capture token).
 * Returns ok=false with a reason rather than throwing, so callers can branch cleanly.
 */
export function verifyPasskeyAssertion(expectedChallenge: Uint8Array, a: PasskeyAssertion): VerifyResult {
  let client: { type?: string; challenge?: string };
  const clientBytes = toBytes(a.clientDataJSON);
  try {
    client = JSON.parse(new TextDecoder().decode(clientBytes));
  } catch {
    return { ok: false, reason: "clientDataJSON is not valid JSON" };
  }
  if (client.type !== "webauthn.get") return { ok: false, reason: `unexpected clientData.type ${client.type}` };
  if (client.challenge !== b64urlFromBytes(expectedChallenge)) {
    return { ok: false, reason: "challenge does not match the expected capture token" };
  }

  const authData = toBytes(a.authenticatorData);
  const digest = sha256(concatBytes(authData, sha256(clientBytes)));

  let sigCompact: Uint8Array;
  const sigBytes = toBytes(a.signature);
  try {
    const parsed = sigBytes.length === 64 ? p256.Signature.fromCompact(sigBytes) : p256.Signature.fromDER(sigBytes);
    sigCompact = parsed.toCompactRawBytes();
  } catch {
    return { ok: false, reason: "signature is neither raw 64-byte nor valid DER" };
  }

  // WebAuthn P-256 has no low-S requirement, so accept high-S (lowS: false).
  const valid = p256.verify(sigCompact, digest, normalizePubkey(toBytes(a.pubkey)), { lowS: false });
  return valid ? { ok: true } : { ok: false, reason: "P-256 signature verification failed" };
}

/** Convenience: the credential public key as a stable lowercase hex id (64-byte X||Y). */
export function pubkeyId(pub: string): string {
  const b = toBytes(pub);
  const xy = b.length === 65 ? b.slice(1) : b;
  return "0x" + bytesToHex(xy);
}
