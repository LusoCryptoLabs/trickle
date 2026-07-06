import type { IFiberClient } from "./fiber-client.js";
import type { EscrowStore } from "./store.js";
import { hashPreimage, randomPreimage } from "./preimage.js";
import {
  type Currency,
  type Escrow,
  type Hash256,
  type HashAlgorithm,
  type HexNumber,
  escrowStateFromInvoice,
  isTerminal,
} from "./types.js";

export interface AuthorizeParams {
  /** shannons (CKB) or token base units (UDT), as a hex string or a number of CKB via ckbToShannonsHex. */
  amount: HexNumber;
  currency: Currency;
  description?: string;
  expirySeconds?: number;
  hashAlgorithm?: HashAlgorithm;
  /** Provide for stablecoin / RGB++-asset escrow (e.g. RUSD). */
  udtTypeScript?: unknown | null;
}

/**
 * A capture authorizer verifies that whoever is asking to capture is allowed to, at the
 * application layer: the gateway verifies a passkey / M-of-N signature here, and only on
 * success does it call settle_invoice (an off-chain node RPC).
 * No lock script runs at capture time. @trickle/auth supplies implementations.
 */
export interface CaptureAuthorizer {
  authorize(escrow: Escrow, proof: unknown): Promise<boolean>;
}

export class CaptureNotAuthorizedError extends Error {
  constructor(msg = "capture authorization failed") { super(msg); this.name = "CaptureNotAuthorizedError"; }
}
export class EscrowNotHeldError extends Error {
  constructor(public readonly state: string) {
    super(`escrow is not in the Authorized (held) state, it is ${state}`);
    this.name = "EscrowNotHeldError";
  }
}
export class EscrowNotFoundError extends Error {
  constructor(id: string) { super(`no escrow ${id}`); this.name = "EscrowNotFoundError"; }
}

export interface EscrowManagerOptions {
  /** If set, capture() requires a proof that this authorizer accepts. */
  authorizer?: CaptureAuthorizer;
}

export class EscrowManager {
  constructor(
    private readonly client: IFiberClient,
    private readonly store: EscrowStore,
    private readonly opts: EscrowManagerOptions = {},
  ) {}

  /** MERCHANT: mint a hold invoice. Returns the Pending escrow; show escrow.invoiceAddress to the buyer. */
  async authorize(p: AuthorizeParams): Promise<Escrow> {
    const algo = p.hashAlgorithm ?? "sha256";
    const preimage = randomPreimage();
    const paymentHash = hashPreimage(preimage, algo);
    const res = await this.client.newInvoice({
      amount: p.amount,
      currency: p.currency,
      hash_algorithm: algo,
      payment_hash: paymentHash,
      expiry: p.expirySeconds ? "0x" + p.expirySeconds.toString(16) : undefined,
      description: p.description,
      udt_type_script: p.udtTypeScript ?? undefined,
    });
    const now = Date.now();
    const escrow: Escrow = {
      id: paymentHash,
      paymentHash,
      amount: p.amount,
      currency: p.currency,
      hashAlgorithm: algo,
      invoiceAddress: res.invoice_address,
      description: p.description,
      state: "Pending",
      udtTypeScript: p.udtTypeScript ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.put(escrow);
    await this.store.putPreimage(paymentHash, preimage);
    return escrow;
  }

  async get(id: Hash256): Promise<Escrow> {
    const e = await this.store.get(id);
    if (!e) throw new EscrowNotFoundError(id);
    return e;
  }

  /** Pull the live invoice status from the node and persist any transition. */
  async refresh(id: Hash256): Promise<Escrow> {
    const e = await this.get(id);
    if (isTerminal(e.state)) return e;
    const inv = await this.client.getInvoice(e.paymentHash);
    const next = escrowStateFromInvoice(inv.status);
    if (next !== e.state) {
      e.state = next;
      e.updatedAt = Date.now();
      if (next === "Captured") e.capturedAt = e.updatedAt;
      if (next === "Refunded") e.refundedAt = e.updatedAt;
      await this.store.put(e);
    }
    return e;
  }

  /**
   * CAPTURE. The gateway is expected to have verified authorization already; if this manager was
   * constructed with an authorizer, the supplied `proof` must pass it here too (defence in depth).
   * Then reveal the preimage via settle_invoice. Valid only while the escrow is Authorized (held).
   */
  async capture(id: Hash256, proof?: unknown): Promise<Escrow> {
    const e = await this.refresh(id);
    if (e.state !== "Authorized") throw new EscrowNotHeldError(e.state);
    if (this.opts.authorizer) {
      const ok = await this.opts.authorizer.authorize(e, proof);
      if (!ok) throw new CaptureNotAuthorizedError();
    }
    const preimage = await this.store.getPreimage(e.paymentHash);
    if (!preimage) throw new Error(`missing preimage for ${e.paymentHash}`);
    await this.client.settleInvoice(e.paymentHash, preimage);
    e.state = "Captured";
    e.updatedAt = Date.now();
    e.capturedAt = e.updatedAt;
    await this.store.put(e);
    return e;
  }

  /** REFUND before capture: cancel the hold invoice, releasing the buyer's HTLC. */
  async refund(id: Hash256): Promise<Escrow> {
    const e = await this.refresh(id);
    if (isTerminal(e.state)) {
      if (e.state === "Refunded" || e.state === "Expired") return e;
      throw new EscrowNotHeldError(e.state);
    }
    await this.client.cancelInvoice(e.paymentHash);
    e.state = "Refunded";
    e.updatedAt = Date.now();
    e.refundedAt = e.updatedAt;
    await this.store.put(e);
    return e;
  }
}
