// Gateway server for the live browser demo. It holds the Trickle EscrowManager wired to two real
// fnn nodes, pins a device passkey as the authorized capturer, and exposes a tiny JSON API the page
// calls. The capture is gated by verifying the WebAuthn assertion here (application layer), then
// settle_invoice runs on the node. Serve on localhost so WebAuthn treats it as a secure context.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  EscrowManager,
  FiberClient,
  MockFiberClient,
  MemoryStore,
  ckbToShannonsHex,
  type CaptureAuthorizer,
  type Escrow,
  type IFiberClient,
} from "@trickle/core";
import { PasskeyAuthorizer, buildCaptureToken } from "@trickle/auth";
import { AllowanceSession, grantDigestHex, verifyGrant, type Grant } from "@trickle/stream";

const MERCHANT_RPC = process.env.MERCHANT_RPC ?? "http://127.0.0.1:8237";
const BUYER_RPC = process.env.BUYER_RPC ?? "http://127.0.0.1:8227";
const PORT = Number(process.env.PORT ?? 8099);
const ORDER_CKB = Number(process.env.ORDER_CKB ?? 1);
// TRICKLE_DEMO=1 drives everything from an in-memory Fiber mock (one shared node), so the hero
// stream, the studio, and the ~60s video all run with no live fnn nodes. The passkey tap is
// unchanged; only the settlement is mocked. A synthetic channel readout keeps the connectivity /
// balance panel populated.
const DEMO = process.env.TRICKLE_DEMO === "1" || process.env.DEMO === "1";
const DEMO_PAYER_CKB = 200;
const DEMO_PROVIDER_CKB = 100;

const here = dirname(fileURLToPath(import.meta.url));
// pages cached at boot: / is the Trickle stream, /escrow is the demoted sibling
const pub = (f: string) => readFileSync(join(here, "..", "public", f));
const streamHtml = pub("stream.html");
const escrowHtml = pub("index.html");
const studioHtml = pub("studio.html");

// In demo mode merchant and buyer share ONE mock node so both the keysend stream and the escrow
// sibling resolve against the same in-memory invoice/payment state.
const mock = DEMO ? new MockFiberClient() : null;
const merchant: IFiberClient = mock ?? new FiberClient(MERCHANT_RPC);
const buyer: IFiberClient = mock ?? new FiberClient(BUYER_RPC);
const store = new MemoryStore();

// The pinned passkey is set at runtime when the browser registers. The authorizer reads it live.
let authorizedPubkey: string | null = null;
const authorizer: CaptureAuthorizer = {
  authorize(escrow: Escrow, proof: unknown) {
    if (!authorizedPubkey) return Promise.resolve(false);
    return new PasskeyAuthorizer(authorizedPubkey).authorize(escrow, proof);
  },
};
const mgr = new EscrowManager(merchant, store, { authorizer });

// Trickle: a passkey authorizes a budget once, then the player pays for each second of video it is
// about to watch with one keysend tick. Nothing held; the cap freezes playback; a fresh passkey tap
// raises the cap and resumes from the same frame.
// streamer-configurable stream settings, set live from the /studio dashboard
const config = {
  title: process.env.STREAM_TITLE ?? "Trickle live stream",
  pricePerSec: Number(process.env.PRICE_PER_SEC ?? 0.04), // CKB paid per second of video watched
  videoSeconds: Number(process.env.VIDEO_SECONDS ?? 60),
  suggestedBudgetCkb: Number(process.env.SUGGESTED_BUDGET ?? 2),
  // when a viewer is charged again for a second they already paid for:
  //   forever   = pay once, rewatch free
  //   per_watch = charged every play, even rewatches
  //   cooldown  = paid access lasts cooldownSeconds, then re-charges
  rechargePolicy: process.env.RECHARGE_POLICY ?? "forever",
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS ?? 20),
};
const POLICIES = ["forever", "per_watch", "cooldown"];
const ckbHex = (c: number) => "0x" + Math.round(c * 1e8).toString(16);
let providerPubkey: string | null = null;
interface StreamRec {
  grant: Grant; budgetCkb: number;
  session: AllowanceSession | null;
  authorizedPubkey: string | null; // pinned at authorize, so a later global re-pin cannot break this session's top-up
  spentCkb: number; releasedSeconds: number; capped: boolean; live: boolean;
  pending: Grant | null; pendingBudgetCkb: number;
}
const streams = new Map<string, StreamRec>();

