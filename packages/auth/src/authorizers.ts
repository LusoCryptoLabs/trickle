import type { CaptureAuthorizer, Escrow } from "@trickle/core";
import { buildCaptureToken, captureTokenBytes } from "./capture-token.js";
import { type MofNPolicy, type MofNSignature, verifyMofN } from "./mofn.js";
import { type PasskeyAssertion, pubkeyId, verifyPasskeyAssertion } from "./webauthn-verify.js";

// These implement @trickle/core's CaptureAuthorizer, so an EscrowManager can be constructed with
// one and capture() will only proceed when the proof verifies. The token is rebuilt from the escrow
// itself (payment_hash + amount), so a proof is bound to exactly that capture and cannot be replayed
// onto a different or larger one. The check runs at the application layer; settle_invoice (the
// actual capture) is an off-chain node RPC.

export interface PasskeyProof {
  assertion: PasskeyAssertion;
  /** the nonce that was bound into the capture token (from buildCaptureToken). */
  nonce: string;
}

/** Capture is authorized iff a single pinned device passkey signs the capture token. */
export class PasskeyAuthorizer implements CaptureAuthorizer {
  /** @param authorizedPubkey the credential public key (64-byte X||Y, or 65/33-byte) pinned as the capturer. */
  constructor(private readonly authorizedPubkey: string) {}

  async authorize(escrow: Escrow, proof: unknown): Promise<boolean> {
    const p = proof as PasskeyProof | undefined;
    if (!p?.assertion || !p.nonce) return false;
    if (pubkeyId(p.assertion.pubkey) !== pubkeyId(this.authorizedPubkey)) return false;
    const token = buildCaptureToken(escrow.paymentHash, escrow.amount, p.nonce);
    return verifyPasskeyAssertion(captureTokenBytes(token), p.assertion).ok;
  }
}

export interface MofNProof {
  signatures: MofNSignature[];
  nonce: string;
}

/** Capture is authorized iff a quorum of operator keys co-sign the capture token (within caps). */
export class MofNAuthorizer implements CaptureAuthorizer {
  constructor(private readonly policy: MofNPolicy) {}

  async authorize(escrow: Escrow, proof: unknown): Promise<boolean> {
    const p = proof as MofNProof | undefined;
    if (!p?.signatures || !p.nonce) return false;
    const token = buildCaptureToken(escrow.paymentHash, escrow.amount, p.nonce);
    return verifyMofN(captureTokenBytes(token), p.signatures, this.policy, escrow.amount).ok;
  }
}
