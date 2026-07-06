import test from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
  EscrowManager,
  MemoryStore,
  MockFiberClient,
  ckbToShannonsHex,
} from "@trickle/core";
import {
  MofNAuthorizer,
  PasskeyAuthorizer,
  buildCaptureToken,
  captureTokenBytes,
  operatorPubkey,
  signCaptureMofN,
  verifyMofN,
  verifyPasskeyAssertion,
  type PasskeyAssertion,
} from "../src/index.js";

const hex = (b: Uint8Array) => "0x" + bytesToHex(b);
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Simulate an authenticator signing a challenge, to exercise the verify recipe without a device.
function simulateAssertion(challenge: Uint8Array, priv: Uint8Array): PasskeyAssertion {
  const clientData = utf8ToBytes(JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin: "https://merchant.example" }));
  const rpIdHash = sha256(utf8ToBytes("merchant.example"));
  const authData = concatBytes(rpIdHash, Uint8Array.of(0x05), new Uint8Array(4)); // flags UP|UV, counter 0
  const digest = sha256(concatBytes(authData, sha256(clientData)));
  const sig = p256.sign(digest, priv, { lowS: false });
  return {
    authenticatorData: hex(authData),
    clientDataJSON: hex(clientData),
    signature: hex(sig.toCompactRawBytes()),
    pubkey: hex(p256.getPublicKey(priv, false).slice(1)), // 64-byte X||Y
  };
}

const PRIVS = [
  "0x1111111111111111111111111111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333333333333333333333333333",
];

test("M-of-N: 2-of-3 quorum, distinctness, and cap enforcement", () => {
  const token = buildCaptureToken("0x" + "ab".repeat(32), ckbToShannonsHex(5));
  const msg = captureTokenBytes(token);
  const signers = PRIVS.map((p) => ({ pubkey: operatorPubkey(p) }));
  const policy = { signers, threshold: 2 };

  const s0 = { index: 0, signature: signCaptureMofN(msg, PRIVS[0]) };
  const s1 = { index: 1, signature: signCaptureMofN(msg, PRIVS[1]) };

  assert.equal(verifyMofN(msg, [s0, s1], policy).ok, true);
  assert.equal(verifyMofN(msg, [s0], policy).ok, false); // below quorum
  assert.equal(verifyMofN(msg, [s0, { index: 0, signature: s1.signature }], policy).ok, false); // dup index

  // cap: signer 0 capped at 1 CKB; a 5 CKB capture with signer 0 co-signing must fail.
  const capped = { signers: [{ pubkey: signers[0].pubkey, perTxCap: ckbToShannonsHex(1) }, signers[1], signers[2]], threshold: 2 };
  assert.equal(verifyMofN(msg, [s0, s1], capped, ckbToShannonsHex(5)).ok, false);
  assert.equal(verifyMofN(msg, [s0, s1], capped, ckbToShannonsHex(1)).ok, true);
});

test("WebAuthn verify recipe: valid assertion passes, tampering fails", () => {
  const priv = p256.utils.randomPrivateKey();
  const token = buildCaptureToken("0x" + "cd".repeat(32), ckbToShannonsHex(2));
  const challenge = captureTokenBytes(token);
  const assertion = simulateAssertion(challenge, priv);

  assert.equal(verifyPasskeyAssertion(challenge, assertion).ok, true);
  // wrong challenge (different escrow/amount) must fail
  const other = captureTokenBytes(buildCaptureToken("0x" + "cd".repeat(32), ckbToShannonsHex(3)));
  assert.equal(verifyPasskeyAssertion(other, assertion).ok, false);
  // tampered signature must fail
  const bad = { ...assertion, signature: "0x" + "00".repeat(64) };
  assert.equal(verifyPasskeyAssertion(challenge, bad).ok, false);
});

test("PasskeyAuthorizer gates a live capture via EscrowManager + MockFiberClient", async () => {
  const priv = p256.utils.randomPrivateKey();
  const pubkey = hex(p256.getPublicKey(priv, false).slice(1));
  const client = new MockFiberClient();
  const store = new MemoryStore();
  const mgr = new EscrowManager(client, store, { authorizer: new PasskeyAuthorizer(pubkey) });

  const e = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt" });
  await client.sendPayment({ invoice: e.invoiceAddress });
  await mgr.refresh(e.id);

  // gateway builds the token, device signs it, gateway captures
  const tok = buildCaptureToken(e.paymentHash, e.amount);
  const assertion = simulateAssertion(captureTokenBytes(tok), priv);
  const captured = await mgr.capture(e.id, { assertion, nonce: tok.nonce });
  assert.equal(captured.state, "Captured");

  // a wrong-key assertion is rejected
  const e2 = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt" });
  await client.sendPayment({ invoice: e2.invoiceAddress });
  await mgr.refresh(e2.id);
  const tok2 = buildCaptureToken(e2.paymentHash, e2.amount);
  const wrong = simulateAssertion(captureTokenBytes(tok2), p256.utils.randomPrivateKey());
  await assert.rejects(() => mgr.capture(e2.id, { assertion: wrong, nonce: tok2.nonce }));
});

test("MofNAuthorizer gates a live capture (2-of-3)", async () => {
  const signers = PRIVS.map((p) => ({ pubkey: operatorPubkey(p) }));
  const client = new MockFiberClient();
  const mgr = new EscrowManager(client, new MemoryStore(), {
    authorizer: new MofNAuthorizer({ signers, threshold: 2 }),
  });
  const e = await mgr.authorize({ amount: ckbToShannonsHex(1), currency: "Fibt" });
  await client.sendPayment({ invoice: e.invoiceAddress });
  await mgr.refresh(e.id);

  const tok = buildCaptureToken(e.paymentHash, e.amount);
  const msg = captureTokenBytes(tok);
  const signatures = [
    { index: 0, signature: signCaptureMofN(msg, PRIVS[0]) },
    { index: 2, signature: signCaptureMofN(msg, PRIVS[2]) },
  ];
  const captured = await mgr.capture(e.id, { signatures, nonce: tok.nonce });
  assert.equal(captured.state, "Captured");
});
