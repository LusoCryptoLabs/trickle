import { EventEmitter } from "node:events";
import type { EscrowManager } from "./escrow.js";
import { type Escrow, type EscrowState, type Hash256, isTerminal } from "./types.js";

export interface WatcherOptions {
  /** Poll cadence; default 3s (holds are short). */
  intervalMs?: number;
}

/**
 * Polls EscrowManager.refresh() and emits on every state transition, stopping once an escrow is
 * terminal (poll invoice status until terminal).
 *
 * Events: "transition" ({ from, to, escrow }), plus one named event per state:
 * "pending" | "authorized" | "captured" | "refunded" | "expired", and "error" (err, id).
 */
export class EscrowWatcher extends EventEmitter {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private last = new Map<string, EscrowState>();
  private readonly intervalMs: number;

  constructor(private readonly manager: EscrowManager, opts: WatcherOptions = {}) {
    super();
    this.intervalMs = opts.intervalMs ?? 3000;
  }

  watch(id: Hash256): void {
    const key = id.toLowerCase();
    if (this.timers.has(key)) return;
    const tick = async () => {
      try {
        const e = await this.manager.refresh(id);
        const prev = this.last.get(key);
        if (prev !== e.state) {
          this.last.set(key, e.state);
          if (prev !== undefined) this.emit("transition", { from: prev, to: e.state, escrow: e });
          this.emit(e.state.toLowerCase(), e);
        }
        if (isTerminal(e.state)) this.unwatch(id);
      } catch (err) {
        this.emit("error", err, id);
      }
    };
    void tick();
    this.timers.set(key, setInterval(tick, this.intervalMs));
  }

  unwatch(id: Hash256): void {
    const key = id.toLowerCase();
    const t = this.timers.get(key);
    if (t) {
      clearInterval(t);
      this.timers.delete(key);
    }
  }

  /** Resolve when the escrow reaches a terminal state (or reject on timeout). */
  waitForTerminal(id: Hash256, timeoutMs = 120_000): Promise<Escrow> {
    return new Promise((resolve, reject) => {
      const onState = (e: Escrow) => {
        if (e.id.toLowerCase() === id.toLowerCase() && isTerminal(e.state)) {
          cleanup();
          resolve(e);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`watcher timeout for ${id}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("captured", onState);
        this.off("refunded", onState);
        this.off("expired", onState);
      };
      this.on("captured", onState);
      this.on("refunded", onState);
      this.on("expired", onState);
      this.watch(id);
    });
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}
