import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma';
import { toMinor, fromMinor } from '../pricing/money';
import { paymentSummary } from '../payments/payment-rules';
import { whyNotCollect } from '../order-payments';
import { paymentAccounts } from '../payments/account.service';
import { GatewayError } from '../payments/gateway';
import { getShopSettings } from '../../lib/clientSettings';
import { badRequest, conflict, notFound } from '../../utils/httpError';

/**
 * Pay links (20 Nov 2026): what is still due on ONE order, paid online by the customer through the shop's own Razorpay.
 * ScaleEzy CRM asks for one for its money-owed reminder (C7) and sends it; the customer opens
 * shop.scaleezy.com/pay/<token>, sees the shop, the order and what is left to pay, and pays in Razorpay's checkout.
 *
 * Rules:
 *   - only an order whose balance may be collected here (never a till bill: that is taken on the till), and only
 *     when the shop's Razorpay is connected;
 *   - the customer always pays what is due AT THAT MOMENT (paid at the shop meanwhile -> less, or nothing);
 *   - paid is asked of Razorpay, never taken from the page; it is recorded on the order ONCE (method ONLINE, keyed by
 *     Razorpay's payment id, like an online-shop payment), and CRM sees it in its feed like any payment;
 *   - money captured beyond what was due (paid twice, or at the shop meanwhile) is refunded at once.
 * The token (24 random bytes) is the only key to the page: it shows the shop, the order number, the first name and
 * the amounts -- never the address, the phone or the items.
 */
const LINK_DAYS = 7;
const rupees = (p: number) => Math.round(p) / 100;
const base = () => (process.env.SHOP_BASE_URL || 'https://shop.scaleezy.com').replace(/\/+$/, '');

async function dueOf(orderId: string) {
  const o = await prisma.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, clientId: true, orderNumber: true, status: true, sourceSystem: true, deletedAt: true, locationId: true, total: true, roundOff: true, writtenOff: true, customerName: true, payments: { select: { kind: true, amount: true } } } });
  if (!o) return null;
  const payable = toMinor(o.total) + toMinor(o.roundOff ?? 0);
  const s = paymentSummary(payable, o.payments as any, toMinor(o.writtenOff ?? 0));
  return { order: o, payable, paid: toMinor(s.paid as any), due: toMinor(s.due as any) };
}

