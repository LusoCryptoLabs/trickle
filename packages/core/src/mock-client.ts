import type { IFiberClient } from "./fiber-client.js";
import type {
  FiberInvoiceStatus,
  FiberPaymentStatus,
  GetInvoiceResult,
  NewInvoiceParams,
  NewInvoiceResult,
  NodeInfo,
  ParseInvoiceResult,
  PaymentResult,
  SendPaymentParams,
} from "./types.js";

/**
 * In-memory IFiberClient that mirrors the verified fnn v0.8.1 hold-invoice lifecycle:
 *   new_invoice -> Open ; send_payment -> Received (held) ; settle -> Paid ; cancel -> Cancelled.
 * Keeps the passkey / M-of-N capture gate demoable when no node is reachable (Day-1 fallback).
 */
const MOCK_PREFIX = "fibtmock1";

export class MockFiberClient implements IFiberClient {
  private invoices = new Map<string, { status: FiberInvoiceStatus; params: NewInvoiceParams }>();
  private payments = new Map<string, FiberPaymentStatus>();
  private keysendSeq = 0;
  /** total value sent via keysend (models a receiver's settled balance for the meter). */
  receivedShannons = 0n;

  private key(h: string) { return h.toLowerCase(); }
  private addrFor(h: string) { return MOCK_PREFIX + h.replace(/^0x/, ""); }
  private hashFromAddr(addr: string) { return "0x" + addr.slice(MOCK_PREFIX.length); }

  async getNodeInfo(): Promise<NodeInfo> {
    return { version: "mock-0.8.1", pubkey: "0x" + "ab".repeat(33), chain_hash: "0x" + "00".repeat(32), peers_count: "0x0" };
  }

  async newInvoice(params: NewInvoiceParams): Promise<NewInvoiceResult> {
    this.invoices.set(this.key(params.payment_hash), { status: "Open", params });
    return { invoice_address: this.addrFor(params.payment_hash), invoice: {} };
  }

  async parseInvoice(invoice: string): Promise<ParseInvoiceResult> {
    const h = this.hashFromAddr(invoice);
    const rec = this.invoices.get(this.key(h));
    return { invoice: { currency: rec?.params.currency ?? "Fibt", amount: rec?.params.amount ?? null, data: { payment_hash: h } } };
  }

  async getInvoice(paymentHash: string): Promise<GetInvoiceResult> {
    const rec = this.invoices.get(this.key(paymentHash));
    if (!rec) throw new Error(`mock: unknown invoice ${paymentHash}`);
    return { invoice_address: this.addrFor(paymentHash), invoice: {}, status: rec.status };
  }

  async sendPayment(params: SendPaymentParams): Promise<PaymentResult> {
    // keysend: no invoice, the node generates a hash and it settles instantly (a streaming tick).
    if (params.keysend) {
      const h = "0x" + (this.keysendSeq++).toString(16).padStart(64, "0");
      this.payments.set(this.key(h), "Success");
      this.receivedShannons += BigInt(params.amount ?? "0x0");
      return { payment_hash: h, status: "Success", fee: "0x0" };
    }
    const h = params.payment_hash ?? this.hashFromAddr(params.invoice ?? "");
    const rec = this.invoices.get(this.key(h));
    if (!rec) throw new Error(`mock: cannot pay unknown invoice ${h}`);
    // A hold invoice goes Open -> Received: funds held, awaiting capture.
    if (rec.status === "Open") rec.status = "Received";
    this.payments.set(this.key(h), "Inflight");
    return { payment_hash: h, status: "Inflight" };
  }

  async settleInvoice(paymentHash: string, _preimage: string): Promise<void> {
    const rec = this.invoices.get(this.key(paymentHash));
    if (!rec) throw new Error(`mock: unknown invoice ${paymentHash}`);
    if (rec.status !== "Received") throw new Error(`mock: settle requires Received, got ${rec.status}`);
    rec.status = "Paid";
    this.payments.set(this.key(paymentHash), "Success");
  }

  async cancelInvoice(paymentHash: string): Promise<{ status: string }> {
    const rec = this.invoices.get(this.key(paymentHash));
    if (!rec) throw new Error(`mock: unknown invoice ${paymentHash}`);
    rec.status = "Cancelled";
    this.payments.set(this.key(paymentHash), "Failed");
    return { status: "Cancelled" };
  }

  async getPayment(paymentHash: string): Promise<PaymentResult> {
    return { payment_hash: paymentHash, status: this.payments.get(this.key(paymentHash)) ?? "Created" };
  }
}
