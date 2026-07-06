// Smoke test for the Trickle browser path: drives the whole gateway with a software P-256 key
// (the same assertion shape Windows Hello produces). Proves everything except the physical tap.
// Run the server, then: tsx scripts/stream-smoke.ts
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const BASE = process.env.BASE ?? "http://localhost:8099";
const hex = (b: Uint8Array) => "0x" + bytesToHex(b);
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const get = async (p: string) => (await fetch(BASE + p)).json();
const post = async (p: string, body?: unknown) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

function simulateAssertion(challengeHex: string, priv: Uint8Array, pub64: Uint8Array) {
  const challenge = hexToBytes(challengeHex.replace(/^0x/, ""));
  const clientData = utf8ToBytes(JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin: "http://localhost:8099" }));
  const authData = concatBytes(sha256(utf8ToBytes("localhost")), Uint8Array.of(0x05), new Uint8Array(4));
  const digest = sha256(concatBytes(authData, sha256(clientData)));
  const sig = p256.sign(digest, priv, { lowS: false });
  return { authenticatorData: hex(authData), clientDataJSON: hex(clientData), signature: hex(sig.toCompactRawBytes()), pubkey: hex(pub64) };
}

async function main() {
  const h = await get("/api/health");
  if (!h.ok) throw new Error("merchant node unreachable; start the fnn nodes");

  const priv = p256.utils.randomPrivateKey();
  const pub64 = p256.getPublicKey(priv, false).slice(1);
  await post("/api/passkey", { pubkey: hex(pub64) });

  const start = await (await post("/api/stream/start", { budgetCkb: 0.5 })).json();
  console.log(`grant: ${start.budgetCkb} CKB at ${start.pricePerSec} CKB/s for a ${start.videoSeconds}s video`);
  const auth = await post(`/api/stream/${start.id}/authorize`, { assertion: simulateAssertion(start.digest, priv, pub64) });
  if (!auth.ok) throw new Error("authorize failed: " + JSON.stringify(await auth.json()));
  console.log("authorize: 200 (budget signed by passkey)");

  // pull one second at a time until the budget cap freezes the stream
  let released = 0, capped = false;
  for (let i = 0; i < 400 && !capped; i++) {
    const r = await (await post(`/api/stream/${start.id}/tick`)).json();
    if (r.ok) { released = r.releasedSeconds; process.stdout.write(`\r  paid ${released}s, spent ${r.spentCkb.toFixed(2)}/${start.budgetCkb} CKB   `); }
    else if (r.capped) capped = true;
    else if (r.retry) await new Promise((res) => setTimeout(res, 50));
  }
  if (!capped) throw new Error("budget never capped");
  console.log(`\ncap held at ${released}s (${(released * start.pricePerSec).toFixed(2)} CKB)`);

  // a fresh passkey tap raises the cap and playback can resume from the same frame
  // (re-pin our key in case another tab on this localhost server clobbered the single demo passkey)
  await post("/api/passkey", { pubkey: hex(pub64) });
  const ts = await (await post(`/api/stream/${start.id}/topup-start`, { addCkb: 0.5 })).json();
  const tr = await post(`/api/stream/${start.id}/topup`, { assertion: simulateAssertion(ts.digest, priv, pub64) });
  if (!tr.ok) throw new Error("top-up failed: " + JSON.stringify(await tr.json()));
  console.log(`top-up: cap raised to ${(await tr.json()).budgetCkb} CKB`);

  const more = await (await post(`/api/stream/${start.id}/tick`)).json();
  if (!more.ok) throw new Error("tick after top-up still capped");
  console.log(`resumed: paid ${more.releasedSeconds}s after top-up`);
  console.log("STREAM SMOKE OK: per-second billing, budget cap held, passkey top-up resumed playback.");
}
main().catch((e) => { console.error("\n", e); process.exit(1); });
