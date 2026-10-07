import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import * as posUpiQr from '../pos/pos-upi-qr.service';
import { prisma } from '../../lib/prisma';
import { afterCommit } from '../../lib/afterCommit';
import { OnlineShopRuleError } from '../online-shop/rules';
import {
  checkoutGate, prepareCheckout, orderInputOf, writeOrderInTx, goneMessage, announcePlaced, summary,
  OrderInput, PlaceInput
} from '../online-shop/checkout';
import { orderCancelled } from '../online-shop/notices';
import { fingerprint, toMinor, fromMinor } from '../pricing';
import { notifyStorefrontsOfAvailability } from '../reservation.service';
import { paymentAccounts } from './account.service';
import { GatewayError, GatewayPaymentDetail, PaymentGateway, WebhookEvent, maskKeyId } from './gateway';

/**
 * TAKING MONEY ONLINE (PLAN-online-shop-payments.md).
 *
 * The one rule everything here serves: A PAYMENT IS REAL ONLY WHEN THE GATEWAY SAYS SO, and an order
 * exists only once a payment is real. So:
 *
 *   Pay pressed    the checkout is checked and priced exactly as paying on delivery is; the stock is
 *                  HELD (not an order -- nothing appears in Orders, the Day Book or anybody's
 *                  messages); a Razorpay order is made for OUR figure.
 *   Customer pays  in Razorpay's own checkout. Card numbers and UPI PINs never come near us.
 *   Confirmed      by us asking Razorpay directly with the shop's keys (the browser's handback is
 *                  only the cue to ask), or by Razorpay's signed webhook, or by the sweeper asking
 *                  about a payment whose customer vanished. All three go through settle(), which
 *                  writes the order exactly once.
 *   Not paid       the hold lapses and the stock goes back on sale. Nothing is left behind.
 *
 * EVERY CAPTURED RUPEE ENDS UP AS AN ORDER OR BACK WITH THE CUSTOMER. A payment that arrives after its
 * hold lapsed still becomes an order if the pieces are there; if they went, or the same bag was
 * already paid for, the money is returned automatically -- nobody pays for something they do not get,
 * and nobody has to notice first.
 */

/** How long the pieces are set aside while a customer pays. Razorpay's checkout closes at 15. */
const HOLD_MS = 20 * 60 * 1000;
const CHECKOUT_TIMEOUT_S = 15 * 60;
/** A payment confirmed later than this is too old to honour its price, and is returned. */
const LATE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Addresses and names on payments that never became orders are forgotten after this. */
const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const LIVE = ['STARTING', 'WAITING'];

