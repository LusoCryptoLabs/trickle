import test from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/p256";
import { concatBytes } from "@noble/hashes/utils";
import {
  blake2bCkb,
  custodyLock,
  encodeAuth,
  encodeConfig,
  encodeRecoverWitness,
  fromHex,
  r1PubkeyAndHash,
  r1SigField,
  toHex,
  PUDGE_CUSTODY,
} from "../src/index.js";

test("blake2bCkb matches CKB's ckb-default-hash (empty input vector)", () => {
  // The well-known CKB blake2b-256 of empty input. If the personalization were wrong, this fails.
  assert.equal(toHex(blake2bCkb(new Uint8Array(0))), "0x44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e");
});

test("auth record is 61 bytes; config and witness layouts have the expected sizes", () => {
  const auth = { algoId: 17, authHash: new Uint8Array(20), perTxCap: 0n, authCodeHash: new Uint8Array(32) };
  assert.equal(encodeAuth(auth).length, 61);

  // header 44 = version1+spend1+rec1+delay8 + pendingFlag1+root32; +region(3)=1+3*61; +region(1)=1+61
  const cfg = encodeConfig({ spendThreshold: 2, recoveryThreshold: 1, recoveryDelay: 100n, authenticators: [auth, auth, auth], guardians: [auth] });
  assert.equal(cfg.length, 44 + (1 + 3 * 61) + (1 + 61));

  // mode(1)+n(1) + 2 * (index1+len2+sig128)
  const w = encodeRecoverWitness(5, [{ index: 0, signature: new Uint8Array(128) }, { index: 1, signature: new Uint8Array(128) }]);
  assert.equal(w.length, 2 + 2 * (1 + 2 + 128));
  assert.equal(w[0], 5);
  assert.equal(w[1], 2);
});

test("P-256 auth hash is 20 bytes and r1SigField is a verifiable pubkey||sig", () => {
  const priv = "0x" + "07".repeat(32);
  const { pub64, hash } = r1PubkeyAndHash(priv);
  assert.equal(pub64.length, 64);
  assert.equal(hash.length, 20);

  const msg = blake2bCkb(new TextEncoder().encode("a capture sighash"));
  const field = r1SigField(priv, msg);
  assert.equal(field.length, 128);
  const sig = field.slice(64);
  const pubUncompressed = concatBytes(Uint8Array.of(0x04), field.slice(0, 64));
  assert.equal(p256.verify(sig, msg, pubUncompressed), true);
  // a different message must not verify
  assert.equal(p256.verify(sig, blake2bCkb(new TextEncoder().encode("other")), pubUncompressed), false);
});

test("custodyLock builds the deployed v5 lock for an account id", () => {
  const lock = custodyLock("0x" + "11".repeat(32));
  assert.equal(lock.codeHash, PUDGE_CUSTODY.lock.codeHash);
  assert.equal(lock.hashType, "type");
  assert.equal(lock.args, "0x" + "11".repeat(32));
});
