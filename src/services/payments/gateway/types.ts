/**
 * Taking money online: the one shape every payment gateway is driven through
 * (PLAN-online-shop-payments.md, "Not marrying one").
 *
 * Each shop connects its OWN gateway account, so shops will eventually want different gateways --
 * one shop's accountant banks with Cashfree, another's with PhonePe. Everything above this file
 * talks to a PaymentGateway and never to Razorpay by name, so adding the next one is a file, not a
 * rewrite. The same shape as the WhatsApp service's Engine: a small interface, one implementation.
 *
 * Money is ALWAYS integer paise here. Rupees with decimals are how the books keep it; the gateways
 * all take the smallest unit, and a float anywhere between the two is how ₹8,500 becomes
 * ₹8,499.99.
 */

export type GatewayName = 'RAZORPAY';
export type GatewayMode = 'LIVE' | 'TEST';

/** What a gateway said, in words an owner can act on, and whether trying again could help. */
export class GatewayError extends Error {
  constructor(
    message: string,
    /** AUTH: the keys were refused. BAD_REQUEST: the gateway rejected what we sent.
     *  UNAVAILABLE: it did not answer, or answered that it was busy -- worth retrying. */
    readonly kind: 'AUTH' | 'BAD_REQUEST' | 'UNAVAILABLE',
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'GatewayError';
  }
  get transient() { return this.kind === 'UNAVAILABLE'; }
}

export interface CreatedOrder {
  gatewayOrderId: string;
  amountPaise: number;
  /** Exactly what the shopper's browser needs to open the gateway's own checkout. Never a secret:
   *  the key id is the public half, meant to be in the page. */
  checkoutPayload: Record<string, unknown>;
}

export type WebhookKind = 'PAID' | 'FAILED' | 'REFUNDED' | 'REFUND_FAILED' | 'QR_CREDITED' | 'IGNORED';

export interface WebhookEvent {
  kind: WebhookKind;
  /** The gateway's own name for the event, kept for the receipt. */
  event: string;
  /** The gateway's id for this delivery, when it sends one -- what makes a repeat recognisable. */
  eventId: string | null;
  gatewayOrderId: string | null;
  paymentId: string | null;
  refundId: string | null;
  amountPaise: number | null;
  /** The gateway's words for a failure, for the owner. */
  failReason: string | null;
  /** QR_CREDITED: the QR code that was paid. */
  qrCodeId?: string | null;
}

/** A UPI QR for one bill at the till: single use, for exactly this amount, closing by itself. */
export interface CreatedUpiQr { qrId: string; imageUrl: string }

/** A payment made to a QR code, as the gateway reports it. */
export interface UpiQrPayment {
  paymentId: string;
  amountPaise: number;
  status: 'CAPTURED' | 'AUTHORIZED' | 'FAILED' | 'OTHER';
  /** The bank reference (UTR / RRN) the customer's app shows, when the gateway gives it. */
  utr: string | null;
  paidAt: Date | null;
}

export interface RefundResult {
  refundId: string;
  /** PROCESSED is final; PENDING settles later and arrives as a REFUNDED / REFUND_FAILED webhook. */
  status: 'PROCESSED' | 'PENDING' | 'FAILED';
  amountPaise: number;
}

export interface GatewayPayment {
  paymentId: string;
  status: 'CAPTURED' | 'AUTHORIZED' | 'FAILED' | 'REFUNDED' | 'CREATED' | 'OTHER';
  amountPaise: number;
  failReason: string | null;
}

/** One payment as the gateway itself reports it -- asked for with the shop's keys, server to server. */
export interface GatewayPaymentDetail extends GatewayPayment {
  gatewayOrderId: string | null;
  currency: string;
  /** upi, card, netbanking, wallet, emi... */
  method: string | null;
}

export interface GatewayRefund {
  refundId: string;
  status: RefundResult['status'];
  amountPaise: number;
  /** What we wrote on it when we asked -- how a refund we lost the answer to is found again. */
  ref: string | null;
}

export interface GatewayCheck {
  ok: boolean;
  mode: GatewayMode;
  /** One sentence for the owner: what is working, or what to fix. */
  message: string;
}

export interface PaymentGateway {
  readonly name: GatewayName;
  readonly mode: GatewayMode;

  /** Step 3 of paying: an order at the gateway for OUR figure (rule P4), never the browser's. */
  createOrder(amountPaise: number, receipt: string, notes?: Record<string, string>): Promise<CreatedOrder>;

  /** The browser's "paid" handback. A hint to start looking, never proof (rule P2). */
  verifyCheckoutSignature(input: { gatewayOrderId: string; paymentId: string; signature: string }): boolean;

  /** Proof: the webhook, signed with the secret we generated for this shop. */
  verifyWebhook(rawBody: Buffer | string, signature: string | undefined): boolean;
  parseWebhook(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): WebhookEvent;

  /**
   * Always an explicit amount -- returning one saree of three is a partial refund (rule P7).
   * `ref` is written onto the refund at the gateway, so one whose answer was lost to a timeout can
   * be found again instead of being asked for twice.
   */
  refund(paymentId: string, amountPaise: number, reason: string, ref?: string): Promise<RefundResult>;

  /** For the sweeper: what the gateway knows about an order whose webhook never came. */
  paymentsForOrder(gatewayOrderId: string): Promise<GatewayPayment[]>;

  /** One payment, asked of the gateway directly. The browser's word is never taken for any of it. */
  fetchPayment(paymentId: string): Promise<GatewayPaymentDetail>;

  /** For an account set to capture by hand: take the money that was authorised. */
  capture(paymentId: string, amountPaise: number): Promise<GatewayPaymentDetail>;

  /** Every refund already made against a payment. */
  refundsForPayment(paymentId: string): Promise<GatewayRefund[]>;

  /** "Check it works" on the keys screen. */
  check(): Promise<GatewayCheck>;

  createUpiQr(amountPaise: number, opts: { name: string; closeBy: Date; description?: string; notes?: Record<string, string> }): Promise<CreatedUpiQr>;
  upiQrPayments(qrId: string): Promise<UpiQrPayment[]>;
  /** Stops a QR taking money. Closing one already closed is not an error. */
  closeUpiQr(qrId: string): Promise<void>;
}
