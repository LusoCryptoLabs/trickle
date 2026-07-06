// Minimal JSON-RPC client for a Fiber (fnn v0.8.1) node, scoped to the hold-invoice flow.
// Repackaged here so @trickle/core is publishable on its own. settle_invoice is the capture call.

import type {
  GetInvoiceResult,
  NewInvoiceParams,
  NewInvoiceResult,
  NodeInfo,
  ParseInvoiceResult,
  PaymentResult,
  SendPaymentParams,
} from "./types.js";

/**
 * The surface Trickle depends on. Both the real {@link FiberClient} and the {@link MockFiberClient}
 * implement it, so the capture gate stays demoable when no node is reachable.
 */
export interface IFiberClient {
  getNodeInfo(): Promise<NodeInfo>;
  newInvoice(params: NewInvoiceParams): Promise<NewInvoiceResult>;
  parseInvoice(invoice: string): Promise<ParseInvoiceResult>;
  getInvoice(paymentHash: string): Promise<GetInvoiceResult>;
  cancelInvoice(paymentHash: string): Promise<{ status: string }>;
  /** Capture: reveal the preimage. Valid only while the invoice status is "Received". */
  settleInvoice(paymentHash: string, preimage: string): Promise<void>;
  sendPayment(params: SendPaymentParams): Promise<PaymentResult>;
  getPayment(paymentHash: string): Promise<PaymentResult>;
}

export class FiberRpcError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
    this.name = "FiberRpcError";
  }
}

export class FiberClient implements IFiberClient {
  private id = 0;
  constructor(private readonly rpcUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    if (!res.ok) throw new FiberRpcError(`HTTP ${res.status} from Fiber RPC at ${this.rpcUrl}`);
    const data = (await res.json()) as { result?: T; error?: { message: string; code: number } };
    if (data.error) throw new FiberRpcError(data.error.message, data.error.code);
    return data.result as T;
  }

  getNodeInfo() { return this.call<NodeInfo>("node_info"); }
  newInvoice(params: NewInvoiceParams) { return this.call<NewInvoiceResult>("new_invoice", [params]); }
  parseInvoice(invoice: string) { return this.call<ParseInvoiceResult>("parse_invoice", [{ invoice }]); }
  getInvoice(paymentHash: string) { return this.call<GetInvoiceResult>("get_invoice", [{ payment_hash: paymentHash }]); }
  cancelInvoice(paymentHash: string) { return this.call<{ status: string }>("cancel_invoice", [{ payment_hash: paymentHash }]); }
  settleInvoice(paymentHash: string, preimage: string) {
    return this.call<void>("settle_invoice", [{ payment_hash: paymentHash, payment_preimage: preimage }]);
  }
  sendPayment(params: SendPaymentParams) { return this.call<PaymentResult>("send_payment", [params]); }
  getPayment(paymentHash: string) { return this.call<PaymentResult>("get_payment", [{ payment_hash: paymentHash }]); }
}

// Unit helpers (1 CKB = 100_000_000 shannons)
const SHANNONS_PER_CKB = 100_000_000n;

export function ckbToShannonsHex(ckb: number): string {
  return "0x" + BigInt(Math.round(ckb * 1e8)).toString(16);
}

export function shannonsToCkb(shannons: string): string {
  const v = BigInt(shannons);
  const whole = v / SHANNONS_PER_CKB;
  const frac = v % SHANNONS_PER_CKB;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}
