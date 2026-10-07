import axios, { AxiosError, AxiosInstance } from 'axios';
import crypto from 'crypto';
import {
  CreatedOrder, GatewayCheck, GatewayError, GatewayMode, GatewayPayment, GatewayPaymentDetail,
  GatewayRefund, PaymentGateway, RefundResult, WebhookEvent, CreatedUpiQr, UpiQrPayment
} from './types';

/**
 * Razorpay, driven over its REST API with the shop's own keys.
 *
 * No SDK: the four calls we make are four HTTPS requests, and axios is already here. One fewer
 * dependency to keep patched in the part of the app that touches money.
 *
 * RAZORPAY_API_URL points it at a stand-in for the tests (scripts/verify-online-payments.ts runs a
 * fake Razorpay on 127.0.0.1). Unset everywhere else. A real gateway is never called by a suite --
 * the one real check is the owner pressing "Check it works" on their own keys.
 */

const DEFAULT_API = 'https://api.razorpay.com/v1';

/** rzp_live_ / rzp_test_ then 14 characters today; a little latitude in case that grows. */
export const RAZORPAY_KEY_ID = /^rzp_(live|test)_[A-Za-z0-9]{10,32}$/;
export const RAZORPAY_KEY_SECRET = /^[A-Za-z0-9]{16,64}$/;

/** Razorpay will not take less than ₹1. */
const MIN_PAISE = 100;

export const razorpayMode = (keyId: string): GatewayMode => (keyId.startsWith('rzp_live_') ? 'LIVE' : 'TEST');

/** "rzp_live_…4f2a": enough for an owner to recognise their own key on a support call. */
export const maskKeyId = (keyId: string) => {
  const head = keyId.startsWith('rzp_live_') ? 'rzp_live_' : keyId.startsWith('rzp_test_') ? 'rzp_test_' : '';
  return `${head}…${keyId.slice(-4)}`;
};

const hmacHex = (secret: string, data: Buffer | string) =>
  crypto.createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time, and false -- not a throw -- for anything that is not even the right length. */
