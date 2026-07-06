// Browser-only. Real device passkey (WebAuthn / ES256 over P-256): register a credential whose
// private key never leaves the authenticator, then sign a Trickle capture token with it so a
// Face ID / Touch ID / Windows Hello tap authorizes a capture. This is the browser side that
// produces the assertion; the challenge is the capture token, and we return a PasskeyAssertion
// the gateway verifies.
import { p256 } from "@noble/curves/p256";
import type { PasskeyAssertion } from "./webauthn-verify.js";

const toHex = (b: Uint8Array) => "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
};

export interface RegisteredPasskey {
  /** credential id, base64url. */
  credId: string;
  /** raw 64-byte P-256 public key X||Y, "0x"+hex. The gateway pins this as the authorized capturer. */
  pubkey: string;
}

export async function registerPasskey(rpId: string, label = "Trickle"): Promise<RegisteredPasskey> {
  if (!globalThis.navigator?.credentials?.create) throw new Error("WebAuthn not available in this context");
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: label, id: rpId },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 = P-256
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      timeout: 60000,
    },
  })) as PublicKeyCredential;
  const resp = cred.response as AuthenticatorAttestationResponse;
  if (!resp.getPublicKey) throw new Error("authenticator did not expose the public key");
  const spki = new Uint8Array(resp.getPublicKey()!);
  if (spki[spki.length - 65] !== 0x04) throw new Error("unexpected public key format (not uncompressed P-256)");
  return { credId: b64u(new Uint8Array(cred.rawId)), pubkey: toHex(spki.slice(spki.length - 64)) };
}

/** Sign a 32-byte capture token with the device passkey, returning a verifiable assertion. */
export async function signCaptureToken(
  challenge: Uint8Array,
  passkey: RegisteredPasskey,
  rpId: string,
): Promise<PasskeyAssertion> {
  if (!globalThis.navigator?.credentials?.get) throw new Error("WebAuthn not available in this context");
  // Copy into a fresh ArrayBuffer-backed view so it satisfies BufferSource under strict lib.dom.
  const challengeBuf = new Uint8Array(challenge);
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: challengeBuf,
      rpId,
      allowCredentials: [{ type: "public-key", id: unb64u(passkey.credId) }],
      userVerification: "required",
      timeout: 60000,
    },
  })) as PublicKeyCredential;
  const r = assertion.response as AuthenticatorAssertionResponse;
  // WebAuthn signatures are ASN.1 DER; normalize to raw r||s for the verifier.
  const sig64 = p256.Signature.fromDER(new Uint8Array(r.signature)).toCompactRawBytes();
  return {
    authenticatorData: toHex(new Uint8Array(r.authenticatorData)),
    clientDataJSON: toHex(new Uint8Array(r.clientDataJSON)),
    signature: toHex(sig64),
    pubkey: passkey.pubkey,
  };
}
