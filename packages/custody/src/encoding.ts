// Byte encoders for the custody lock (Config Cell + witness layouts), ported from ckb-smart-account, kept byte-compatible.
import { blake2b } from "@noble/hashes/blake2b";
import { p256 } from "@noble/curves/p256";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

const CKB_HASH_PERSONAL = new TextEncoder().encode("ckb-default-hash"); // 16 bytes

export const u8 = (n: number): Uint8Array => Uint8Array.of(n & 0xff);
export const u16be = (n: number): Uint8Array => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
export const u64be = (n: bigint | number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
};
export const u64le = (n: bigint | number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
export const cat = (parts: Uint8Array[]): Uint8Array => concatBytes(...parts);
export const toHex = (b: Uint8Array): `0x${string}` => `0x${bytesToHex(b)}`;
export const fromHex = (h: string): Uint8Array => hexToBytes(h.startsWith("0x") ? h.slice(2) : h);

/** blake2b-256 with CKB's "ckb-default-hash" personalization, over the concatenation of parts. */
export const blake2bCkb = (...parts: Uint8Array[]): Uint8Array =>
  blake2b(concatBytes(...parts), { dkLen: 32, personalization: CKB_HASH_PERSONAL });

// Config Cell + witness layouts, ported from ckb-smart-account

export interface AuthRecord {
  /** ckb-auth algo id: 0 = secp256k1, 17 = P-256 (auth_libecc), 0xFE = WebAuthn (lock-native). */
  algoId: number;
  /** blake160(pubkey) or eth address, 20 bytes. */
  authHash: Uint8Array;
  /** per-tx outflow cap in shannons; 0 = unlimited. */
  perTxCap?: bigint;
  /** data hash of the ckb-auth library validating this authenticator, 32 bytes. */
  authCodeHash: Uint8Array;
}

/** 61-byte v2 auth record: algo_id || auth_hash(20) || per_tx_cap(8 BE) || auth_code_hash(32). */
export const encodeAuth = (a: AuthRecord): Uint8Array =>
  cat([u8(a.algoId), a.authHash, u64be(a.perTxCap ?? 0n), a.authCodeHash]);

const region = (auths: AuthRecord[]): Uint8Array => cat([u8(auths.length), ...auths.map(encodeAuth)]);

export interface ConfigParams {
  version?: number;
  spendThreshold?: number;
  recoveryThreshold: number;
  recoveryDelay: bigint;
  pendingRoot?: Uint8Array | null;
  authenticators: AuthRecord[];
  guardians: AuthRecord[];
}

export const encodeConfig = (c: ConfigParams): Uint8Array =>
  cat([
    u8(c.version ?? 1),
    u8(c.spendThreshold ?? 1),
    u8(c.recoveryThreshold),
    u64be(c.recoveryDelay),
    c.pendingRoot ? cat([u8(1), c.pendingRoot]) : cat([u8(0), new Uint8Array(32)]),
    region(c.authenticators),
    region(c.guardians),
  ]);

export interface IndexedSig {
  index: number;
  signature: Uint8Array;
}

/** Recovery/multispend witness: mode || n || [index(1) || sig_len(2 BE) || sig]*. Mode 5 = MultiSpend. */
export const encodeRecoverWitness = (mode: number, sigs: IndexedSig[]): Uint8Array =>
  cat([u8(mode), u8(sigs.length), ...sigs.flatMap((s) => [u8(s.index), u16be(s.signature.length), s.signature])]);

/** Single-sig spend witness (mode 0): mode || auth_index || sig_len(2 BE) || sig. */
export const encodeSpendWitness = (authIndex: number, sig: Uint8Array): Uint8Array =>
  cat([u8(0), u8(authIndex), u16be(sig.length), sig]);

// P-256 (ckb-auth algo 17)

/** P-256 public key (64-byte x||y) and its 20-byte blake160 auth hash. */
export function r1PubkeyAndHash(privHex: string): { pub64: Uint8Array; hash: Uint8Array } {
  const pub = p256.getPublicKey(fromHex(privHex), false); // 65 bytes: 0x04 || x || y
  const pub64 = pub.slice(1, 65);
  return { pub64, hash: blake2bCkb(pub64).slice(0, 20) };
}

/** P-256 witness signature field: pubkey(64) || sig(64). The sighash is signed as the digest. */
export function r1SigField(privHex: string, msg32: Uint8Array): Uint8Array {
  const sig = p256.sign(msg32, fromHex(privHex)); // low-S, no prehash
  return cat([r1PubkeyAndHash(privHex).pub64, sig.toCompactRawBytes()]);
}

// WebAuthn (ckb-auth algo 0xFE), for passkey-governed custody
export const ALGO_WEBAUTHN = 0xfe;
const b64url = (b: Uint8Array): string => {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Frame a WebAuthn assertion over `sighash` as the witness blob the lock expects:
 *   authData_len(2) || authData || cd_len(2) || clientDataJSON || pubkey(64) || sig(64).
 * (sha256 is used here because that is what WebAuthn/authenticators sign.)
 */
export async function webauthnSigField(privHex: string, sighash: Uint8Array): Promise<Uint8Array> {
  const { sha256 } = await import("@noble/hashes/sha256");
  const { pub64 } = r1PubkeyAndHash(privHex);
  const authData = new Uint8Array(37); // rpIdHash(32) || flags(1) || counter(4)
  authData[32] = 0x05; // UserPresent | UserVerified
  const clientData = new TextEncoder().encode(
    `{"type":"webauthn.get","challenge":"${b64url(sighash)}","origin":"https://trickle"}`,
  );
  const digest = sha256(cat([authData, sha256(clientData)]));
  const sig64 = p256.sign(digest, fromHex(privHex)).toCompactRawBytes();
  return cat([u16be(authData.length), authData, u16be(clientData.length), clientData, pub64, sig64]);
}