const sameHex = (expected: string, given: unknown) => {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given.trim().toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const paise = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export class RazorpayGateway implements PaymentGateway {
  readonly name = 'RAZORPAY' as const;
  readonly mode: GatewayMode;
  private readonly http: AxiosInstance;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret?: string
  ) {
    this.mode = razorpayMode(keyId);
    this.http = axios.create({
      baseURL: (process.env.RAZORPAY_API_URL || DEFAULT_API).replace(/\/+$/, ''),
      timeout: 15_000,
      auth: { username: keyId, password: keySecret },
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /** Every failure turned into one sentence and a kind. The gateway's own words when it gave any. */
  private fail(e: unknown): never {
    if (e instanceof GatewayError) throw e;
    const err = e as AxiosError<any>;
    const status = err.response?.status ?? null;
    const said = str(err.response?.data?.error?.description);
    if (status === 401) {
      throw new GatewayError(said || 'Razorpay did not accept these keys. Copy the Key ID and Key Secret again from Account & Settings → API Keys.', 'AUTH', status);
    }
    if (status && status >= 400 && status < 500 && status !== 429) {
      throw new GatewayError(said || `Razorpay refused the request (HTTP ${status}).`, 'BAD_REQUEST', status);
    }
    throw new GatewayError(
      status ? `Razorpay is not answering properly just now (HTTP ${status}). Try again in a minute.`
        : 'Razorpay could not be reached. Try again in a minute.',
      'UNAVAILABLE', status
    );
  }

  async createOrder(amountPaise: number, receipt: string, notes: Record<string, string> = {}): Promise<CreatedOrder> {
    if (!Number.isInteger(amountPaise) || amountPaise < MIN_PAISE) {
      throw new GatewayError(`An online payment has to be a whole number of paise and at least ₹1 (got ${amountPaise}).`, 'BAD_REQUEST');
    }
    try {
      const { data } = await this.http.post('/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt: String(receipt).slice(0, 40), // Razorpay's limit
        notes
      });
      if (!str(data?.id) || data.amount !== amountPaise) {
        throw new GatewayError('Razorpay answered with an order that does not match what was asked for.', 'UNAVAILABLE');
      }
      return {
        gatewayOrderId: data.id,
        amountPaise,
        checkoutPayload: { key: this.keyId, order_id: data.id, amount: amountPaise, currency: 'INR' }
      };
    } catch (e) { return this.fail(e); }
  }

  verifyCheckoutSignature({ gatewayOrderId, paymentId, signature }: { gatewayOrderId: string; paymentId: string; signature: string }) {
    if (!gatewayOrderId || !paymentId) return false;
    return sameHex(hmacHex(this.keySecret, `${gatewayOrderId}|${paymentId}`), signature);
  }

  verifyWebhook(rawBody: Buffer | string, signature: string | undefined) {
    // No secret, no trust: a webhook for a shop that has not finished setting up is refused.
    if (!this.webhookSecret) return false;
    return sameHex(hmacHex(this.webhookSecret, rawBody), signature);
  }

  parseWebhook(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): WebhookEvent {
    let body: any;
    try { body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody); } catch {
      throw new GatewayError('That webhook was not JSON.', 'BAD_REQUEST');
    }
    const header = headers['x-razorpay-event-id'];
    const eventId = str(Array.isArray(header) ? header[0] : header);
    const event = str(body?.event) ?? 'unknown';
    const payment = body?.payload?.payment?.entity ?? null;
    const order = body?.payload?.order?.entity ?? null;
    const refund = body?.payload?.refund?.entity ?? null;

    const base: WebhookEvent = {
      kind: 'IGNORED', event, eventId,
      gatewayOrderId: str(payment?.order_id) ?? str(order?.id),
      paymentId: str(payment?.id) ?? str(refund?.payment_id),
      refundId: str(refund?.id),
      amountPaise: paise(payment?.amount) ?? paise(order?.amount_paid) ?? paise(refund?.amount),
      failReason: null,
      qrCodeId: str(body?.payload?.qr_code?.entity?.id)
    };

    switch (event) {
      case 'payment.captured':
      case 'order.paid':
        return { ...base, kind: 'PAID' };
      case 'payment.failed':
        return { ...base, kind: 'FAILED', failReason: str(payment?.error_description) ?? 'The payment did not go through.' };
      case 'refund.processed':
        return { ...base, kind: 'REFUNDED', amountPaise: paise(refund?.amount) ?? base.amountPaise };
      case 'qr_code.credited':
        return { ...base, kind: 'QR_CREDITED' };
      case 'refund.failed':
        return { ...base, kind: 'REFUND_FAILED', amountPaise: paise(refund?.amount) ?? base.amountPaise, failReason: 'Razorpay could not complete the refund.' };
      default:
        return base;
    }
  }

  async createUpiQr(amountPaise: number, opts: { name: string; closeBy: Date; description?: string; notes?: Record<string, string> }): Promise<CreatedUpiQr> {
    if (!Number.isInteger(amountPaise) || amountPaise < MIN_PAISE) {
      throw new GatewayError(`A UPI QR has to be for a whole number of paise and at least ₹1 (got ${amountPaise}).`, 'BAD_REQUEST');
    }
    try {
      const { data } = await this.http.post('/payments/qr_codes', {
        type: 'upi_qr', usage: 'single_use', fixed_amount: true, payment_amount: amountPaise,
        name: opts.name.slice(0, 40), description: opts.description?.slice(0, 100),
        close_by: Math.floor(opts.closeBy.getTime() / 1000), notes: opts.notes ?? {}
      });
      const qrId = str(data?.id);
      const imageUrl = str(data?.image_url);
      if (!qrId || !imageUrl) throw new GatewayError('Razorpay made the QR but did not say where it is.', 'UNAVAILABLE');
      return { qrId, imageUrl };
    } catch (e) { this.fail(e); }
  }

  async upiQrPayments(qrId: string): Promise<UpiQrPayment[]> {
    try {
      const { data } = await this.http.get(`/payments/qr_codes/${encodeURIComponent(qrId)}/payments`);
      return (data?.items ?? []).map((p: any) => ({
        paymentId: String(p.id),
        amountPaise: Number(p.amount),
        status: p.status === 'captured' ? 'CAPTURED' : p.status === 'authorized' ? 'AUTHORIZED' : p.status === 'failed' ? 'FAILED' : 'OTHER',
        utr: str(p.acquirer_data?.rrn) ?? str(p.acquirer_data?.upi_transaction_id),
        paidAt: Number.isFinite(Number(p.created_at)) ? new Date(Number(p.created_at) * 1000) : null
      }));
    } catch (e) { this.fail(e); }
  }

  async closeUpiQr(qrId: string): Promise<void> {
    try {
      await this.http.post(`/payments/qr_codes/${encodeURIComponent(qrId)}/close`);
    } catch (e) {
      // Already closed (by its close_by, or an earlier call): the outcome wanted is the outcome there is.
      if ((e as AxiosError)?.response?.status === 400) return;
      this.fail(e);
    }
  }

  async refund(paymentId: string, amountPaise: number, reason: string, ref?: string): Promise<RefundResult> {
    if (!str(paymentId)) throw new GatewayError('A refund needs the payment it is for.', 'BAD_REQUEST');
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new GatewayError(`A refund has to be a whole, positive number of paise (got ${amountPaise}).`, 'BAD_REQUEST');
    }
    try {
      const { data } = await this.http.post(`/payments/${encodeURIComponent(paymentId)}/refund`, {
        amount: amountPaise,
        // `speed: normal` is the default and costs the shop nothing extra; instant refunds are a
        // paid Razorpay feature the shop can choose in its own dashboard.
        notes: { reason: String(reason || '').slice(0, 250), ...(ref ? { ref: String(ref).slice(0, 250) } : {}) }
      });
      const s = String(data?.status || '').toLowerCase();
      return {
        refundId: String(data.id),
        status: s === 'processed' ? 'PROCESSED' : s === 'failed' ? 'FAILED' : 'PENDING',
        amountPaise: paise(data?.amount) ?? amountPaise
      };
    } catch (e) { return this.fail(e); }
  }

  async paymentsForOrder(gatewayOrderId: string): Promise<GatewayPayment[]> {
    try {
      const { data } = await this.http.get(`/orders/${encodeURIComponent(gatewayOrderId)}/payments`);
      const items: any[] = Array.isArray(data?.items) ? data.items : [];
      const known: Record<string, GatewayPayment['status']> = {
        captured: 'CAPTURED', authorized: 'AUTHORIZED', failed: 'FAILED', refunded: 'REFUNDED', created: 'CREATED'
      };
      return items.map((p) => ({
        paymentId: String(p.id),
        status: known[String(p.status)] ?? 'OTHER',
        amountPaise: paise(p.amount) ?? 0,
        failReason: str(p.error_description)
      }));
    } catch (e) { return this.fail(e); }
  }

  private detail(p: any): GatewayPaymentDetail {
    const known: Record<string, GatewayPaymentDetail['status']> = {
      captured: 'CAPTURED', authorized: 'AUTHORIZED', failed: 'FAILED', refunded: 'REFUNDED', created: 'CREATED'
    };
    if (!str(p?.id)) throw new GatewayError('Razorpay answered without a payment.', 'UNAVAILABLE');
    return {
      paymentId: String(p.id),
      gatewayOrderId: str(p.order_id),
      status: known[String(p.status)] ?? 'OTHER',
      amountPaise: paise(p.amount) ?? 0,
      currency: str(p.currency) ?? 'INR',
      method: str(p.method),
      failReason: str(p.error_description)
    };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPaymentDetail> {
    if (!/^pay_[A-Za-z0-9]{6,40}$/.test(String(paymentId))) {
      throw new GatewayError('That is not a Razorpay payment id.', 'BAD_REQUEST');
    }
    try {
      const { data } = await this.http.get(`/payments/${encodeURIComponent(paymentId)}`);
      return this.detail(data);
    } catch (e) { return this.fail(e); }
  }

  async capture(paymentId: string, amountPaise: number): Promise<GatewayPaymentDetail> {
    if (!Number.isInteger(amountPaise) || amountPaise < MIN_PAISE) {
      throw new GatewayError(`A capture has to be a whole number of paise, at least ₹1 (got ${amountPaise}).`, 'BAD_REQUEST');
    }
    try {
      const { data } = await this.http.post(`/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: 'INR' });
      return this.detail(data);
    } catch (e) { return this.fail(e); }
  }

  async refundsForPayment(paymentId: string): Promise<GatewayRefund[]> {
    try {
      const { data } = await this.http.get(`/payments/${encodeURIComponent(paymentId)}/refunds`);
      const items: any[] = Array.isArray(data?.items) ? data.items : [];
      return items.map((r) => {
        const s = String(r.status || '').toLowerCase();
        return {
          refundId: String(r.id),
          status: s === 'processed' ? 'PROCESSED' : s === 'failed' ? 'FAILED' : 'PENDING',
          amountPaise: paise(r.amount) ?? 0,
          ref: str(r.notes?.ref)
        };
      });
    } catch (e) { return this.fail(e); }
  }

  /**
   * "Check it works".
   *
   * The plan imagined a ₹1 authorisation made and voided on the shop's account. Razorpay cannot do
   * that from keys alone -- only a paying customer can authorise a payment. What keys CAN prove is
   * that Razorpay accepts them: an authenticated read of the account's orders, which costs nothing,
   * creates nothing and fails with a 401 on a wrong pair. Test keys are caught by their prefix
   * before any customer could meet them.
   */
  async check(): Promise<GatewayCheck> {
    try {
      await this.http.get('/orders', { params: { count: 1 } });
    } catch (e) {
      try { this.fail(e); } catch (g) {
        return { ok: false, mode: this.mode, message: (g as GatewayError).message };
      }
    }
    return this.mode === 'LIVE'
      ? { ok: true, mode: 'LIVE', message: `Connected — your Razorpay account, key ${maskKeyId(this.keyId)}.` }
      : { ok: true, mode: 'TEST', message: `These are TEST keys (${maskKeyId(this.keyId)}). Razorpay accepts them, but no real money can be paid with them — switch to your Live keys before customers pay online.` };
  }
}
