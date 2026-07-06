// Bridge for fnn-pay (https://github.com/chukwuma619/fnn-pay), a self-hosted, non-custodial Fiber
// payment processor with webhook + WS settlement. Trickle issues the hold invoice on the same Fiber
// node fnn-pay watches; the invoice webhook is turned into Trickle escrow events by re-reading the
// node as the source of truth, and signals when funds are held so the merchant can capture. The
// node, not the webhook body, is authoritative: handleWebhook only uses the payment_hash to know
// which escrow to refresh.

import type { Escrow, EscrowManager } from "@trickle/core";

/** The one field this bridge needs from an fnn-pay invoice webhook: which invoice changed. */
export interface FnnPayInvoiceWebhook {
  payment_hash: string;
  /** fnn-pay also sends a status; it is advisory only, the node is re-read for truth. */
  status?: string;
  [k: string]: unknown;
}

export interface BridgeHandlers {
  /** Funds are HELD (Authorized): the capture decision can now be made (passkey / M-of-N). */
  onHeld?(escrow: Escrow): void | Promise<void>;
  onCaptured?(escrow: Escrow): void | Promise<void>;
  onRefunded?(escrow: Escrow): void | Promise<void>;
  onExpired?(escrow: Escrow): void | Promise<void>;
  /** Unknown payment_hash (not a Trickle escrow), or any error. */
  onUnknown?(paymentHash: string, error?: unknown): void | Promise<void>;
}

export class FnnPayWebhookBridge {
  constructor(private readonly manager: EscrowManager, private readonly handlers: BridgeHandlers = {}) {}

  /** Call this from your fnn-pay webhook HTTP handler. Returns the refreshed escrow (or null). */
  async handleWebhook(event: FnnPayInvoiceWebhook): Promise<Escrow | null> {
    if (!event?.payment_hash) {
      await this.handlers.onUnknown?.("", new Error("webhook missing payment_hash"));
      return null;
    }
    let escrow: Escrow;
    try {
      escrow = await this.manager.refresh(event.payment_hash);
    } catch (err) {
      await this.handlers.onUnknown?.(event.payment_hash, err);
      return null;
    }
    switch (escrow.state) {
      case "Authorized": await this.handlers.onHeld?.(escrow); break;
      case "Captured": await this.handlers.onCaptured?.(escrow); break;
      case "Refunded": await this.handlers.onRefunded?.(escrow); break;
      case "Expired": await this.handlers.onExpired?.(escrow); break;
    }
    return escrow;
  }
}
