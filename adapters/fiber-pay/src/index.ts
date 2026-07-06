// Adapter: drive Trickle's authorize-then-capture on top of a @fiber-pay/sdk FiberRpcClient.
//
// @fiber-pay/sdk already exposes the hold-invoice plumbing (newInvoice with payment_hash,
// settleInvoice, cancelInvoice, getInvoice). Trickle adds the part it leaves out: an authorization
// layer over the capture decision plus a reusable escrow state machine. This adapter maps the
// SDK's param-object client onto Trickle's IFiberClient, so a fiber-pay user gets EscrowManager +
// passkey / M-of-N capture by wrapping their existing client. No hard dependency on @fiber-pay/sdk:
// we type against its client shape structurally to avoid version coupling.

import type {
  GetInvoiceResult,
  IFiberClient,
  NewInvoiceParams,
  NewInvoiceResult,
  NodeInfo,
  ParseInvoiceResult,
  PaymentResult,
  SendPaymentParams,
} from "@trickle/core";

/** The subset of @fiber-pay/sdk's FiberRpcClient that Trickle uses (param-object style). */
export interface FiberPayRpcClient {
  newInvoice(params: NewInvoiceParams): Promise<{ invoice_address: string; invoice?: unknown }>;
  parseInvoice(params: { invoice: string }): Promise<unknown>;
  getInvoice(params: { payment_hash: string }): Promise<{ status: string; invoice_address?: string; invoice?: unknown }>;
  cancelInvoice(params: { payment_hash: string }): Promise<{ status?: string }>;
  settleInvoice(params: { payment_hash: string; payment_preimage: string }): Promise<void>;
  sendPayment(params: SendPaymentParams): Promise<{ payment_hash: string; status: string; fee?: string }>;
  getPayment(params: { payment_hash: string }): Promise<{ payment_hash: string; status: string }>;
  nodeInfo(): Promise<{ version?: string; node_id?: string; pubkey?: string; chain_hash?: string; peers_count?: string | number }>;
}

/** Wrap a @fiber-pay/sdk FiberRpcClient so it satisfies Trickle's IFiberClient. */
export class FiberPayClientAdapter implements IFiberClient {
  constructor(private readonly rpc: FiberPayRpcClient) {}

  async getNodeInfo(): Promise<NodeInfo> {
    const n = await this.rpc.nodeInfo();
    return {
      version: n.version ?? "unknown",
      pubkey: n.pubkey ?? n.node_id ?? "0x",
      chain_hash: n.chain_hash ?? "0x",
      peers_count: typeof n.peers_count === "number" ? "0x" + n.peers_count.toString(16) : n.peers_count ?? "0x0",
    };
  }

  async newInvoice(params: NewInvoiceParams): Promise<NewInvoiceResult> {
    const r = await this.rpc.newInvoice(params);
    return { invoice_address: r.invoice_address, invoice: r.invoice ?? {} };
  }

  parseInvoice(invoice: string): Promise<ParseInvoiceResult> {
    return this.rpc.parseInvoice({ invoice }) as Promise<ParseInvoiceResult>;
  }

  getInvoice(paymentHash: string): Promise<GetInvoiceResult> {
    return this.rpc.getInvoice({ payment_hash: paymentHash }) as Promise<GetInvoiceResult>;
  }

  async cancelInvoice(paymentHash: string): Promise<{ status: string }> {
    const r = await this.rpc.cancelInvoice({ payment_hash: paymentHash });
    return { status: r.status ?? "Cancelled" };
  }

  settleInvoice(paymentHash: string, preimage: string): Promise<void> {
    return this.rpc.settleInvoice({ payment_hash: paymentHash, payment_preimage: preimage });
  }

  sendPayment(params: SendPaymentParams): Promise<PaymentResult> {
    return this.rpc.sendPayment(params) as Promise<PaymentResult>;
  }

  getPayment(paymentHash: string): Promise<PaymentResult> {
    return this.rpc.getPayment({ payment_hash: paymentHash }) as Promise<PaymentResult>;
  }
}