const now = () => new Date();
const token = () => crypto.randomBytes(24).toString('base64url');
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * One payment per bag at a time.
 *
 * A transaction-scoped advisory lock on (shop, the checkout's key): two taps, two tabs, the webhook
 * and the browser's handback arriving together -- all of them queue here instead of racing. It is
 * released by the transaction ending, so nothing can leave it held.
 */
async function lockBag(tx: any, clientId: string, placementKey: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${clientId}|${placementKey}`}, 0))::text AS locked`;
}

class PaymentRefused extends Error {
  constructor(message: string, readonly details: { code: string; variantId?: string }) { super(message); }
}

/** Set the pieces aside, under the same row locks and in the same order an order's hold uses. */
async function holdStock(tx: any, clientId: string, onlinePaymentId: string, locationId: string, items: OrderInput['items']) {
  for (const item of [...items].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
    const rows = await tx.$queryRaw<any[]>`
      SELECT id, quantity, reserved_qty AS "reservedQty"
      FROM inventory_stocks
      WHERE variant_id = ${item.variantId} AND location_id = ${locationId} AND client_id = ${clientId}
      FOR UPDATE`;
    const free = rows.length ? Math.max(0, rows[0].quantity - rows[0].reservedQty) : 0;
    if (item.quantity > free) {
      throw new PaymentRefused('out of stock', { code: 'OUT_OF_STOCK', variantId: item.variantId });
    }
    await tx.onlinePaymentHold.create({
      data: { clientId, onlinePaymentId, variantId: item.variantId, locationId, quantity: item.quantity }
    });
    await tx.inventoryStock.update({
      where: { variantId_locationId: { variantId: item.variantId, locationId } },
      data: { reservedQty: { increment: item.quantity } }
    });
  }
}

/** Give the pieces back, exactly once: each hold is released and marked in the same statement set. */
async function releaseHolds(tx: any, clientId: string, onlinePaymentId: string): Promise<string[]> {
  const holds = await tx.$queryRaw<any[]>`
    SELECT id, variant_id AS "variantId", location_id AS "locationId", quantity
    FROM online_payment_holds
    WHERE online_payment_id = ${onlinePaymentId} AND client_id = ${clientId} AND released_at IS NULL
    ORDER BY variant_id
    FOR UPDATE`;
  for (const h of holds) {
    await tx.$executeRaw`
      UPDATE inventory_stocks SET reserved_qty = GREATEST(0, reserved_qty - ${h.quantity}), updated_at = now()
      WHERE variant_id = ${h.variantId} AND location_id = ${h.locationId} AND client_id = ${clientId}`;
    await tx.onlinePaymentHold.update({ where: { id: h.id }, data: { releasedAt: now() } });
  }
  return holds.map((h: any) => h.variantId);
}

/** Alert the shop, in the Alert Centre, when a person has to know something about a payment. */
async function tellOwner(clientId: string, severity: 'WARNING' | 'CRITICAL' | 'INFO', title: string, message: string) {
  try {
    await prisma.inventoryAlert.create({ data: { clientId, type: 'ONLINE_ORDER', severity, title, message } });
  } catch (e) {
    console.warn('[payments] could not raise an alert:', (e as Error)?.message);
  }
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0 })}`;

/**
 * The gateway to ask about THIS payment: the shop's current keys, or null if it has none.
 *
 * It used to refuse whenever the key id had changed since the payment. But a shop that regenerates
 * its keys -- the right thing to do after a leak -- keeps the SAME Razorpay account and gets a new
 * key id, and that refusal stranded every payment it had ever taken: no late payment could be
 * confirmed and no past order could be refunded, ever again.
 *
 * Razorpay does the scoping itself. New keys for the same account see its payments and can refund
 * them; keys for a genuinely DIFFERENT account are told the ids do not exist. So asking with the
 * current keys can never confirm or refund against the wrong account -- the worst it can do is fail,
 * and a failed refund tells the owner (see askGatewayToRefund).
 */
async function gatewayOfPayment(row: { clientId: string; keyId: string }): Promise<PaymentGateway | null> {
  return paymentAccounts.gatewayFor(row.clientId);
}

/** Whether the shop has moved to other keys since this payment was taken. */
async function keysChangedSince(row: { clientId: string; keyId: string }): Promise<boolean> {
  const account = await prisma.shopPaymentAccount.findUnique({ where: { clientId: row.clientId }, select: { keyId: true } });
  return !!account && account.keyId !== row.keyId;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PAY
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type StartResult =
  | { state: 'PAY'; token: string; expiresAt: string; checkout: Record<string, unknown> }
  | { state: 'PLACED'; orderToken: string };

/** What Razorpay's checkout is opened with. UPI first: on a saree it is five times cheaper for the shop. */
function checkoutOptions(order: { key: unknown; order_id: unknown; amount: unknown; currency: unknown }, shopName: string, p: OrderInput, accent: string | null) {
  return {
    key: order.key,
    order_id: order.order_id,
    amount: order.amount,
    currency: order.currency,
    name: shopName.slice(0, 60),
    description: `Order from ${shopName}`.slice(0, 100),
    prefill: { name: p.name, contact: p.phone, ...(p.email ? { email: p.email } : {}) },
    timeout: CHECKOUT_TIMEOUT_S,
    retry: { enabled: true },
    ...(accent && /^#[0-9a-f]{6}$/i.test(accent) ? { theme: { color: accent } } : {}),
    config: {
      display: {
        blocks: { upi: { name: 'Pay with UPI', instruments: [{ method: 'upi' }] } },
        sequence: ['block.upi'],
        preferences: { show_default_blocks: true }
      }
    }
  };
}

/**
 * The customer pressed Pay.
 *
 * Everything the browser sends is re-checked and re-priced here; the amount is ours. The same bag
 * pressed twice -- a double tap, a second tab -- is the same payment and the same Razorpay order.
 * The same key with a CHANGED bag is a fresh payment, and the old one is let go -- after asking
 * Razorpay whether it was in fact paid, because a customer paying in another tab is paying.
 */
export async function start(clientId: string, shopName: string, accent: string | null, input: PlaceInput): Promise<StartResult> {
  const { shop, placementKey } = await checkoutGate(clientId, input);

  const placed = await prisma.onlineShopOrder.findUnique({
    where: { clientId_placementKey: { clientId, placementKey } }, select: { token: true }
  });
  if (placed) return { state: 'PLACED', orderToken: placed.token };

  if (!shop.payWays.includes('ONLINE')) {
    throw new OnlineShopRuleError('This shop cannot take payment online just now. Choose to pay when it arrives, or try again later.');
  }
  /*
   * Asked again at the moment of paying, not only when the switch was turned on. Keys go bad later
   * (revoked, or replaced with test keys), and a switch set yesterday says nothing about today. Above
   * all: TEST keys never take a real customer's order -- a test payment is CAPTURED as far as
   * Razorpay's API is concerned, and would write a paid order for money that does not exist.
   */
  const ready = await paymentAccounts.readiness(clientId);
  if (!ready.ready) {
    throw new OnlineShopRuleError('This shop cannot take payment online just now. Choose to pay when it arrives, or try again later.');
  }
  const account = await prisma.shopPaymentAccount.findUnique({ where: { clientId }, select: { keyId: true } });
  const gateway = await paymentAccounts.gatewayFor(clientId);
  if (!account || !gateway) {
    throw new OnlineShopRuleError('This shop cannot take payment online just now. Choose to pay when it arrives, or try again later.');
  }

  const p = await prepareCheckout(clientId, shop, placementKey, { ...input, payWay: 'ONLINE' });
  const orderInput = orderInputOf(p);
  const amountPaise = toMinor(p.bag.total);
  if (!Number.isInteger(amountPaise) || amountPaise < 100) {
    throw new OnlineShopRuleError('Paying online needs an order of at least ₹1.');
  }
  const inputHash = crypto.createHash('sha256').update(JSON.stringify({
    q: fingerprint(p.quoteReq as any), a: amountPaise,
    w: [p.name, p.phone, p.email, p.fullAddress, p.pincode]
  })).digest('hex');

  // Earlier attempts for this bag that are still open. Settled first, outside any lock: asking
  // Razorpay about them is a network call, and nothing should wait on it holding a lock.
  const open = await prisma.onlinePayment.findMany({
    where: { clientId, placementKey, status: { in: LIVE } },
    orderBy: { createdAt: 'desc' }
  });
  for (const old of open) {
    const reusable = old.inputHash === inputHash && old.status === 'WAITING' && old.gatewayOrderId
      && old.keyId === account.keyId && old.holdExpiresAt && old.holdExpiresAt.getTime() - Date.now() > 3 * 60_000;
    if (reusable) {
      return {
        state: 'PAY', token: old.token, expiresAt: old.holdExpiresAt!.toISOString(),
        checkout: checkoutOptions({ key: account.keyId, order_id: old.gatewayOrderId, amount: old.amountPaise, currency: 'INR' }, shopName, (old.checkout as any) ?? orderInput, accent)
      };
    }
    const outcome = await reconcile(old.id);
    if (outcome === 'PAID') {
      const order = await prisma.onlineShopOrder.findUnique({ where: { clientId_placementKey: { clientId, placementKey } }, select: { token: true } });
      if (order) return { state: 'PLACED', orderToken: order.token };
    }
    await letGo(old.id, 'SUPERSEDED');
  }

  // A new attempt: the row, the extended price and the stock hold, together or not at all.
  let row: Prisma.OnlinePaymentGetPayload<{}>;
  try {
    row = await prisma.$transaction(async (tx) => {
      await lockBag(tx, clientId, placementKey);
      // Two taps that both got this far: the second finds the first and uses it.
      const twin = await tx.onlinePayment.findFirst({ where: { clientId, placementKey, inputHash, status: { in: LIVE } } });
      if (twin) return twin;
      // The price is honoured for as long as a late payment could still arrive -- the customer is
      // paying THIS figure, and the order written from it must carry exactly this figure.
      await tx.pricingQuote.update({ where: { id: p.quoteId }, data: { expiresAt: new Date(Date.now() + LATE_WINDOW_MS) } });
      const created = await tx.onlinePayment.create({
        data: {
          clientId, token: token(), placementKey, gateway: 'RAZORPAY', keyId: account.keyId,
          amountPaise, currency: 'INR', status: 'STARTING',
          checkout: orderInput as any, inputHash, quoteId: p.quoteId,
          holdExpiresAt: new Date(Date.now() + HOLD_MS)
        }
      });
      await holdStock(tx, clientId, created.id, p.locationId, p.items);
      return created;
    }, { timeout: 30000, maxWait: 15000 });
  } catch (e: any) {
    if (e instanceof PaymentRefused) {
      throw new OnlineShopRuleError(goneMessage({ details: e.details }, p.items) ?? 'Something in your bag has just been bought by someone else. Refresh the page and try again.');
    }
    throw e;
  }
  notifyStorefrontsOfAvailability(clientId, p.items.map(i => i.variantId));

  // A twin still being set up by the other tap is fine: whichever makes the Razorpay order first
  // claims it below, and the other simply reads what was claimed.
  if (!row.gatewayOrderId) {
    try {
      const created = await gateway.createOrder(amountPaise, `SE-${row.token.slice(0, 12)}`, { shop: shopName.slice(0, 200) });
      const claimed = await prisma.onlinePayment.updateMany({
        where: { id: row.id, status: 'STARTING', gatewayOrderId: null },
        data: { status: 'WAITING', gatewayOrderId: created.gatewayOrderId }
      });
      if (claimed.count === 0) {
        // The other tap made its own order first. Use whatever the row says now.
        row = (await prisma.onlinePayment.findUnique({ where: { id: row.id } }))!;
      } else {
        row = { ...row, status: 'WAITING', gatewayOrderId: created.gatewayOrderId };
      }
    } catch (e) {
      await letGo(row.id, 'NOT_STARTED');
      if (e instanceof GatewayError && e.kind === 'AUTH') {
        // The shop's keys stopped working. Online payment switches itself off; the owner is told.
        await prisma.shopPaymentAccount.updateMany({ where: { clientId, keyId: account.keyId }, data: { status: 'FAILED', checkedAt: now(), checkMessage: e.message } });
        await tellOwner(clientId, 'CRITICAL', 'Online payments stopped', `Razorpay refused your keys when a customer tried to pay: ${e.message} Customers can still order to pay on delivery. Check your keys in Settings → Online shop → Payments.`);
      }
      throw new OnlineShopRuleError('The payment page could not be opened just now. Nothing was charged. Please try again in a minute, or choose to pay when it arrives.');
    }
  }

  if (!row.gatewayOrderId || !LIVE.includes(row.status)) {
    throw new OnlineShopRuleError('The payment page could not be opened just now. Nothing was charged. Please try again.');
  }
  return {
    state: 'PAY', token: row.token, expiresAt: (row.holdExpiresAt ?? new Date(Date.now() + HOLD_MS)).toISOString(),
    checkout: checkoutOptions({ key: account.keyId, order_id: row.gatewayOrderId, amount: row.amountPaise, currency: 'INR' }, shopName, orderInput, accent)
  };
}

/** Let an unpaid attempt go: its stock back on sale, the attempt closed. Only if it is still open. */
async function letGo(onlinePaymentId: string, to: 'EXPIRED' | 'SUPERSEDED' | 'NOT_STARTED') {
  const released = await prisma.$transaction(async (tx) => {
    const row = await tx.onlinePayment.findUnique({ where: { id: onlinePaymentId } });
    if (!row) return null;
    await lockBag(tx, row.clientId, row.placementKey);
    const claimed = await tx.onlinePayment.updateMany({
      where: { id: row.id, status: { in: LIVE } },
      data: { status: to, holdExpiresAt: null }
    });
    if (claimed.count === 0) return null;
    return { clientId: row.clientId, variants: await releaseHolds(tx, row.clientId, row.id) };
  }, { timeout: 30000, maxWait: 15000 });
  if (released?.variants.length) notifyStorefrontsOfAvailability(released.clientId, released.variants);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CONFIRM
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the customer's page shows while it waits. Nothing personal: the token is the only key, and a
 * link that leaked would show a stranger nothing but "paid" or "not yet".
 */
export async function status(clientId: string, rawToken: unknown) {
  const key = str(rawToken);
  const row = key ? await prisma.onlinePayment.findUnique({ where: { token: key } }) : null;
  if (!row || row.clientId !== clientId) throw new OnlineShopRuleError('That payment could not be found.');
  let orderToken: string | null = null;
  if (row.status === 'PAID' && row.salesOrderId) {
    orderToken = (await prisma.onlineShopOrder.findUnique({ where: { salesOrderId: row.salesOrderId }, select: { token: true } }))?.token ?? null;
  }
  const refunds = row.status === 'REFUNDED_BACK' || row.status === 'ATTENTION'
    ? await prisma.onlineRefund.findMany({ where: { onlinePaymentId: row.id }, select: { status: true } }) : [];
  const state =
    row.status === 'PAID' ? 'PAID'
      : LIVE.includes(row.status) ? 'WAITING'
        : row.status === 'REFUNDED_BACK' || row.status === 'ATTENTION' ? 'RETURNED'
          : 'NOT_PAID';
  return {
    state,
    orderToken,
    amount: row.amountPaise / 100,
    lastFailReason: state === 'WAITING' ? row.lastFailReason : null,
    expiresAt: row.holdExpiresAt?.toISOString() ?? null,
    refund: state === 'RETURNED'
      ? (refunds.some(r => r.status === 'PROCESSED') ? 'DONE' : refunds.some(r => r.status === 'FAILED') ? 'SHOP_WILL_CALL' : 'ON_ITS_WAY')
      : null,
    message:
      state === 'PAID' ? 'Paid. Your order is with the shop.'
        : state === 'WAITING' ? 'Waiting for your payment to be confirmed.'
          : state === 'RETURNED' ? 'Your payment arrived, but the order could not be completed, so your money is being returned to you automatically.'
            : 'No payment was taken for this. Your bag is still here if you want to try again.'
  };
}

/**
 * The browser's "paid" handback: order id, payment id and Razorpay's signature over them.
 *
 * A cue, never proof (rule P2). The signature is checked, and then Razorpay is ASKED about the
 * payment with the shop's own keys; only what Razorpay says moves money or makes an order. A forged
 * or replayed handback can at most make us ask Razorpay a question.
 */
export async function confirm(clientId: string, rawToken: unknown, body: any) {
  const key = str(rawToken);
  const row = key ? await prisma.onlinePayment.findUnique({ where: { token: key } }) : null;
  if (!row || row.clientId !== clientId) throw new OnlineShopRuleError('That payment could not be found.');
  if (row.status === 'PAID') return status(clientId, key);

  const orderId = str(body?.razorpay_order_id);
  const paymentId = str(body?.razorpay_payment_id);
  const signature = str(body?.razorpay_signature);
  if (!row.gatewayOrderId || orderId !== row.gatewayOrderId || !/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) {
    throw new OnlineShopRuleError('That payment could not be confirmed. If money was taken, it will be confirmed or returned automatically.');
  }
  const gateway = await gatewayOfPayment(row);
  // The shop changed its Razorpay account in the meantime: the webhook and the sweeper still
  // settle this from the account it was paid into's own word.
  if (!gateway) return status(clientId, key);
  if (!gateway.verifyCheckoutSignature({ gatewayOrderId: orderId, paymentId, signature })) {
    console.warn(`[payments] a handback with a bad signature for payment ${row.id}`);
    throw new OnlineShopRuleError('That payment could not be confirmed. If money was taken, it will be confirmed or returned automatically.');
  }
  try {
    const detail = await gateway.fetchPayment(paymentId);
    await settleFromGateway(row.id, detail, gateway);
  } catch (e) {
    // Razorpay slow to answer is not the customer's problem: the page keeps waiting, and the webhook
    // or the sweeper finishes the job.
    if (!(e instanceof GatewayError)) throw e;
  }
  return status(clientId, key);
}

/**
 * Razorpay has told us about a payment. Captured -> an order (or the money back). Authorised only ->
 * captured first, for an account that captures by hand. Failed -> noted; the customer may retry.
 */
async function settleFromGateway(onlinePaymentId: string, detail: GatewayPaymentDetail, gateway: PaymentGateway): Promise<'PAID' | 'RETURNED' | 'WAITING' | 'IGNORED'> {
  const row = await prisma.onlinePayment.findUnique({ where: { id: onlinePaymentId } });
  if (!row) return 'IGNORED';
  // A payment for a different Razorpay order is not this attempt's, whatever anybody says.
  if (!row.gatewayOrderId || detail.gatewayOrderId !== row.gatewayOrderId) return 'IGNORED';

  let d = detail;
  if (d.status === 'AUTHORIZED') {
    if (d.amountPaise !== row.amountPaise) {
      // Never capture a wrong amount. An authorisation lapses on its own after a few days.
      await markAttention(row.id, d, `An authorised payment of ${rupees(d.amountPaise)} does not match the order's ${rupees(row.amountPaise)}. It was not captured and will lapse by itself.`);
      return 'RETURNED';
    }
    d = await gateway.capture(d.paymentId, row.amountPaise);
  }
  if (d.status === 'FAILED') {
    await prisma.onlinePayment.updateMany({ where: { id: row.id, status: { in: LIVE } }, data: { lastFailReason: (d.failReason ?? 'The payment did not go through.').slice(0, 300) } });
    return 'WAITING';
  }
  if (d.status !== 'CAPTURED') return 'WAITING';

  if (d.currency !== 'INR' || d.amountPaise !== row.amountPaise) {
    await markAttention(row.id, d, `Razorpay captured ${rupees(d.amountPaise)} ${d.currency}, but the order was for ${rupees(row.amountPaise)} INR. No order was made and the payment is being returned in full.`);
    await refundWhole(row.id, d.paymentId, 'AMOUNT_WRONG', 'The amount paid did not match the order', d.amountPaise);
    return 'RETURNED';
  }
  return settle(row.id, d);
}

