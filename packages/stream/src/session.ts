// Payer side: stream keysend ticks under a grant, enforcing the budget and rate caps locally before each tick; each tick settles in milliseconds so nothing is held.
import type { IFiberClient } from "@trickle/core";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Grant } from "./grant.js";

export class BudgetExceededError extends Error {
  constructor() { super("tick would exceed the grant budget"); this.name = "BudgetExceededError"; }
}
export class RateExceededError extends Error {
  constructor() { super("tick would exceed the grant rate"); this.name = "RateExceededError"; }
}

export interface TickReceipt {
  cursor: number;
  amount: string;
  paymentHash: string;
  fee: string;
}

export interface SessionOptions {
  /** the UDT type script for a stablecoin / RGB++ stream (omit for CKB). */
  udtTypeScript?: unknown;
  pollMs?: number;
  nowMs?: () => number;
}

const hexFromUtf8 = (s: string) => "0x" + bytesToHex(utf8ToBytes(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AllowanceSession {
  private _spent = 0n;
  private cursor = 0;
  private window: { t: number; amt: bigint }[] = [];

  constructor(
    private readonly client: IFiberClient,
    public readonly grant: Grant,
    private readonly opts: SessionOptions = {},
  ) {}

  spent(): bigint { return this._spent; }
  remaining(): bigint { return BigInt(this.grant.maxTotal) - this._spent; }
  ticks(): number { return this.cursor; }

  /** Push one keysend tick of `amount` shannons, after a local budget + rate check. */
  async tick(amount: string | bigint): Promise<TickReceipt> {
    const amt = BigInt(amount);
    if (this._spent + amt > BigInt(this.grant.maxTotal)) throw new BudgetExceededError();

    const rate = BigInt(this.grant.maxRate);
    const now = (this.opts.nowMs ?? (() => Date.now()))();
    if (rate > 0n) {
      this.window = this.window.filter((w) => now - w.t < 1000);
      const inWindow = this.window.reduce((s, w) => s + w.amt, 0n);
      if (inWindow + amt > rate) throw new RateExceededError();
    }

    const res = await this.client.sendPayment({
      target_pubkey: this.grant.payee,
      amount: "0x" + amt.toString(16),
      keysend: true,
      udt_type_script: this.opts.udtTypeScript,
      custom_records: {
        "0x1": hexFromUtf8(this.grant.sessionId),
        "0x2": "0x" + this.cursor.toString(16).padStart(16, "0"),
      },
    });

    let status = res.status;
    let fee = res.fee ?? "0x0";
    const pollMs = this.opts.pollMs ?? 30;
    for (let i = 0; i < 300 && status !== "Success" && status !== "Failed"; i++) {
      await sleep(pollMs);
      const gp = await this.client.getPayment(res.payment_hash);
      status = gp.status;
      fee = gp.fee ?? fee;
    }
    if (status !== "Success") throw new Error(`tick failed: ${status}`);

    this._spent += amt;
    this.window.push({ t: now, amt });
    return { cursor: this.cursor++, amount: "0x" + amt.toString(16), paymentHash: res.payment_hash, fee };
  }

  /** Tick `amount` repeatedly until the budget is exhausted (or `ticks` is reached). */
  async stream(amount: string | bigint, opts: { ticks?: number; onTick?: (r: TickReceipt) => void | Promise<void> } = {}): Promise<number> {
    const amt = BigInt(amount);
    let n = 0;
    while (this.remaining() >= amt && (opts.ticks === undefined || n < opts.ticks)) {
      const r = await this.tick(amt);
      await opts.onTick?.(r);
      n++;
    }
    return n;
  }
}
