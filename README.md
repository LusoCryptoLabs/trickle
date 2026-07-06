# Trickle

Authorize a spending budget once with a passkey, then stream tiny payments on CKB Fiber that settle every tick and stop at a hard cap. Nothing is held.

Trickle is a streaming-allowance library for the [CKB Fiber Network](https://github.com/nervosnetwork/fiber). You approve a budget one time, with a passkey or an M-of-N quorum, and after that an app streams keysend micropayments under it. Each tick settles in milliseconds, nothing sits in a hold, and the stream stops when it reaches the cap. It is built for metering: pay-per-token AI, paid APIs, bandwidth, subscriptions, and machine-to-machine payments.

It ships as small libraries and adapters, not a hosted service. Pinned to Fiber node v0.8.1.

Live demo: https://trickle.lusocryptolabs.com

## How it works

Fiber pays in milliseconds, but two things get in the way of real per-unit billing. You cannot hold a payment for every unit, because the HTLC ties up liquidity and expires. And you cannot ask a person to approve every micropayment. Trickle turns both into the design: approve the budget once, settle every tick, never hold.

- **Grant.** A signed off-chain object `{payee, asset, maxTotal, maxRate, sessionId, nonce, expiry}`. Its digest is signed by a passkey (WebAuthn) or an M-of-N quorum. No cell, no on-chain state, just a signature in the payer's app.
- **Tick.** Each tick is a keysend `send_payment`. fnn settles it in milliseconds and holds nothing, so the expiry and force-close risk that kills long holds never comes up.
- **Cap.** The session refuses any tick that would go past `maxTotal` or `maxRate`, locally, before it reaches the node.
- **Meter.** The receiver has no view of an incoming keysend, so the provider meters on settled inbound value (its channel balance delta) and releases service against value that has actually landed.

## Quickstart

```ts
import { signGrantMofN, AllowanceSession, type Grant } from "@trickle/stream";

// approve a budget once (here a 2-of-3 quorum; a passkey assertion works the same way)
const grant: Grant = {
  payee: providerPubkey, asset: "CKB",
  maxTotal: "0x" + (2n * 10n ** 8n).toString(16), // 2 CKB cap
  maxRate: "0x" + (1n * 10n ** 8n).toString(16),   // 1 CKB/s
  sessionId: "demo", nonce: "0x01", expiry: Math.floor(Date.now() / 1000) + 3600,
};
signGrantMofN(grant, [{ index: 0, priv }, { index: 1, priv }]);

// then stream under it: each tick is a settled keysend, and the cap stops it
const session = new AllowanceSession(buyerClient, grant);
await session.stream("0x" + (4n * 10n ** 6n).toString(16), {
  onTick: (r) => console.log(`tick ${r.cursor}, fee ${r.fee}`),
});
```

## Packages

| Package | What it does |
| --- | --- |
| `@trickle/stream` | the streaming allowance: the budget grant, the capped tick stream, and the settled-value meter |
| `@trickle/auth` | passkey (WebAuthn) and M-of-N, bound to a grant digest or a capture token |
| `@trickle/core` | the hold-invoice escrow state machine, watcher, store, Fiber RPC client, and a mock |
| `@trickle/custody` | the on-chain M-of-N / WebAuthn custody cell for captured funds, live on Pudge |
| `adapters/fiber-pay`, `adapters/fnn-pay` | drop these primitives into existing Fiber checkout tools |

## Run it

Needs Node 20 or newer and pnpm.

```
pnpm install
pnpm -r --filter "./packages/*" build
pnpm test
```

Browser demo, no nodes needed (an in-memory Fiber mock):

```
TRICKLE_DEMO=1 pnpm -C examples/web-demo dev
```

Open http://localhost:8099 in Chrome or Edge. Register a passkey, set a budget, and click play. A video pays for each second as it plays, freezes at the budget, and one more tap adds more and resumes from the same frame. Run the same command without `TRICKLE_DEMO=1` to drive two real fnn v0.8.1 nodes (a payer on `127.0.0.1:8227` and a provider on `127.0.0.1:8237`), or run the terminal version:

```
pnpm -C packages/stream exec tsx scripts/stream-live.ts
```

### Bring your own nodes

None of this depends on our nodes, and you do not need the hosted demo to check the claim. Stand up two of your own and reproduce the run:

1. Get two fnn v0.8.1 nodes from the [Fiber releases](https://github.com/nervosnetwork/fiber/releases/tag/v0.8.1). Start one on RPC 8227 with p2p 8228 (the payer) and one on RPC 8237 with p2p 8238 (the provider), each from the bundled testnet config, with `FIBER_SECRET_KEY_PASSWORD` set so the node encrypts its key.
2. Fund each node's address with Pudge testnet CKB from the [faucet](https://faucet.nervos.org/). A few hundred CKB is enough.
3. Connect the payer to the provider and open a channel. Each node prints its `/ip4/.../tcp/<port>/p2p/<peer-id>` and its pubkey on startup:

```
curl -s 127.0.0.1:8227 -H 'content-type: application/json' -d \
 '{"id":1,"jsonrpc":"2.0","method":"connect_peer","params":[{"address":"<provider-multiaddr>"}]}'
curl -s 127.0.0.1:8227 -H 'content-type: application/json' -d \
 '{"id":1,"jsonrpc":"2.0","method":"open_channel","params":[{"pubkey":"<provider-pubkey>","funding_amount":"0x4a817c800","public":false}]}'  # 200 CKB
```

4. Once the channel reads `ChannelReady`, run the stream against your two nodes:

```
PAYER_RPC=http://127.0.0.1:8227 PROVIDER_RPC=http://127.0.0.1:8237 \
 pnpm -C packages/stream exec tsx scripts/stream-live.ts
```

The browser demo is the same: point `BUYER_RPC` and `MERCHANT_RPC` at your two nodes and run `pnpm -C examples/web-demo dev` without `TRICKLE_DEMO`. The tick is a plain Fiber keysend, so the payee can be any fnn node, not just ours.

## Hold-and-capture escrow (the sibling)

The same passkey / M-of-N layer also gates a Fiber hold invoice. A buyer pays a hold invoice and the funds sit held; the merchant captures it only with a passkey or a quorum, or refunds. Captured funds can settle into an on-chain custody cell that the chain will not release without a quorum. That custody is the only on-chain part, and it is live on Pudge. It suits larger deferred payments like deposits and pay-on-delivery, the opposite end from streaming.

## What is real

Streaming, the cap, and the meter run on two fnn v0.8.1 testnet nodes. Here is a recorded run of `packages/stream/scripts/stream-live.ts` (2026-07-01): a 2 CKB budget authorized once, 20 keysend ticks streamed, the provider releasing one API call per 0.1 CKB that settled, and the cap auto-stopping the stream with a further tick refused.

```
== Trickle: pay-per-API-call over Fiber (no holds, no cells) ==

[1] budget authorized once: 2 CKB to provider 024c5d9a82d2cb...  verify=true
[2] provider meter live: 0.1 CKB per API call, gating on settled inbound

    tick  0  paid 0.1 CKB  fee 0  ->  provider released 1 API calls
    tick  1  paid 0.1 CKB  fee 0  ->  provider released 2 API calls
    tick  2  paid 0.1 CKB  fee 0  ->  provider released 3 API calls
    ...
    tick 18  paid 0.1 CKB  fee 0  ->  provider released 19 API calls
    tick 19  paid 0.1 CKB  fee 0  ->  provider released 20 API calls

[3] stream auto-stopped at the budget: spent 2 CKB over 20 ticks, 0 CKB remaining
[4] further tick refused: BudgetExceededError (budget cap holds)

DONE: 20 API calls delivered, paid continuously, never held, never overspent.
```

Each tick settles in about 150 to 200 ms with zero fee on a direct channel. Over a routed 3-node path the fee is 0.1% proportional, with no base fee. The passkey is unit-tested with a simulated authenticator and tapped for real in the browser demo.

The on-chain custody is live on Pudge, and anyone can verify it on the explorer:

- Bootstrap a 2-of-3 custody account: [`0xbd12f3...`](https://pudge.explorer.nervos.org/transaction/0xbd12f381931dc665d64634876309ecc629f3491e8073868f63fb3ed4acd49b3c)
- Sweep 300 CKB into custody: [`0x5e2af2...`](https://pudge.explorer.nervos.org/transaction/0x5e2af2017c277d8e979fd484d4d5e73e6fd7bf5aeb4c0e4ff5a872fdaa1f567d)
- A 1-of-3 withdraw is rejected on-chain, and a 2-of-3 withdraw goes through: [`0x1ec0ba...`](https://pudge.explorer.nervos.org/transaction/0x1ec0ba4293077f772888837bb770d8ce7b1547acf9ee023be3166ffb9056696b)

Streaming settlement is off-chain by design, so it leaves no on-chain artifact. The hosted demo at trickle.lusocryptolabs.com runs on two live fnn v0.8.1 nodes on testnet, so every tick is a real keysend that moves the channel balance. The terminal run above reproduces the same thing, and the custody transactions are on-chain.

## Limitations

- keysend is not atomic with delivery, so each tick is one tick of counterparty trust. Keep ticks small and gate service on settled value.
- The meter needs one channel per payer today, because fnn gives the receiver no view of an incoming keysend.
- A routed path adds a 0.1% proportional fee per tick; a direct channel is free.

## License

MIT, see [LICENSE](./LICENSE).