async function markAttention(onlinePaymentId: string, d: GatewayPaymentDetail, reason: string) {
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.onlinePayment.findUnique({ where: { id: onlinePaymentId } });
    if (!r) return null;
    await lockBag(tx, r.clientId, r.placementKey);
    await tx.onlinePayment.updateMany({
      where: { id: r.id, status: { notIn: ['PAID'] } },
      data: { status: 'ATTENTION', gatewayPaymentId: d.paymentId, method: d.method, attentionReason: reason.slice(0, 500), holdExpiresAt: null }
    });
    const variants = await releaseHolds(tx, r.clientId, r.id);
    return { clientId: r.clientId, variants };
  }, { timeout: 30000, maxWait: 15000 });
  if (row) {
    if (row.variants.length) notifyStorefrontsOfAvailability(row.clientId, row.variants);
    await tellOwner(row.clientId, 'CRITICAL', 'An online payment needs looking at', reason);
  }
}

/**
 * THE ONE PLACE AN ONLINE ORDER IS WRITTEN.
 *
 * Under the bag's lock, in one transaction: the payment's hold is given back and the order takes
 * its own (so no other customer can slip in between), the order is written from the checkout kept
 * on the payment -- never from anything sent since -- and the money is recorded against it.
 * Called by the handback, the webhook and the sweeper alike; whichever comes second finds it done.
 */
