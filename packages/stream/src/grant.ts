// A Trickle is a signed, off-chain spending allowance: the payer authorizes a budget once
// ("up to maxTotal to this payee, at most maxRate/sec, until expiry"), then a stream of keysend ticks
// runs unattended under it. The authorization reuses @trickle/auth: a passkey or an M-of-N quorum
// signs the grant digest. No cell, no on-chain state.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import {
  type MofNPolicy,
  type MofNSignature,
  type PasskeyAssertion,
  pubkeyId,
  signCaptureMofN,
  verifyMofN,
  verifyPasskeyAssertion,
} from "@trickle/auth";

export interface Grant {
  /** receiver (provider) node pubkey, 66 hex (no 0x). */
  payee: string;
  /** asset label: "CKB" or a UDT identifier (the actual udt_type_script travels with the session). */
  asset: string;
  /** spending cap in shannons / token base units (decimal or hex string). */
  maxTotal: string;
  /** rate cap in shannons per second; "0" = unmetered rate. */
  maxRate: string;
  sessionId: string;
  nonce: string;
  /** unix seconds. */
  expiry: number;
}

const canonical = (g: Grant) =>
  JSON.stringify([g.payee, g.asset, String(BigInt(g.maxTotal)), String(BigInt(g.maxRate)), g.sessionId, g.nonce, g.expiry]);

/** 32-byte digest the authorizer signs (and the WebAuthn challenge, for the passkey path). */
export function grantDigest(g: Grant): Uint8Array {
  return sha256(utf8ToBytes(canonical(g)));
}
export const grantDigestHex = (g: Grant): string => "0x" + bytesToHex(grantDigest(g));

export interface SignedGrant {
  grant: Grant;
  mofn?: { signatures: MofNSignature[] };
  passkey?: { assertion: PasskeyAssertion };
}

/** Sign a grant with M-of-N operator keys (the headless / treasury path). */
export function signGrantMofN(grant: Grant, signers: { index: number; priv: string }[]): SignedGrant {
  const d = grantDigest(grant);
  return { grant, mofn: { signatures: signers.map((s) => ({ index: s.index, signature: signCaptureMofN(d, s.priv) })) } };
}

export interface VerifyGrantOptions {
  policy?: MofNPolicy;
  passkeyPubkey?: string;
  nowSeconds?: number;
}

/** Verify a grant's authorization and that it has not expired. Provider calls this before metering. */
export function verifyGrant(sg: SignedGrant, opts: VerifyGrantOptions): { ok: boolean; reason?: string } {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now > sg.grant.expiry) return { ok: false, reason: "grant expired" };
  const d = grantDigest(sg.grant);
  if (sg.mofn && opts.policy) {
    const r = verifyMofN(d, sg.mofn.signatures, opts.policy, sg.grant.maxTotal);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  if (sg.passkey && opts.passkeyPubkey) {
    if (pubkeyId(sg.passkey.assertion.pubkey) !== pubkeyId(opts.passkeyPubkey)) return { ok: false, reason: "passkey not authorized" };
    const r = verifyPasskeyAssertion(d, sg.passkey.assertion);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  return { ok: false, reason: "no verifiable authorization for the grant" };
}