async function getProviderPubkey(): Promise<string> {
  if (!providerPubkey) providerPubkey = (await merchant.getNodeInfo()).pubkey;
  return providerPubkey;
}
async function listChannels(rpc: string): Promise<any[]> {
  const r = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "list_channels", params: [{}] }),
  });
  const d = (await r.json()) as any;
  return d?.result?.channels ?? [];
}

// tiny http helpers
function send(res: ServerResponse, code: number, body: unknown, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : (body as string | Buffer);
  res.writeHead(code, { "content-type": type });
  res.end(data);
}
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const view = (e: Escrow) => ({ id: e.id, state: e.state, amount: e.amount, invoiceAddress: e.invoiceAddress });

// Real on-chain proof surfaced to the demo page. The streaming settlement here may be mocked, but the
// Stage B custody run below is real and judge-verifiable on Pudge. Read-only, no keys.
const CKB_RPC = process.env.CKB_RPC ?? "https://testnet.ckb.dev/rpc";
const EXPLORER = "https://pudge.explorer.nervos.org/transaction/";
const REPO_URL = process.env.REPO_URL ?? "https://github.com/LusoCryptoLabs/trickle";
const VIDEO_URL = process.env.VIDEO_URL ?? "";
const PROOF_BOOTSTRAP_TX = "0xbd12f381931dc665d64634876309ecc629f3491e8073868f63fb3ed4acd49b3c";
const PROOF = {
  network: "Pudge testnet",
  lockCodeHash: "0x0dc8c2151bea1694af93dc241b6b6597b558bfa36cc624a4a7212f8e993da30e",
  txs: [
    { label: "Bootstrap 2-of-3 P-256 custody account", tx: PROOF_BOOTSTRAP_TX, note: null },
    { label: "Sweep 300 CKB into custody", tx: "0x5e2af2017c277d8e979fd484d4d5e73e6fd7bf5aeb4c0e4ff5a872fdaa1f567d", note: null },
    { label: "1-of-3 withdraw below quorum", tx: null, note: "rejected on-chain" },
    { label: "2-of-3 withdraw (operators 0 + 2)", tx: "0x1ec0ba4293077f772888837bb770d8ce7b1547acf9ee023be3166ffb9056696b", note: null },
  ],
};
// cache the committed status once seen; a committed tx does not un-commit, so we never need to re-ask
let proofLive: { status: string; blockHash: string | null } | null = null;
async function fetchProofLive() {
  if (proofLive) return proofLive;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(CKB_RPC, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_transaction", params: [PROOF_BOOTSTRAP_TX] }),
    });
    const d = (await r.json()) as any;
    const ts = d?.result?.tx_status;
    if (ts?.status) {
      const live = { status: ts.status as string, blockHash: (ts.block_hash as string) ?? null };
      if (ts.status === "committed") proofLive = live;
      return live;
    }
  } catch { /* rpc slow or unreachable; the page still shows the static explorer links */ }
  finally { clearTimeout(timer); }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const p = url.pathname;
    const m = req.method ?? "GET";

    if (m === "GET" && (p === "/" || p === "/stream")) return send(res, 200, streamHtml, "text/html; charset=utf-8");
    if (m === "GET" && p === "/escrow") return send(res, 200, escrowHtml, "text/html; charset=utf-8");
    if (m === "GET" && p === "/studio") return send(res, 200, studioHtml, "text/html; charset=utf-8");

    if (m === "GET" && p === "/api/health") {
      const info = await merchant.getNodeInfo().catch(() => null);
      return send(res, 200, {
        ok: !!info,
        version: info?.version ?? null,
        chain: info?.chain_hash?.slice(0, 14) ?? null,
        passkeyRegistered: !!authorizedPubkey,
        orderCkb: ORDER_CKB,
        demo: DEMO,
        repoUrl: REPO_URL,
        videoUrl: VIDEO_URL || null,
      });
    }

    // live, read-only on-chain proof for the demo page: the real Stage B custody run on Pudge
    if (m === "GET" && p === "/api/proof") {
      const live = await fetchProofLive();
      return send(res, 200, { ...PROOF, explorer: EXPLORER, repoUrl: REPO_URL, videoUrl: VIDEO_URL || null, live });
    }

    // register the device passkey as the authorized capturer
    if (m === "POST" && p === "/api/passkey") {
      const { pubkey } = await readJson(req);
      if (!pubkey) return send(res, 400, { error: "missing pubkey" });
      authorizedPubkey = pubkey;
      return send(res, 200, { ok: true });
    }

    // new pay-on-delivery order: create a hold invoice and have the buyer node pay it
    if (m === "POST" && p === "/api/order") {
      const e = await mgr.authorize({ amount: ckbToShannonsHex(ORDER_CKB), currency: "Fibt", description: "web-demo order", expirySeconds: 3600 });
      buyer.sendPayment({ invoice: e.invoiceAddress }).catch(() => {}); // fire and forget; page polls to HELD
      return send(res, 200, view(e));
    }

    const orderMatch = p.match(/^\/api\/order\/(0x[0-9a-fA-F]+)(\/[a-z]+)?$/);
    if (orderMatch) {
      const id = orderMatch[1];
      const sub = orderMatch[2];

      if (m === "GET" && !sub) {
        const e = await mgr.refresh(id);
        return send(res, 200, view(e));
      }
      // the 32-byte capture token the passkey must sign (sent to the browser as the WebAuthn challenge)
      if (m === "GET" && sub === "/challenge") {
        const e = await mgr.get(id);
        const t = buildCaptureToken(e.paymentHash, e.amount);
        return send(res, 200, { token: t.token, nonce: t.nonce });
      }
      if (m === "POST" && sub === "/capture") {
        const { assertion, nonce } = await readJson(req);
        try {
          const e = await mgr.capture(id, { assertion, nonce });
          return send(res, 200, view(e));
        } catch (err) {
          return send(res, 403, { error: String((err as Error).message) });
        }
      }
      if (m === "POST" && sub === "/refund") {
        const e = await mgr.refund(id);
        return send(res, 200, view(e));
      }
    }

    // build a grant for a budget; returns the digest the passkey must sign as the WebAuthn challenge
    if (m === "POST" && p === "/api/stream/start") {
      const { budgetCkb } = await readJson(req);
      const budget = Math.max(0.2, Number(budgetCkb) || 2);
      const id = "s" + Math.floor(Date.now()).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      const grant: Grant = {
        payee: await getProviderPubkey(),
        asset: "CKB",
        maxTotal: ckbHex(budget),
        maxRate: ckbHex(4),
        sessionId: id,
        nonce: "0x" + Math.floor(Math.random() * 1e15).toString(16),
        expiry: Math.floor(Date.now() / 1000) + 3600,
      };
      streams.set(id, { grant, budgetCkb: budget, session: null, authorizedPubkey: null, spentCkb: 0, releasedSeconds: 0, capped: false, live: false, pending: null, pendingBudgetCkb: 0 });
      return send(res, 200, { id, digest: grantDigestHex(grant), budgetCkb: budget, pricePerSec: config.pricePerSec, videoSeconds: config.videoSeconds });
    }

    // node connectivity, the payer's spendable channel balance, and the full-video cost at the rate
    if (m === "GET" && p === "/api/stream/info") {
      const bi = await buyer.getNodeInfo().catch(() => null);
      const pi = await merchant.getNodeInfo().catch(() => null);
      let channel: Record<string, unknown> = { exists: false };
      if (DEMO) {
        // synthetic channel: shows connectivity, capacity, and a balance that drains as ticks settle
        const spent = [...streams.values()].reduce((s, r) => s + r.spentCkb, 0);
        channel = {
          exists: true, ready: true, state: "CHANNEL_READY (demo)",
          payerBalanceCkb: Number(Math.max(0, DEMO_PAYER_CKB - spent).toFixed(8)),
          providerBalanceCkb: Number((DEMO_PROVIDER_CKB + spent).toFixed(8)),
          capacityCkb: DEMO_PAYER_CKB + DEMO_PROVIDER_CKB,
        };
      } else {
        try {
          const chans = await listChannels(BUYER_RPC);
          const providerPk = pi?.pubkey;
          const ch = chans.find((c: any) => providerPk && c.pubkey === providerPk) ?? chans[0];
          if (ch) {
            const local = Number(BigInt(ch.local_balance ?? "0x0"));
            const remote = Number(BigInt(ch.remote_balance ?? "0x0"));
            const stateName = typeof ch.state === "string" ? ch.state : (ch.state?.state_name ?? JSON.stringify(ch.state));
            channel = {
              exists: true,
              ready: /READY/i.test(String(stateName)),
              state: stateName,
              payerBalanceCkb: local / 1e8,
              providerBalanceCkb: remote / 1e8,
              capacityCkb: (local + remote) / 1e8,
            };
          }
        } catch { /* channel read failed; report exists:false */ }
      }
      return send(res, 200, {
        buyer: { ok: !!bi, version: bi?.version ?? null },
        provider: { ok: !!pi, version: pi?.version ?? null },
        channel,
        title: config.title,
        pricePerSec: config.pricePerSec,
        videoSeconds: config.videoSeconds,
        suggestedBudgetCkb: config.suggestedBudgetCkb,
        rechargePolicy: config.rechargePolicy,
        cooldownSeconds: config.cooldownSeconds,
        fullVideoCostCkb: Number((config.pricePerSec * config.videoSeconds).toFixed(8)),
      });
    }

    // streamer dashboard: read and write the live stream settings
    if (m === "GET" && p === "/api/config") {
      return send(res, 200, { ...config, fullVideoCostCkb: Number((config.pricePerSec * config.videoSeconds).toFixed(8)) });
    }
    if (m === "POST" && p === "/api/config") {
      const b = await readJson(req);
      if (typeof b.title === "string") config.title = b.title.slice(0, 80);
      if (Number.isFinite(Number(b.pricePerSec))) config.pricePerSec = Math.min(4, Math.max(0.0001, Number(b.pricePerSec)));
      if (Number.isFinite(Number(b.videoSeconds))) config.videoSeconds = Math.min(3600, Math.max(5, Math.round(Number(b.videoSeconds))));
      if (Number.isFinite(Number(b.suggestedBudgetCkb))) config.suggestedBudgetCkb = Math.min(1000, Math.max(0.2, Number(b.suggestedBudgetCkb)));
      if (typeof b.rechargePolicy === "string" && POLICIES.includes(b.rechargePolicy)) config.rechargePolicy = b.rechargePolicy;
      if (Number.isFinite(Number(b.cooldownSeconds))) config.cooldownSeconds = Math.min(60 * 60 * 24 * 90, Math.max(1, Math.round(Number(b.cooldownSeconds))));
      return send(res, 200, { ...config, fullVideoCostCkb: Number((config.pricePerSec * config.videoSeconds).toFixed(8)) });
    }

    // streamer dashboard: live viewers and earnings across active sessions
    if (m === "GET" && p === "/api/streams") {
      const list = [...streams.entries()].map(([id, r]) => ({
        id, budgetCkb: r.budgetCkb, spentCkb: r.spentCkb, releasedSeconds: r.releasedSeconds,
        capped: r.capped, live: r.live, done: r.releasedSeconds >= config.videoSeconds,
      }));
      const totalEarnedCkb = Number(list.reduce((s, r) => s + r.spentCkb, 0).toFixed(8));
      const activeCount = list.filter((r) => r.live && !r.capped && !r.done).length;
      return send(res, 200, { streams: list.reverse(), totalEarnedCkb, activeCount, count: list.length });
    }


    const streamMatch = p.match(/^\/api\/stream\/(s[a-z0-9]+)(\/[a-z-]+)?$/);
    if (streamMatch) {
      const id = streamMatch[1];
      const sub = streamMatch[2];
      const rec = streams.get(id);
      if (!rec) return send(res, 404, { error: "unknown stream" });

      // the passkey signs the grant digest once; this opens the session, nothing streams yet
      if (m === "POST" && sub === "/authorize") {
        const { assertion } = await readJson(req);
        if (!authorizedPubkey) return send(res, 400, { error: "register a passkey first" });
        const v = verifyGrant({ grant: rec.grant, passkey: { assertion } }, { passkeyPubkey: authorizedPubkey });
        if (!v.ok) return send(res, 403, { error: v.reason ?? "grant authorization failed" });
        rec.session = new AllowanceSession(buyer, rec.grant);
        rec.authorizedPubkey = authorizedPubkey; // pin this session to the key that authorized it
        rec.live = true;
        return send(res, 200, { ok: true });
      }

      // pull-based: pay for exactly one second of video, settled before the player advances onto it
      if (m === "POST" && sub === "/tick") {
        if (!rec.session) return send(res, 400, { error: "authorize the budget first" });
        try {
          await rec.session.tick(ckbHex(config.pricePerSec));
          rec.spentCkb = Number(rec.session.spent()) / 1e8;
          rec.releasedSeconds = rec.session.ticks();
          return send(res, 200, { ok: true, releasedSeconds: rec.releasedSeconds, spentCkb: rec.spentCkb, capped: false });
        } catch (err) {
          const name = (err as Error).name;
          if (name === "BudgetExceededError") { rec.capped = true; return send(res, 200, { ok: false, capped: true, releasedSeconds: rec.releasedSeconds, spentCkb: rec.spentCkb }); }
          if (name === "RateExceededError") return send(res, 200, { ok: false, retry: true, releasedSeconds: rec.releasedSeconds, spentCkb: rec.spentCkb });
          return send(res, 502, { error: String((err as Error).message) });
        }
      }

      // raise the cap: build a fresh grant for the bigger budget; returns the new digest to tap
      if (m === "POST" && sub === "/topup-start") {
        const { addCkb } = await readJson(req);
        const add = Math.max(0.1, Number(addCkb) || 1);
        const newBudget = rec.budgetCkb + add;
        // a top-up is a freshly signed superseding grant: bigger cap, new nonce, and a refreshed clock
        const pending: Grant = {
          ...rec.grant,
          maxTotal: ckbHex(newBudget),
          nonce: "0x" + Math.floor(Math.random() * 1e15).toString(16),
          expiry: Math.floor(Date.now() / 1000) + 3600,
        };
        rec.pending = pending; rec.pendingBudgetCkb = newBudget;
        return send(res, 200, { digest: grantDigestHex(pending), newBudgetCkb: newBudget });
      }

      // a fresh passkey tap over the bigger grant raises the live cap and unfreezes playback
      if (m === "POST" && sub === "/topup") {
        const { assertion } = await readJson(req);
        if (!rec.pending) return send(res, 400, { error: "start a top-up first" });
        if (!rec.authorizedPubkey) return send(res, 400, { error: "authorize the budget first" });
        const v = verifyGrant({ grant: rec.pending, passkey: { assertion } }, { passkeyPubkey: rec.authorizedPubkey });
        if (!v.ok) return send(res, 403, { error: v.reason ?? "top-up authorization failed" });
        // re-point the live session at the whole re-signed grant so cap, nonce, and expiry all match the signature
        rec.grant.maxTotal = rec.pending.maxTotal;
        rec.grant.nonce = rec.pending.nonce;
        rec.grant.expiry = rec.pending.expiry;
        rec.budgetCkb = rec.pendingBudgetCkb; rec.capped = false; rec.pending = null;
        return send(res, 200, { ok: true, budgetCkb: rec.budgetCkb });
      }

      if (m === "GET" && !sub) {
        return send(res, 200, { budgetCkb: rec.budgetCkb, pricePerSec: config.pricePerSec, videoSeconds: config.videoSeconds, spentCkb: rec.spentCkb, releasedSeconds: rec.releasedSeconds, capped: rec.capped, live: rec.live });
      }
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String((err as Error).message) });
  }
});

server.listen(PORT, () => {
  console.log(`Trickle web demo on http://localhost:${PORT}`);
  if (DEMO) {
    console.log(`  DEMO mode: in-memory Fiber mock, no live nodes needed (settlement is mocked)`);
  } else {
    console.log(`  merchant ${MERCHANT_RPC}  buyer ${BUYER_RPC}  order ${ORDER_CKB} CKB`);
  }
  console.log(`  open the URL in Chrome/Edge on this machine; set a budget and tap the passkey to stream.`);
});