async function settle(onlinePaymentId: string, d: GatewayPaymentDetail): Promise<'PAID' | 'RETURNED'> {
  type Outcome =
    | { kind: 'PAID'; clientId: string; orderToken: string; salesOrderId: string; customerId: string; input: OrderInput; released: string[] }
    | { kind: 'ALREADY' }
    | { kind: 'RETURN'; purpose: 'DUPLICATE' | 'PRICE_EXPIRED'; reason: string };

  let outcome: Outcome;
  try {
    outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
      const first = await tx.onlinePayment.findUnique({ where: { id: onlinePaymentId } });
      if (!first) return { kind: 'ALREADY' };
      await lockBag(tx, first.clientId, first.placementKey);
      const [row] = await tx.$queryRaw<any[]>`SELECT * FROM online_payments WHERE id = ${onlinePaymentId} FOR UPDATE`;
      const status = row.status as string;
      if (status === 'PAID' || status === 'REFUNDED_BACK' || status === 'ATTENTION') return { kind: 'ALREADY' };

      // The same bag already paid for -- another tab, or an old attempt paid late: this one goes back.
      const paidTwin = await tx.onlinePayment.findFirst({
        where: { clientId: first.clientId, placementKey: first.placementKey, status: 'PAID', NOT: { id: first.id } }, select: { id: true }
      });
      const orderForBag = await tx.onlineShopOrder.findUnique({
        where: { clientId_placementKey: { clientId: first.clientId, placementKey: first.placementKey } }, select: { id: true }
      });
      if (paidTwin || orderForBag) {
        await tx.onlinePayment.update({
          where: { id: first.id },
          data: { status: 'REFUNDED_BACK', gatewayPaymentId: d.paymentId, method: d.method, holdExpiresAt: null, attentionReason: 'A second payment for a bag that was already paid for. Returned automatically.' }
        });
        await releaseHolds(tx, first.clientId, first.id);
        return { kind: 'RETURN', purpose: 'DUPLICATE', reason: 'This bag had already been paid for, so the second payment was returned.' };
      }

      if (Date.now() - first.createdAt.getTime() > LATE_WINDOW_MS || !first.checkout) {
        await tx.onlinePayment.update({
          where: { id: first.id },
          data: { status: 'REFUNDED_BACK', gatewayPaymentId: d.paymentId, method: d.method, holdExpiresAt: null, attentionReason: 'The payment arrived too long after the order was priced. Returned automatically.' }
        });
        await releaseHolds(tx, first.clientId, first.id);
        return { kind: 'RETURN', purpose: 'PRICE_EXPIRED', reason: 'The payment arrived too long after the order was priced.' };
      }

      const input = first.checkout as unknown as OrderInput;
      const released = await releaseHolds(tx, first.clientId, first.id);
      const orderToken = token();
      const written = await writeOrderInTx(tx, first.clientId, input, {
        token: orderToken, paid: true, holdExpiresAt: null,
        gatewayOrderId: first.gatewayOrderId, gatewayPaymentId: d.paymentId
      });

      // The order must come to exactly what was paid. It always should -- it is written from the
      // same kept price -- and if it ever does not, nothing is half-done: the whole thing rolls back.
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: written.salesOrderId }, select: { total: true } });
      if (toMinor(order.total) !== first.amountPaise) {
        throw new PaymentRefused('amount', { code: 'AMOUNT_MISMATCH' });
      }

      await tx.salesOrderPayment.create({
        data: {
          clientId: first.clientId,
          salesOrderId: written.salesOrderId,
          locationId: input.locationId,
          kind: 'PAYMENT',
          method: 'ONLINE',
          amount: fromMinor(first.amountPaise),
          reference: `Razorpay ${d.paymentId}${d.method ? ` · ${d.method}` : ''}`.slice(0, 120),
          onceKey: `RZP:${d.paymentId}`
        }
      });
      await tx.onlinePayment.update({
        where: { id: first.id },
        data: {
          status: 'PAID', gatewayPaymentId: d.paymentId, method: d.method, salesOrderId: written.salesOrderId,
          paidAt: now(), holdExpiresAt: null, lastFailReason: null
        }
      });
      return { kind: 'PAID', clientId: first.clientId, orderToken, salesOrderId: written.salesOrderId, customerId: written.customerId, input, released };
    }, { timeout: 45000, maxWait: 20000 });
  } catch (e: any) {
    /*
     * Two kinds of failure. A REFUSAL -- the piece has gone, the price cannot be used, the store was
     * closed, the order would not come to what was paid -- will say the same thing every time it is
     * asked, so the customer is refunded now rather than left waiting two days for a retry that
     * cannot work. Anything else (the database busy, a timeout) is left exactly as it was: the
     * payment is still captured, its hold still held, and the sweeper tries again in a minute.
     */
    const gone = goneMessage(e, []);
    const priceGone = /price (is no longer available|has already been used|has expired|was worked out)|basket has changed/i.test(String(e?.message ?? ''));
    const wrongAmount = e instanceof PaymentRefused && e.details.code === 'AMOUNT_MISMATCH';
    const refused = gone || priceGone || wrongAmount || e instanceof OnlineShopRuleError
      || (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500);
    if (!refused) throw e;

    const reason = gone
      ? 'A piece in this order was sold before the payment arrived, so no order was made and the money is being returned in full.'
      : wrongAmount
        ? 'The order would not have come to exactly what was paid, so no order was made and the money is being returned in full.'
        : priceGone
          ? 'The price for this order could no longer be used, so no order was made and the money is being returned in full.'
          : `The order could not be made (${String(e?.message ?? 'refused').slice(0, 160)}), so the money is being returned in full.`;
    const row = await prisma.onlinePayment.findUnique({ where: { id: onlinePaymentId } });
    if (!row) throw e;
    const released = await prisma.$transaction(async (tx) => {
      await lockBag(tx, row.clientId, row.placementKey);
      const claimed = await tx.onlinePayment.updateMany({
        where: { id: row.id, status: { notIn: ['PAID', 'REFUNDED_BACK', 'ATTENTION'] } },
        data: { status: 'REFUNDED_BACK', gatewayPaymentId: d.paymentId, method: d.method, holdExpiresAt: null, attentionReason: reason }
      });
      return claimed.count ? await releaseHolds(tx, row.clientId, row.id) : null;
    }, { timeout: 30000, maxWait: 15000 });
    if (released === null) return 'RETURNED';
    if (released.length) notifyStorefrontsOfAvailability(row.clientId, released);
    await refundWhole(row.id, d.paymentId, gone ? 'STOCK_GONE' : wrongAmount ? 'AMOUNT_WRONG' : priceGone ? 'PRICE_EXPIRED' : 'NOT_MADE', reason);
    await tellOwner(row.clientId, 'WARNING', 'An online payment was returned', `${rupees(row.amountPaise)} (Razorpay ${d.paymentId}): ${reason}`);
    return 'RETURNED';
  }

  if (outcome.kind === 'ALREADY') return 'PAID';
  if (outcome.kind === 'RETURN') {
    const row = await prisma.onlinePayment.findUnique({ where: { id: onlinePaymentId } });
    if (row) {
      await refundWhole(row.id, d.paymentId, outcome.purpose, outcome.reason);
      await tellOwner(row.clientId, 'WARNING', 'An online payment was returned', `${rupees(row.amountPaise)} (Razorpay ${d.paymentId}): ${outcome.reason}`);
    }
    return 'RETURNED';
  }
  notifyStorefrontsOfAvailability(outcome.clientId, outcome.released);
  announcePlaced(outcome.clientId, outcome.orderToken, outcome.salesOrderId, outcome.customerId, outcome.input);
  return 'PAID';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// REFUNDS
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Purpose = 'CANCELLED' | 'DUPLICATE' | 'STOCK_GONE' | 'PRICE_EXPIRED' | 'AMOUNT_WRONG' | 'NOT_MADE' | 'OWNER' | 'RETURN';

/** Refunds of the ORDER's money -- as against a payment that never became the order, returned whole. */
const ORDER_MONEY: Purpose[] = ['CANCELLED', 'OWNER', 'RETURN'];

/**
 * What an order paid online has had back SOME OTHER WAY than through Razorpay: cash, UPI, card or
 * store credit at a return, or what the till recorded. It is the same money. A customer who paid
 * ₹3,600 online and was handed ₹1,800 in cash for a returned piece is owed ₹1,800 more at most,
 * however it goes -- and the Refund button used to offer all ₹3,600 again.
 */
async function givenBackElsewhere(db: any, salesOrderId: string | null): Promise<number> {
  if (!salesOrderId) return 0;
  const sum = await db.salesOrderPayment.aggregate({
    where: { salesOrderId, kind: 'REFUND', method: { notIn: ['ONLINE', 'POINTS'] } }, _sum: { amount: true }
  });
  return sum._sum.amount ? toMinor(sum._sum.amount as any) : 0;
}

/**
 * A return's refund is keyed RETURN:<returnId>, and a retry after a failed one RETURN:<returnId>#2,
 * #3... -- the failed row keeps its key, so asking again must not find it and stop there.
 */
const returnIdOf = (onceKey: unknown): string | null =>
  typeof onceKey === 'string' && onceKey.startsWith('RETURN:') ? onceKey.slice('RETURN:'.length).split('#')[0] : null;

const atTheCounter = (paise: number) => (paise > 0 ? ` (${rupees(paise)} of it was given back at the counter, not through Razorpay)` : '');

/**
 * Everything back. `captured` is what the gateway actually took, when that is not the order's figure
 * -- the refund is always of what was taken, never of what should have been.
 */
async function refundWhole(onlinePaymentId: string, paymentId: string, purpose: Purpose, reason: string, captured?: number) {
  const row = await prisma.onlinePayment.findUnique({ where: { id: onlinePaymentId } });
  if (!row) return;
  await requestRefund({
    onlinePaymentId, purpose, onceKey: `${purpose}:${paymentId}`, reason, requestedById: null,
    amountPaise: null, paymentId, capPaise: captured
  });
}

/**
 * Money back, through the gateway, exactly once.
 *
 * The refund row is written FIRST, under a key that says why ("CANCEL:<order>"), inside a lock on the
 * payment that also checks the total never exceeds what was paid. Only then is the gateway asked, with
 * the row's id written on the refund. If the answer is lost, the sweeper finds that refund at the
 * gateway by its id instead of asking again -- so a timeout can never refund twice.
 */
async function requestRefund(input: {
  onlinePaymentId: string; purpose: Purpose; onceKey: string; reason: string;
  requestedById: string | null;
  /** Null: everything still refundable. */
  amountPaise: number | null;
  /** The payment to refund, when the row does not carry it yet. */
  paymentId?: string;
  /** What was actually captured, when it is not the order's figure. */
  capPaise?: number;
}): Promise<{ refundId: string; status: string; amountPaise: number } | null> {
  const prepared = await prisma.$transaction(async (tx) => {
    // TOUCHED, not just locked -- see claimPayment below for why a lock alone is not enough.
    const [row] = await tx.$queryRaw<any[]>`UPDATE online_payments SET status = status WHERE id = ${input.onlinePaymentId} RETURNING *`;
    if (!row) return null;
    const existing = await tx.onlineRefund.findUnique({ where: { onceKey: input.onceKey } });
    if (existing) return { refund: existing, row, fresh: false };
    const paymentId = row.gateway_payment_id ?? input.paymentId;
    if (!paymentId) throw new OnlineShopRuleError('There is no payment to refund yet.');
    const taken = await tx.onlineRefund.aggregate({
      where: { onlinePaymentId: row.id, status: { not: 'FAILED' } }, _sum: { amountPaise: true }
    });
    const elsewhere = ORDER_MONEY.includes(input.purpose) ? await givenBackElsewhere(tx, row.sales_order_id) : 0;
    const left = (input.capPaise ?? row.amount_paise) - (taken._sum.amountPaise ?? 0) - elsewhere;
    const amount = input.amountPaise ?? left;
    // Nothing left is "refunded in full", whatever was asked for -- not "only ₹0 is left".
    if (left <= 0) throw new OnlineShopRuleError(`This payment has already been refunded in full${atTheCounter(elsewhere)}.`);
    if (!Number.isInteger(amount) || amount <= 0) throw new OnlineShopRuleError('Refund an amount of at least ₹0.01.');
    if (amount > left) {
      throw new OnlineShopRuleError(`Only ${rupees(left)} of this payment is left to refund${atTheCounter(elsewhere)}.`);
    }
    const refund = await tx.onlineRefund.create({
      data: {
        clientId: row.client_id, onlinePaymentId: row.id, salesOrderId: row.sales_order_id,
        purpose: input.purpose, onceKey: input.onceKey, amountPaise: amount, status: 'REQUESTING',
        reason: input.reason.slice(0, 250), requestedById: input.requestedById
      }
    });
    return { refund, row, fresh: true, paymentId };
  }, { timeout: 30000, maxWait: 15000 });
  if (!prepared) return null;
  if (!prepared.fresh) return { refundId: prepared.refund.id, status: prepared.refund.status, amountPaise: prepared.refund.amountPaise };
  await askGatewayToRefund(prepared.refund.id);
  const after = await prisma.onlineRefund.findUniqueOrThrow({ where: { id: prepared.refund.id } });
  return { refundId: after.id, status: after.status, amountPaise: after.amountPaise };
}