/** CRM asks: a link for what is due on this order (the same link again while it is waiting and the amount is the same). */
export async function make(clientId: string, orderId: string, by: string) {
  const d = await dueOf(orderId);
  if (!d || d.order.clientId !== clientId) throw notFound('That order is not in this shop.');
  if (d.due <= 0) throw conflict(`Nothing is due on ${d.order.orderNumber}.`);
  const refused = whyNotCollect(d.order as any, d.due);
  if (refused) throw conflict(refused);
  const ready = await paymentAccounts.readiness(clientId);
  if (!ready.ready) throw conflict(`This shop does not take online payments yet: ${ready.why ?? 'its Razorpay is not connected'}.`);
  const live = await prisma.orderPayLink.findFirst({ where: { clientId, salesOrderId: orderId, status: 'WAITING', amountPaise: d.due, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
  const link = live ?? await prisma.orderPayLink.create({ data: {
    clientId, salesOrderId: orderId, amountPaise: d.due, token: crypto.randomBytes(24).toString('base64url'),
    expiresAt: new Date(Date.now() + LINK_DAYS * 86_400_000), createdBy: by.slice(0, 120)
  } });
  return { url: `${base()}/pay/${link.token}`, orderNumber: d.order.orderNumber, amountPaise: d.due, expiresAt: link.expiresAt, reused: !!live };
}

async function byToken(token: unknown) {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) throw notFound('This payment link is not valid.');
  const link = await prisma.orderPayLink.findUnique({ where: { token: t } });
  if (!link) throw notFound('This payment link is not valid.');
  return link;
}

/** What the customer's page shows. Nothing private: the shop, the order number, the first name, the amounts. */
export async function view(token: unknown) {
  const link = await byToken(token);
  const d = await dueOf(link.salesOrderId);
  if (!d) throw notFound('This payment link is not valid.');
  const shop = await getShopSettings(link.clientId);
  const settings = await prisma.clientSettings.findUnique({ where: { clientId: link.clientId }, select: { logoUrl: true } });
  const expired = link.status === 'WAITING' && link.expiresAt.getTime() < Date.now();
  const state = link.status === 'PAID' ? 'PAID' : link.status === 'CANCELLED' ? 'CANCELLED' : d.due <= 0 ? 'NOTHING_DUE' : expired ? 'EXPIRED' : 'WAITING';
  return {
    state, shop: { name: shop.businessName || 'Shop', logoUrl: settings?.logoUrl ?? null },
    orderNumber: d.order.orderNumber, firstName: (d.order.customerName ?? '').trim().split(/\s+/)[0] || null,
    bill: rupees(d.payable), paid: rupees(d.paid), due: rupees(Math.max(0, d.due)),
    paidAt: link.paidAt, paymentId: link.paymentId ? `${link.paymentId.slice(0, 8)}…` : null
  };
}

/** The customer presses Pay: a Razorpay order for what is due now, for Razorpay's checkout on the page. */
export async function checkout(token: unknown) {
  const link = await byToken(token);
  const v = await view(token);
  if (v.state !== 'WAITING') throw conflict(v.state === 'PAID' ? 'This is already paid.' : v.state === 'NOTHING_DUE' ? 'Nothing is due on this order any more.' : 'This payment link has expired. Ask the shop for a new one.');
  const d = (await dueOf(link.salesOrderId))!;
  const g = await paymentAccounts.gatewayFor(link.clientId);
  if (!g) throw conflict('This shop does not take online payments just now.');
  try {
    // A new Razorpay order whenever what is due has changed (or there is none yet); the same one otherwise.
    let gatewayOrderId = link.amountPaise === d.due ? link.gatewayOrderId : null;
    let payload: Record<string, unknown> | null = null;
    if (!gatewayOrderId) {
      const made = await g.createOrder(d.due, `PL-${link.id.slice(0, 8)}`, { scaleezy: 'pay-link', link: link.id, order: d.order.orderNumber });
      gatewayOrderId = made.gatewayOrderId;
      payload = made.checkoutPayload;
      await prisma.orderPayLink.update({ where: { id: link.id }, data: { gatewayOrderId, amountPaise: d.due } });
    }
    const keyId = (await prisma.shopPaymentAccount.findUnique({ where: { clientId: link.clientId }, select: { keyId: true } }))?.keyId;
    return { checkout: { ...(payload ?? { key: keyId, order_id: gatewayOrderId, amount: d.due, currency: 'INR' }), name: v.shop.name, description: `Balance for ${v.orderNumber}` } };
  } catch (e: any) {
    if (e instanceof GatewayError) throw badRequest('Payments are not working just now. Please try again in a minute.');
    throw e;
  }
}

/** After Razorpay's checkout (or its webhook): asks Razorpay, records the payment on the order once. Safe to repeat. */
export async function confirm(token: unknown) {
  const link = await byToken(token);
  if (link.status !== 'WAITING' || !link.gatewayOrderId) return view(token);
  const g = await paymentAccounts.gatewayFor(link.clientId);
  if (!g) return view(token);
  let captured: { paymentId: string; amountPaise: number } | null = null;
  try {
    for (const x of await g.paymentsForOrder(link.gatewayOrderId)) {
      if (x.status === 'AUTHORIZED' && x.amountPaise === link.amountPaise) {
        const c = await g.capture(x.paymentId, link.amountPaise);
        if (c.status === 'CAPTURED') { captured = { paymentId: x.paymentId, amountPaise: c.amountPaise }; break; }
      }
      if (x.status === 'CAPTURED') { captured = { paymentId: x.paymentId, amountPaise: x.amountPaise }; break; }
    }
  } catch (e: any) {
    if (e instanceof GatewayError) throw badRequest('We could not check the payment just now. If money left your account, it is safe: refresh in a minute.');
    throw e;
  }
  if (!captured) return view(token);
  const cap = captured;
  const excess = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${link.salesOrderId} FOR UPDATE`;
    const d = (await dueOf(link.salesOrderId))!;
    const take = Math.max(0, Math.min(cap.amountPaise, d.due));
    const fresh = await tx.orderPayLink.updateMany({ where: { id: link.id, status: 'WAITING' }, data: { status: 'PAID', paymentId: cap.paymentId, paidAt: new Date() } });
    if (!fresh.count) return 0; // already recorded by the webhook or another confirm
    if (take > 0) {
      await tx.salesOrderPayment.create({ data: {
        clientId: link.clientId, salesOrderId: link.salesOrderId, locationId: d.order.locationId, kind: 'PAYMENT', method: 'ONLINE',
        amount: fromMinor(take), reference: `Razorpay ${cap.paymentId} (pay link)`.slice(0, 120), onceKey: `RZP:${cap.paymentId}`
      } as any });
    }
    return cap.amountPaise - take;
  }, { timeout: 30_000 });
  // Paid more than was due by then (paid at the shop meanwhile): the rest goes straight back.
  if (excess > 0) await g.refund(cap.paymentId, excess, 'Paid more than was due', `pl-${link.id.slice(0, 12)}`).catch(e => console.error('[pay link] refund of the excess failed', link.id, e?.message));
  return view(token);
}

/** Razorpay's webhook for a pay link's order (payments/online-payment.service applyWebhook). */
export async function onOrderPaid(clientId: string, gatewayOrderId: string | null | undefined): Promise<'APPLIED' | 'IGNORED'> {
  if (!gatewayOrderId) return 'IGNORED';
  const link = await prisma.orderPayLink.findFirst({ where: { clientId, gatewayOrderId } });
  if (!link) return 'IGNORED';
  const v = await confirm(link.token);
  return v.state === 'PAID' ? 'APPLIED' : 'IGNORED';
}
