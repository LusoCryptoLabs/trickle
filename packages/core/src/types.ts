// Fiber + Trickle types. Wire-level enums match fnn v0.8.1.

export type Hash256 = string; // "0x" + 64 hex
export type Pubkey = string; // "0x" + 66 hex (compressed secp256k1)
export type HexNumber = string; // "0x" + hex

/** Invoice address prefix maps 1:1 to network: fibb=mainnet, fibt=testnet, fibd=dev. */
export type Currency = "Fibb" | "Fibt" | "Fibd";
export type HashAlgorithm = "ckb_hash" | "sha256";

/** get_invoice status, PascalCase on fnn v0.8.1. */
export type FiberInvoiceStatus = "Open" | "Received" | "Paid" | "Cancelled" | "Expired";
/** get_payment status, note "Inflight" (one capital), not "InFlight". */
export type FiberPaymentStatus = "Created" | "Inflight" | "Success" | "Failed";

/**
 * Trickle escrow lifecycle. The headline transition is Authorized -> Captured | Refunded,
 * where Authorized means the buyer's funds are HELD on the Fiber HTLC (invoice status Received),
 * committed but not yet settled.
 *
 *   Pending     buyer has not paid the hold invoice yet (invoice Open)
 *   Authorized  funds held, awaiting a capture decision (invoice Received)  <-- the hold
 *   Captured    preimage revealed via settle_invoice, merchant paid (invoice Paid)
 *   Refunded    cancelled before capture, buyer's HTLC released (invoice Cancelled)
 *   Expired     hold timed out, native auto-refund (invoice Expired)
 */
export type EscrowState = "Pending" | "Authorized" | "Captured" | "Refunded" | "Expired";

export function escrowStateFromInvoice(status: FiberInvoiceStatus): EscrowState {
  switch (status) {
    case "Open": return "Pending";
    case "Received": return "Authorized";
    case "Paid": return "Captured";
    case "Cancelled": return "Refunded";
    case "Expired": return "Expired";
  }
}

export const TERMINAL_STATES: readonly EscrowState[] = ["Captured", "Refunded", "Expired"];
export function isTerminal(s: EscrowState): boolean {
  return TERMINAL_STATES.includes(s);
}

export interface Escrow {
  /** Equals the payment_hash H (hex). One escrow per hold invoice. */
  id: Hash256;
  paymentHash: Hash256; // H = sha256(preimage)
  amount: HexNumber; // shannons (CKB) or token base units (UDT), hex
  currency: Currency;
  hashAlgorithm: HashAlgorithm;
  invoiceAddress: string; // fibt1...
  description?: string;
  state: EscrowState;
  /** Optional UDT type script for stablecoin / RGB++-asset escrow (e.g. RUSD). */
  udtTypeScript?: unknown | null;
  createdAt: number;
  updatedAt: number;
  /** Set once captured/refunded. */
  capturedAt?: number;
  refundedAt?: number;
}

/**
 * The 32-byte preimage the merchant withholds. Stored separately from the public Escrow.
 * MVP custody is centralized in the gateway store (disclosed in the README); decentralized
 * preimage custody is roadmap.
 */
export interface PreimageRecord {
  paymentHash: Hash256;
  preimage: Hash256; // "0x" + 64 hex, exactly 32 bytes
}

// Fiber RPC param/result shapes (subset Trickle uses)

export interface NewInvoiceParams {
  amount: HexNumber;
  currency: Currency;
  hash_algorithm: HashAlgorithm;
  payment_hash: Hash256; // supplying this (with no preimage) makes it a HOLD invoice
  expiry?: HexNumber; // seconds, hex
  description?: string;
  udt_type_script?: unknown;
}

export interface NewInvoiceResult {
  invoice_address: string;
  invoice: unknown;
}

export interface GetInvoiceResult {
  invoice_address: string;
  invoice: unknown;
  status: FiberInvoiceStatus;
}

export interface SendPaymentParams {
  invoice?: string;
  payment_hash?: Hash256;
  amount?: HexNumber;
  udt_type_script?: unknown;
  dry_run?: boolean;
  /** Spontaneous payment (no invoice); the node generates the payment_hash. Used by streaming ticks. */
  keysend?: boolean;
  target_pubkey?: Pubkey;
  /** TLV map { "0x<u32hex>": "0x<bytes>" }, e.g. session id and cursor for a metered stream. */
  custom_records?: Record<string, string>;
  max_fee_amount?: HexNumber;
  max_parts?: number;
}

export interface PaymentResult {
  payment_hash: Hash256;
  status: FiberPaymentStatus;
  failed_error?: string;
  fee?: HexNumber;
}

export interface ParseInvoiceResult {
  invoice: { currency: Currency; amount: HexNumber | null; data: { payment_hash: Hash256 } };
}

export interface NodeInfo {
  version: string;
  pubkey: Pubkey;
  chain_hash: Hash256;
  peers_count: HexNumber;
  udt_cfg_infos?: unknown[];
}