/** Ask the gateway for one refund row's money, and record whatever it says. Safe to call again. */
async function askGatewayToRefund(refundRowId: string) {
  const refund = await prisma.onlineRefund.findUnique({ where: { id: refundRowId }, include: { onlinePayment: true } });
  if (!refund || refund.status !== 'REQUESTING') return;
  const pay = refund.onlinePayment;
  const paymentId = pay.gatewayPaymentId;
  const gateway = await gatewayOfPayment(pay);
  if (!paymentId || !gateway) {
    await failRefund(refund.id, pay.clientId, gateway
      ? 'There is no payment on this to refund.'
      : `No Razorpay account is connected any more, so this could not be refunded automatically. Refund it from the Razorpay dashboard of the account that took it (${maskKeyId(pay.keyId)}).`);
    return;
  }
  // Already asked before, and the answer lost? Then the gateway has it under our id.
  try {
    const known = (await gateway.refundsForPayment(paymentId)).find(r => r.ref === refund.id);
    if (known) { await recordRefund(refund.id, known.refundId, known.status); return; }
  } catch (e) {
    if (e instanceof GatewayError && e.transient) return; // try again on the next sweep
  }
  try {
    const r = await gateway.refund(paymentId, refund.amountPaise, refund.reason ?? refund.purpose, refund.id);
    await recordRefund(refund.id, r.refundId, r.status);
  } catch (e) {
    if (e instanceof GatewayError && !e.transient) {
      // The likeliest reason for a refusal after a key change is that the new keys belong to a
      // different Razorpay account -- which cannot see this payment. Say THAT, not Razorpay's
      // "the id provided does not exist", which reads as if the payment never happened.
      const moved = await keysChangedSince(pay);
      await failRefund(refund.id, pay.clientId, moved
        ? `This payment was taken on the Razorpay account your earlier keys belonged to (${maskKeyId(pay.keyId)}), and the keys connected now cannot refund it. Refund it from that account's Razorpay dashboard.`
        : e.message);
      return;
    }
    // Lost in transit: left REQUESTING; the sweeper asks again, by our id first.
  }
}

async function failRefund(refundRowId: string, clientId: string, why: string) {
  const r = await prisma.onlineRefund.update({ where: { id: refundRowId }, data: { status: 'FAILED', failReason: why.slice(0, 500) } });
  const reopened = await reopenReturnOf(r.onceKey);
  await tellOwner(clientId, 'CRITICAL', 'An online refund did not go through',
    `${rupees(r.amountPaise)} could not be returned through Razorpay: ${why} The customer has NOT been refunded -- ${reopened
      ? `return ${reopened} is marked as still owing them, so record how you give it back on that return.`
      : 'please refund them from your Razorpay dashboard or in person.'}`);
}

/**
 * A return whose Razorpay refund failed goes back to owing the money. It was marked paid back when
 * the refund was asked for; left like that, the Returns screen says "paid back" to a customer who
 * got nothing, and offers no way to give it back another way. Returns the return's number.
 */
async function reopenReturnOf(onceKey: string): Promise<string | null> {
  const id = returnIdOf(onceKey);
  if (!id) return null;
  // A later attempt for the same return still going (or done): this old failure changes nothing.
  const alive = await prisma.onlineRefund.findMany({ where: { onceKey: { startsWith: `RETURN:${id}` }, status: { not: 'FAILED' } }, select: { onceKey: true } });
  if (alive.some(x => returnIdOf(x.onceKey) === id)) return null;
  const done = await prisma.salesReturn.updateMany({
    where: { id, refundStatus: 'REFUNDED', refundMethod: 'ONLINE' },
    data: { refundStatus: 'PENDING', refundMethod: null, refundedAt: null, refundedById: null }
  });
  if (!done.count) return null;
  return (await prisma.salesReturn.findUnique({ where: { id }, select: { returnNumber: true } }))?.returnNumber ?? null;
}

/**
 * The gateway's answer about a refund. The books hear about it only once the money has actually gone:
 * a PROCESSED refund becomes a SalesOrderPayment REFUND, once, under the gateway's own refund id.
 */
async function recordRefund(refundRowId: string, gatewayRefundId: string, gatewayStatus: 'PROCESSED' | 'PENDING' | 'FAILED') {
  const changed = await prisma.$transaction(async (tx) => {
    const [r] = await tx.$queryRaw<any[]>`SELECT * FROM online_refunds WHERE id = ${refundRowId} FOR UPDATE`;
    if (!r || r.status === 'PROCESSED' || r.status === 'FAILED') return false;
    await tx.onlineRefund.update({
      where: { id: refundRowId },
      data: {
        gatewayRefundId, status: gatewayStatus,
        ...(gatewayStatus === 'PROCESSED' ? { processedAt: now() } : {}),
        ...(gatewayStatus === 'FAILED' ? { failReason: 'Razorpay could not complete the refund.' } : {})
      }
    });
    if (gatewayStatus === 'PROCESSED' && r.sales_order_id) {
      const order = await tx.salesOrder.findUnique({ where: { id: r.sales_order_id }, select: { locationId: true } });
      if (order) {
        await tx.salesOrderPayment.upsert({
          where: { onceKey: `RZP_REFUND:${gatewayRefundId}` },
          update: {},
          create: {
            clientId: r.client_id, salesOrderId: r.sales_order_id, locationId: order.locationId,
            kind: 'REFUND', method: 'ONLINE', amount: fromMinor(r.amount_paise),
            reference: `Razorpay refund ${gatewayRefundId}`.slice(0, 120),
            onceKey: `RZP_REFUND:${gatewayRefundId}`,
            salesReturnId: returnIdOf(r.once_key)
          }
        });
      }
    }
    return true;
  }, { timeout: 30000, maxWait: 15000 });
  if (gatewayStatus === 'FAILED' && changed) {
    const r = await prisma.onlineRefund.findUnique({ where: { id: refundRowId } });
    const reopened = r ? await reopenReturnOf(r.onceKey) : null;
    if (r) await tellOwner(r.clientId, 'CRITICAL', 'An online refund did not go through',
      `${rupees(r.amountPaise)} could not be returned through Razorpay. The customer has NOT been refunded -- ${reopened
        ? `return ${reopened} is marked as still owing them, so record how you give it back on that return.`
        : 'please refund them from your Razorpay dashboard or in person.'}`);
  }
}

/**
 * An order paid online was cancelled -- by the customer on their page, or by the shop. The money goes
 * back automatically, in full, once. Nothing to do for an order that was not paid online.
 */
export async function refundCancelledOrder(clientId: string, salesOrderId: string, requestedById: string | null) {
  const pay = await prisma.onlinePayment.findFirst({ where: { clientId, salesOrderId, status: 'PAID' } });
  if (!pay) return null;
  const order = await prisma.salesOrder.findFirst({ where: { clientId, id: salesOrderId }, select: { status: true } });
  // Only a whole cancellation. An order closed short after part of it went out keeps what was sent;
  // the rest is the owner's to refund, with the amount they choose.
  if (order?.status !== 'CANCELLED') return null;
  return requestRefund({
    onlinePaymentId: pay.id, purpose: 'CANCELLED', onceKey: `CANCEL:${salesOrderId}`,
    reason: 'Order cancelled', requestedById, amountPaise: null
  });
}

/**
 * Called after EVERY cancellation, from wherever it came: the customer's page, the shop's Orders
 * screen, a hold that lapsed. Money back if the order was paid online; nothing otherwise.
 *
 * It was never called at all. refundCancelledOrder existed and nothing reached it, so a customer who
 * paid online and then cancelled -- on a page that said their order was cancelled -- kept waiting
 * for money that nobody had asked Razorpay to send.
 *
 * Never throws: the order IS cancelled by the time this runs, and a refund that could not even be
 * requested must reach the owner as an alert, not unwind the cancel or show the customer an error.
 */
export async function afterCancelled(clientId: string, salesOrderId: string, requestedById: string | null) {
  try {
    return await refundCancelledOrder(clientId, salesOrderId, requestedById);
  } catch (e) {
    // "Already refunded in full" and its kind: nothing is owed, so nothing is wrong.
    if (e instanceof OnlineShopRuleError) return null;
    console.warn('[payments] a cancelled order could not be refunded:', (e as Error)?.message);
    const pay = await prisma.onlinePayment.findFirst({ where: { clientId, salesOrderId, status: 'PAID' }, select: { amountPaise: true, gatewayPaymentId: true } }).catch(() => null);
    if (pay) {
      await tellOwner(clientId, 'CRITICAL', 'A cancelled order was not refunded',
        `An order paid online (${rupees(pay.amountPaise)}, Razorpay ${pay.gatewayPaymentId ?? 'payment'}) was cancelled, but the refund could not be started. The customer has NOT been refunded -- refund them from the order's payment in Settings → Online shop → Payments, or from your Razorpay dashboard.`);
    }
    return null;
  }
}

/** The customer's own cancel, which knows its order by the link's token rather than by id. */
export async function afterCancelledByToken(clientId: string, orderToken: unknown) {
  const key = typeof orderToken === 'string' ? orderToken.trim() : '';
  if (!key) return null;
  const row = await prisma.onlineShopOrder.findUnique({ where: { token: key }, select: { clientId: true, salesOrderId: true } });
  if (!row || row.clientId !== clientId) return null;
  return afterCancelled(clientId, row.salesOrderId, null);
}

/** The owner returning some or all of a payment, e.g. for a return. Amount in rupees, as typed. */
export async function refundByOwner(clientId: string, userId: string | null, input: { salesOrderId?: unknown; amount?: unknown; reason?: unknown; requestKey?: unknown }) {
  const salesOrderId = str(input.salesOrderId);
  const requestKey = str(input.requestKey);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(requestKey)) throw new OnlineShopRuleError('Refresh the page and try the refund again.');
  const amountText = String(input.amount ?? '').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(amountText)) throw new OnlineShopRuleError('Write the amount to refund in rupees, for example 2500 or 2500.50.');
  const amountPaise = toMinor(amountText);
  const reason = str(input.reason).slice(0, 200) || 'Refund';
  const pay = await prisma.onlinePayment.findFirst({ where: { clientId, salesOrderId, status: 'PAID' } });
  if (!pay) throw new OnlineShopRuleError('That order was not paid online, so there is nothing to refund here.');
  return requestRefund({
    onlinePaymentId: pay.id, purpose: 'OWNER', onceKey: `OWNER:${clientId}:${requestKey}`, reason,
    requestedById: userId, amountPaise
  });
}

/**
 * How much of an order's online payment is still the customer's to get back -- with the payment row
 * LOCKED for the rest of the caller's transaction, so a return and an owner's refund (or two
 * returns) cannot both see the same money as still there. Null when the order was not paid online:
 * the counter's own rules apply to it unchanged.
 */
export async function roomToGiveBack(tx: any, clientId: string, salesOrderId: string, claim = true) {
  const [row] = claim ? await claimPayment(tx, clientId, salesOrderId) : await tx.$queryRaw`
    SELECT id, amount_paise FROM online_payments
    WHERE client_id = ${clientId} AND sales_order_id = ${salesOrderId} AND status = 'PAID'
    ORDER BY created_at LIMIT 1`;
  if (!row) return null;
  const taken = await tx.onlineRefund.aggregate({ where: { onlinePaymentId: row.id, status: { not: 'FAILED' } }, _sum: { amountPaise: true } });
  const paidPaise = Number(row.amount_paise);
  const onlineBackPaise = taken._sum.amountPaise ?? 0;
  const elsewherePaise = await givenBackElsewhere(tx, salesOrderId);
  return {
    onlinePaymentId: row.id as string, paidPaise, onlineBackPaise, elsewherePaise,
    leftPaise: Math.max(0, paidPaise - onlineBackPaise - elsewherePaise)
  };
}

/**
 * Take the order's payment row for this transaction by WRITING it (a no-op update), not merely with
 * FOR UPDATE.
 *
 * A counter return runs SERIALIZABLE, so it reads the database as it stood when it began. Had it only
 * waited on a lock, it could get the lock after an owner's refund committed and still count the
 * refunds as they were before it -- and give the same money back again. A lock leaves no trace;
 * an update does: a serializable transaction that finds the row changed since it began is aborted
 * (40001) and runTransaction starts it again, this time seeing the refund.
 */
async function claimPayment(tx: any, clientId: string, salesOrderId: string): Promise<any[]> {
  return tx.$queryRaw`
    UPDATE online_payments SET status = status
    WHERE id = (
      SELECT id FROM online_payments
      WHERE client_id = ${clientId} AND sales_order_id = ${salesOrderId} AND status = 'PAID'
      ORDER BY created_at LIMIT 1
    )
    RETURNING id, amount_paise`;
}

/**
 * A return's money, sent back through Razorpay to however the customer paid.
 *
 * Written INSIDE the return's transaction, under RETURN:<returnId>, so the return and its refund
 * stand or fall together -- a return that rolls back leaves no refund behind, and a refund is never
 * asked for a return that was not saved. Razorpay is asked once that transaction commits; if the
 * answer is lost, or the server stops first, the sweeper asks again, by our id first, so it is
 * never paid twice.
 */
export async function refundForReturn(tx: any, input: {
  clientId: string; salesOrderId: string; returnId: string; returnNumber: string; amountPaise: number; requestedById: string | null;
}) {
  const room = await roomToGiveBack(tx, input.clientId, input.salesOrderId);
  if (!room) throw new OnlineShopRuleError('This bill was not paid online. Give the money back another way.');
  const earlier = await tx.onlineRefund.findMany({ where: { onceKey: { startsWith: `RETURN:${input.returnId}` } }, orderBy: { createdAt: 'desc' } });
  const standing = earlier.find((x: any) => x.status !== 'FAILED' && returnIdOf(x.onceKey) === input.returnId);
  if (standing) return standing;
  const onceKey = `RETURN:${input.returnId}${earlier.length ? `#${earlier.length + 1}` : ''}`;
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw new OnlineShopRuleError('There is no money to send back for this return.');
  if (input.amountPaise > room.leftPaise) {
    throw new OnlineShopRuleError(room.leftPaise <= 0
      ? `Everything paid online for this bill has already been given back${atTheCounter(room.elsewherePaise)}.`
      : `Only ${rupees(room.leftPaise)} of what was paid online is left to give back${atTheCounter(room.elsewherePaise)}, and this return comes to ${rupees(input.amountPaise)}.`);
  }
  const refund = await tx.onlineRefund.create({
    data: {
      clientId: input.clientId, onlinePaymentId: room.onlinePaymentId, salesOrderId: input.salesOrderId,
      purpose: 'RETURN', onceKey, amountPaise: input.amountPaise, status: 'REQUESTING',
      reason: `Return ${input.returnNumber}`.slice(0, 250), requestedById: input.requestedById
    }
  });
  afterCommit(() => {
    askGatewayToRefund(refund.id).catch(e => console.warn('[payments] a return refund will be retried by the sweeper:', (e as Error)?.message));
  });
  return refund;
}

/** How a return's online refund stands, for the screen that just finished it. */
export async function refundOfReturn(clientId: string, returnId: string) {
  const r = await prisma.onlineRefund.findFirst({ where: { clientId, onceKey: { startsWith: `RETURN:${returnId}` } }, orderBy: { createdAt: 'desc' } });
  if (!r || returnIdOf(r.onceKey) !== returnId) return null;
  return { amount: r.amountPaise / 100, status: r.status, failReason: r.failReason };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WEBHOOKS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A signed event from the gateway, already verified and stored by the route. What it changes:
 * PAID settles (after asking the gateway for the payment itself), FAILED notes the reason, REFUNDED
 * and REFUND_FAILED settle a refund. Anything that is not ours -- the shop may use the same Razorpay
 * account for other things -- is ignored.
 */
export async function applyWebhook(clientId: string, gateway: PaymentGateway, ev: WebhookEvent): Promise<'APPLIED' | 'IGNORED'> {
  // A UPI QR at the POS till was paid (pos-upi-qr.service). Its payment.captured carries no order, so
  // it is ignored below; this event is the one that counts.
  if (ev.kind === 'QR_CREDITED') return posUpiQr.onQrCredited(clientId, ev.qrCodeId);
  if (ev.kind === 'PAID' || ev.kind === 'FAILED') {
    if (!ev.gatewayOrderId || !ev.paymentId) return 'IGNORED';
    const row = await prisma.onlinePayment.findFirst({ where: { clientId, gatewayOrderId: ev.gatewayOrderId } });
    if (!row) return 'IGNORED';
    const g = await gatewayOfPayment(row);
    if (!g) return 'IGNORED';
    const detail = await g.fetchPayment(ev.paymentId);
    const out = await settleFromGateway(row.id, detail, g);
    return out === 'IGNORED' ? 'IGNORED' : 'APPLIED';
  }
  if (ev.kind === 'REFUNDED' || ev.kind === 'REFUND_FAILED') {
    if (!ev.refundId) return 'IGNORED';
    let refund = await prisma.onlineRefund.findFirst({ where: { clientId, gatewayRefundId: ev.refundId } });
    if (!refund && ev.paymentId) {
      // The refund's answer was lost; find it by payment and match by what the gateway knows.
      const pay = await prisma.onlinePayment.findFirst({ where: { clientId, gatewayPaymentId: ev.paymentId } });
      if (pay) {
        const known = (await gateway.refundsForPayment(ev.paymentId)).find(r => r.refundId === ev.refundId);
        if (known?.ref) refund = await prisma.onlineRefund.findFirst({ where: { id: known.ref, clientId } });
      }
    }
    if (!refund) return 'IGNORED';
    await recordRefund(refund.id, ev.refundId, ev.kind === 'REFUNDED' ? 'PROCESSED' : 'FAILED');
    return 'APPLIED';
  }
  return 'IGNORED';
}

/**
 * A webhook delivery, as it arrives: find the shop by the token in the address, check Razorpay's
 * signature over the RAW bytes, keep the delivery, and say what to answer.
 *
 * Kept FIRST and answered at once; the work happens after (see processReceipt). Razorpay wants a 2xx
 * within about five seconds and retries otherwise, and settling a payment -- asking Razorpay about
 * it, writing the order -- can take longer than that against a database in another city. Answering
 * after the work turned every slow settle into a retry storm. A delivery whose work then fails is
 * picked up again by the sweeper, so nothing depends on Razorpay retrying.
 *
 * What is refused: an address that names no shop (404, nothing kept -- anyone can knock); a bad
 * signature (400, kept WITHOUT its event id, so a forged delivery can never occupy the slot the real
 * event with that id needs).
 */
export async function receiveWebhook(tokenRaw: unknown, raw: Buffer, headers: Record<string, any>):
  Promise<{ status: number; body: Record<string, unknown>; receiptId?: string }> {
  const found = await paymentAccounts.byWebhookToken(typeof tokenRaw === 'string' ? tokenRaw : '');
  if (!found) return { status: 404, body: { ok: false } };
  const { clientId, gateway } = found;

  const sigHeader = headers['x-razorpay-signature'];
  const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  const valid = gateway.verifyWebhook(raw, typeof signature === 'string' ? signature : undefined);

  if (!valid) {
    await prisma.gatewayWebhookReceipt.create({
      data: {
        clientId, gateway: 'RAZORPAY', eventId: null, event: null, signatureValid: false,
        // Bounded: an unauthenticated body is not worth more than this, and a flood of them must not
        // fill the table.
        rawBody: raw.toString('utf8').slice(0, 4000),
        outcome: 'BAD_SIGNATURE', processedAt: now()
      }
    }).catch(() => undefined);
    await warnAboutSignatures(clientId);
    return { status: 400, body: { ok: false } };
  }

  let ev: WebhookEvent;
  try { ev = gateway.parseWebhook(raw, headers); } catch {
    return { status: 400, body: { ok: false } };
  }

  try {
    const receipt = await prisma.gatewayWebhookReceipt.create({
      data: {
        clientId, gateway: 'RAZORPAY', eventId: ev.eventId, event: ev.event, signatureValid: true,
        rawBody: raw.toString('utf8').slice(0, 64000)
      }
    });
    return { status: 200, body: { ok: true }, receiptId: receipt.id };
  } catch (e) {
    // The same event delivered again. Done already: say so. Kept but not yet done (an earlier
    // attempt failed, or is still running): hand it back so it is tried -- settling is idempotent.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && ev.eventId) {
      const earlier = await prisma.gatewayWebhookReceipt.findFirst({
        where: { gateway: 'RAZORPAY', clientId, eventId: ev.eventId }, select: { id: true, processedAt: true }
      });
      if (earlier?.processedAt) return { status: 200, body: { ok: true, duplicate: true } };
      return { status: 200, body: { ok: true }, receiptId: earlier?.id };
    }
    throw e;
  }
}

/**
 * Do what a kept delivery says. Records the outcome on the receipt; an error is recorded too and
 * the receipt stays undone, so the sweeper tries it again. Never throws.
 */
export async function processReceipt(receiptId: string): Promise<void> {
  const receipt = await prisma.gatewayWebhookReceipt.findUnique({ where: { id: receiptId } });
  if (!receipt || receipt.processedAt || !receipt.signatureValid || !receipt.clientId) return;
  try {
    const gateway = await paymentAccounts.gatewayFor(receipt.clientId);
    if (!gateway) {
      await prisma.gatewayWebhookReceipt.update({ where: { id: receipt.id }, data: { outcome: 'NO_ACCOUNT', processedAt: now() } });
      return;
    }
    // Parsed again from what was kept, never from anything that arrived since.
    const ev = gateway.parseWebhook(receipt.rawBody, { 'x-razorpay-event-id': receipt.eventId ?? undefined });
    const outcome = await applyWebhook(receipt.clientId, gateway, ev);
    await prisma.gatewayWebhookReceipt.update({ where: { id: receipt.id }, data: { outcome, processedAt: now(), error: null } });
  } catch (e) {
    await prisma.gatewayWebhookReceipt.update({
      where: { id: receipt.id }, data: { error: String((e as Error)?.message ?? e).slice(0, 500) }
    }).catch(() => undefined);
  }
}

/**
 * Deliveries failing their signature check mean the webhook secret in Razorpay's dashboard is not the
 * one we gave -- every payment confirmation is then being thrown away, and only the sweeper is
 * catching them, late. Told to the owner, at most every six hours: anyone who knows the address can
 * send bad deliveries, and that must not become a way to flood the Alert Centre.
 */
async function warnAboutSignatures(clientId: string) {
  const recent = await prisma.inventoryAlert.findFirst({
    where: { clientId, title: 'Razorpay webhooks are being refused', createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } },
    select: { id: true }
  }).catch(() => null);
  if (recent) return;
  await tellOwner(clientId, 'WARNING', 'Razorpay webhooks are being refused',
    'Deliveries to your webhook address are failing their signature check, so payment confirmations may be slow. ' +
    'In Settings → Online shop → Payments, make a new webhook secret and paste it into the webhook in your Razorpay dashboard.');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SWEEPER
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ask the gateway about one attempt and act: paid -> settle; otherwise, if its hold has lapsed, let
 * it go. Used by the sweeper and by a fresh Pay for the same bag.
 */
export async function reconcile(onlinePaymentId: string): Promise<'PAID' | 'RETURNED' | 'WAITING' | 'LET_GO' | 'UNKNOWN'> {
  const row = await prisma.onlinePayment.findUnique({ where: { id: onlinePaymentId } });
  if (!row) return 'UNKNOWN';
  if (row.gatewayOrderId) {
    const gateway = await gatewayOfPayment(row);
    if (gateway) {
      try {
        const attempts = await gateway.paymentsForOrder(row.gatewayOrderId);
        const good = attempts.find(a => a.status === 'CAPTURED') ?? attempts.find(a => a.status === 'AUTHORIZED');
        if (good) {
          const detail = await gateway.fetchPayment(good.paymentId);
          const out = await settleFromGateway(row.id, detail, gateway);
          if (out === 'PAID' || out === 'RETURNED') return out;
        }
      } catch (e) {
        if (!(e instanceof GatewayError)) throw e;
        // Could not ask: never let a hold go on a payment whose fate is unknown, unless it is long gone.
        if (!row.holdExpiresAt || row.holdExpiresAt.getTime() > Date.now() - 60 * 60_000) return 'UNKNOWN';
      }
    } else if (row.holdExpiresAt && row.holdExpiresAt.getTime() > Date.now() - 60 * 60_000) {
      // The shop moved to another account. Give the old one's webhook an hour before letting go.
      return 'UNKNOWN';
    }
  }
  if (LIVE.includes(row.status) && (!row.holdExpiresAt || row.holdExpiresAt <= now()
      || (row.status === 'STARTING' && Date.now() - row.createdAt.getTime() > 2 * 60_000))) {
    await letGo(row.id, row.gatewayOrderId ? 'EXPIRED' : 'NOT_STARTED');
    return 'LET_GO';
  }
  return 'WAITING';
}

/**
 * Once a minute. Everything here is safe to run on two servers at once.
 *
 * `onlyClients` keeps it to named shops. A developer's machine shares the production database, and
 * a sweeper started there with no scope would let go of real customers' stock holds and ask real
 * shops' Razorpay accounts for refunds -- from a laptop.
 */
export async function sweep(limit = 50, onlyClients?: string[]) {
  const done = { expired: 0, late: 0, refunds: 0, forgotten: 0, stray: 0, webhooks: 0 };
  const scope = onlyClients?.length ? { clientId: { in: onlyClients } } : {};

  // 1. Holds that have run out: paid after all, or let go.
  const due = await prisma.onlinePayment.findMany({
    where: { ...scope, status: { in: LIVE }, OR: [{ holdExpiresAt: { lte: now() } }, { holdExpiresAt: null }] },
    select: { id: true }, take: limit
  });
  for (const r of due) {
    try { const out = await reconcile(r.id); if (out === 'LET_GO') done.expired++; } catch (e) { console.warn('[payments] sweep:', (e as Error)?.message); }
  }

  // 2. Payments that arrived after the hold lapsed (a slow UPI approval): looked for every ten
  //    minutes for two days.
  const late = await prisma.onlinePayment.findMany({
    where: {
      ...scope,
      status: { in: ['EXPIRED', 'SUPERSEDED'] }, gatewayOrderId: { not: null },
      createdAt: { gte: new Date(Date.now() - LATE_WINDOW_MS) },
      updatedAt: { lte: new Date(Date.now() - 10 * 60_000) }
    },
    select: { id: true }, take: limit
  });
  for (const r of late) {
    try {
      const row = await prisma.onlinePayment.findUnique({ where: { id: r.id } });
      const gateway = row ? await gatewayOfPayment(row) : null;
      if (row && gateway && row.gatewayOrderId) {
        const attempts = await gateway.paymentsForOrder(row.gatewayOrderId);
        const good = attempts.find(a => a.status === 'CAPTURED') ?? attempts.find(a => a.status === 'AUTHORIZED');
        if (good) { await settleFromGateway(row.id, await gateway.fetchPayment(good.paymentId), gateway); done.late++; }
      }
      await prisma.onlinePayment.update({ where: { id: r.id }, data: { updatedAt: now() } });
    } catch (e) { console.warn('[payments] late sweep:', (e as Error)?.message); }
  }

  // 3. Refunds whose answer never came, or that are settling at the gateway.
  const refunds = await prisma.onlineRefund.findMany({
    where: {
      ...scope,
      OR: [
        { status: 'REQUESTING', updatedAt: { lte: new Date(Date.now() - 60_000) } },
        { status: 'PENDING', updatedAt: { lte: new Date(Date.now() - 10 * 60_000) } }
      ]
    },
    include: { onlinePayment: true }, take: limit
  });
  for (const r of refunds) {
    try {
      if (r.status === 'REQUESTING') { await askGatewayToRefund(r.id); done.refunds++; }
      else {
        const gateway = await gatewayOfPayment(r.onlinePayment);
        if (gateway && r.onlinePayment.gatewayPaymentId && r.gatewayRefundId) {
          const known = (await gateway.refundsForPayment(r.onlinePayment.gatewayPaymentId)).find(x => x.refundId === r.gatewayRefundId);
          if (known && known.status !== 'PENDING') { await recordRefund(r.id, known.refundId, known.status); done.refunds++; }
          else await prisma.onlineRefund.update({ where: { id: r.id }, data: { updatedAt: now() } });
        }
      }
    } catch (e) { console.warn('[payments] refund sweep:', (e as Error)?.message); }
  }

  // 4. Forget the name and address on payments that never became orders, after a month.
  const forgotten = await prisma.onlinePayment.updateMany({
    where: { ...scope, status: { notIn: ['PAID', ...LIVE] }, createdAt: { lte: new Date(Date.now() - FORGET_AFTER_MS) }, NOT: { checkout: { equals: Prisma.DbNull } } },
    data: { checkout: Prisma.DbNull }
  });
  done.forgotten = forgotten.count;

  // 5. A safety net: a hold still counted against stock on a payment that is finished.
  const stray = await prisma.onlinePaymentHold.findMany({
    where: { ...scope, releasedAt: null, onlinePayment: { status: { notIn: LIVE } } }, select: { onlinePaymentId: true, clientId: true }, take: limit
  });
  for (const s of [...new Map(stray.map(x => [x.onlinePaymentId, x])).values()]) {
    const variants = await prisma.$transaction((tx) => releaseHolds(tx, s.clientId, s.onlinePaymentId));
    if (variants.length) { done.stray++; notifyStorefrontsOfAvailability(s.clientId, variants); }
  }

  // 6. Webhook deliveries that were kept but whose work failed -- the route answered Razorpay at
  //    once, so Razorpay will not send them again; this is the retry. Settling is idempotent.
  const undone = await prisma.gatewayWebhookReceipt.findMany({
    where: {
      ...scope, signatureValid: true, processedAt: null,
      createdAt: { lte: new Date(Date.now() - 60_000), gte: new Date(Date.now() - LATE_WINDOW_MS) }
    },
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: 20
  });
  for (const r of undone) { await processReceipt(r.id); done.webhooks++; }

  // 7. Old deliveries. Good ones are the record a disputed payment is answered from, so a year;
  //    badly signed ones are noise, or somebody knocking, so a month.
  await prisma.gatewayWebhookReceipt.deleteMany({
    where: {
      ...scope,
      OR: [
        { signatureValid: false, createdAt: { lte: new Date(Date.now() - 30 * 86_400_000) } },
        { createdAt: { lte: new Date(Date.now() - 366 * 86_400_000) } }
      ]
    }
  }).catch(() => undefined);

  return done;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OWNER'S VIEW
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Recent online payments with their refunds, for Settings -> Online shop -> Payments. */
export async function activity(clientId: string, limit = 30) {
  const rows = await prisma.onlinePayment.findMany({
    where: { clientId, status: { in: ['PAID', 'REFUNDED_BACK', 'ATTENTION'] } },
    orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(limit, 1), 100),
    include: { refunds: { orderBy: { createdAt: 'asc' } } }
  });
  const orders = await prisma.salesOrder.findMany({
    where: { clientId, id: { in: rows.map(r => r.salesOrderId).filter((x): x is string => !!x) } },
    select: { id: true, orderNumber: true, status: true, customerName: true }
  });
  const byId = new Map(orders.map(o => [o.id, o]));
  const outside = await prisma.salesOrderPayment.groupBy({
    by: ['salesOrderId'],
    where: { clientId, salesOrderId: { in: orders.map(o => o.id) }, kind: 'REFUND', method: { notIn: ['ONLINE', 'POINTS'] } },
    _sum: { amount: true }
  });
  const outsideOf = new Map(outside.map(o => [o.salesOrderId, o._sum.amount ? toMinor(o._sum.amount as any) : 0]));
  return rows.map(r => {
    const refunded = r.refunds.filter(x => x.status === 'PROCESSED').reduce((a, x) => a + x.amountPaise, 0);
    const pending = r.refunds.filter(x => x.status === 'REQUESTING' || x.status === 'PENDING').reduce((a, x) => a + x.amountPaise, 0);
    const elsewhere = r.status === 'PAID' && r.salesOrderId ? outsideOf.get(r.salesOrderId) ?? 0 : 0;
    const o = r.salesOrderId ? byId.get(r.salesOrderId) : undefined;
    return {
      id: r.id,
      state: r.status === 'PAID' ? 'PAID' : r.status === 'REFUNDED_BACK' ? 'RETURNED' : 'ATTENTION',
      amount: r.amountPaise / 100,
      refunded: refunded / 100,
      refundPending: pending / 100,
      refundable: r.status === 'PAID' ? Math.max(0, r.amountPaise - refunded - pending - elsewhere) / 100 : 0,
      givenBackElsewhere: elsewhere / 100,
      method: r.method,
      paymentId: r.gatewayPaymentId,
      paidAt: (r.paidAt ?? r.updatedAt).toISOString(),
      salesOrderId: r.salesOrderId,
      orderNumber: o?.orderNumber ?? null,
      orderStatus: o?.status ?? null,
      customerName: o?.customerName ?? ((r.checkout as any)?.name ?? null),
      note: r.attentionReason,
      refunds: r.refunds.map(x => ({
        amount: x.amountPaise / 100, status: x.status, purpose: x.purpose, reason: x.reason,
        failReason: x.failReason, at: x.createdAt.toISOString()
      }))
    };
  });
}

/** Whether anything is in flight -- a shop must not switch accounts under a customer who is paying. */
export async function inFlight(clientId: string) {
  return prisma.onlinePayment.count({ where: { clientId, status: { in: LIVE } } });
}

/** Paying on delivery with a key that has an open online attempt: settle or let that attempt go first. */
export async function beforeOrderingOnDelivery(clientId: string, rawKey: unknown): Promise<string | null> {
  const placementKey = typeof rawKey === 'string' ? rawKey.trim().slice(0, 64) : '';
  if (placementKey.length < 16) return null;
  const open = await prisma.onlinePayment.findMany({ where: { clientId, placementKey, status: { in: LIVE } }, select: { id: true } });
  for (const o of open) {
    const out = await reconcile(o.id);
    if (out === 'PAID') {
      return (await prisma.onlineShopOrder.findUnique({ where: { clientId_placementKey: { clientId, placementKey } }, select: { token: true } }))?.token ?? null;
    }
    await letGo(o.id, 'SUPERSEDED');
  }
  return null;
}

export { summary as orderSummary, orderCancelled };
