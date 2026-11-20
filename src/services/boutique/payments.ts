import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma';
import { paymentAccounts } from '../payments/account.service';
import { GatewayError } from '../payments/gateway';
import { getShopSettings } from '../../lib/clientSettings';
import { problem, type Actor } from './index';

/**
 * Boutique payments (20 Nov 2026): money for boutique work -- a stitching advance, an alteration, a balance at pickup --
 * taken through the shop's OWN Razorpay (Settings -> payments), asked for by the Boutique app. The same Razorpay calls
 * as ScaleEzy's online shop and till QR. It is the boutique's money, not a shop sale: kept here, not in the Day Book,
 * and the Boutique app is told when it is paid (the boutique feed, "payment.paid").
 *
 * Two ways to pay:
 *   CHECKOUT -- Razorpay's own checkout, opened by the app with the answer's `checkout` (Razorpay's phone SDK or web);
 *   UPI_QR   -- a UPI QR for exactly this amount, to show on screen or send on WhatsApp; it closes by itself.
 * Paid is never taken from the app: it is asked of Razorpay (POST /payments/{id}/check, or Razorpay's webhook).
 * Asking: payments:take. Refunding: payments:refund (give it to the owner).
 */
const take = (a: Actor) => { if (!a.can.includes('payments:take')) throw problem('This person may not ask for payments.', 403); };
const refundRight = (a: Actor) => { if (!a.can.includes('payments:refund')) throw problem('This person may not refund payments.', 403); };
const rupees = (p: number) => Math.round(p) / 100;
const by = (a: Actor) => `${a.name} (Boutique)`.slice(0, 120);

async function said<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e: any) {
    if (e instanceof GatewayError) throw problem(`Razorpay said: ${e.message}`, 502);
    throw e;
  }
}
async function gatewayOf(clientId: string) {
  const ready = await paymentAccounts.readiness(clientId);
  if (!ready.ready) throw problem(`Online payments are not set up for this shop: ${ready.why ?? 'connect Razorpay first'} (PUT /settings/payments).`, 409);
  const g = await paymentAccounts.gatewayFor(clientId);
  if (!g) throw problem('Online payments are not set up for this shop (PUT /settings/payments).', 409);
  return g;
}

function view(p: any) {
  return {
    id: p.id, reference: p.reference, purpose: p.purpose, amount: rupees(p.amountPaise), method: p.method, status: p.status,
    customer: { name: p.customerName, phone: p.customerPhone },
    ...(p.method === 'CHECKOUT' ? { gatewayOrderId: p.gatewayOrderId } : { qrImageUrl: p.qrImageUrl, closesAt: p.closeBy }),
    paid: rupees(p.paidPaise), refunded: rupees(p.refundedPaise), paidAt: p.paidAt, paymentId: p.paymentId, utr: p.utr,
    refunds: p.refunds ?? [], askedBy: p.createdBy, askedAt: p.createdAt
  };
}

/** Ask for a payment: { amount (rupees), purpose, reference (your order), customer: { name, phone }, method, minutes (QR, 5-120) }. */
export async function ask(a: Actor, body: any) {
  take(a);
  const amountPaise = Math.round(Number(body?.amount) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise < 100 || amountPaise > 50_00_000_00) throw problem('amount is in rupees, from 1 to 50,00,000.');
  if (Math.abs(Number(body?.amount) * 100 - amountPaise) > 1e-6) throw problem('amount has at most 2 decimals (paise).');
  const purpose = typeof body?.purpose === 'string' ? body.purpose.trim().slice(0, 120) : '';
  if (!purpose) throw problem('Say what it is for (purpose), e.g. "Blouse stitching advance". The customer sees it.');
  const reference = typeof body?.reference === 'string' ? body.reference.trim().slice(0, 60) : '';
  if (!reference) throw problem('Give your own reference for it (reference), e.g. your order number ST-101.');
  const method = String(body?.method ?? 'CHECKOUT').toUpperCase();
  if (method !== 'CHECKOUT' && method !== 'UPI_QR') throw problem('method is CHECKOUT (Razorpay\'s checkout in your app) or UPI_QR.');
  const minutes = body?.minutes == null ? 30 : Number(body.minutes);
  if (method === 'UPI_QR' && !(Number.isInteger(minutes) && minutes >= 5 && minutes <= 120)) throw problem('minutes (how long the QR stays open) is 5 to 120.');
  const name = typeof body?.customer?.name === 'string' ? body.customer.name.trim().slice(0, 80) : null;
  const phone = typeof body?.customer?.phone === 'string' ? body.customer.phone.replace(/[^\d+]/g, '').slice(0, 15) : null;

  const g = await gatewayOf(a.clientId);
  const id = crypto.randomUUID();
  const notes = { scaleezy: 'boutique', payment: id, reference };
  if (method === 'CHECKOUT') {
    const order = await said(() => g.createOrder(amountPaise, `BTQ-${id.slice(0, 8)}`, notes));
    const row = await prisma.boutiquePayment.create({ data: { id, clientId: a.clientId, reference, purpose, amountPaise, customerName: name, customerPhone: phone, method, gatewayOrderId: order.gatewayOrderId, createdBy: by(a) } });
    const shop = await getShopSettings(a.clientId);
    // What the app hands Razorpay's checkout: the key id (public), the order, the amount -- and who is paying, prefilled.
    return { ...view(row), checkout: { ...order.checkoutPayload, name: shop.businessName || undefined, description: purpose, prefill: { name: name ?? undefined, contact: phone ?? undefined } } };
  }
  const closeBy = new Date(Date.now() + minutes * 60_000);
  const shop = await getShopSettings(a.clientId);
  const qr = await said(() => g.createUpiQr(amountPaise, { name: (shop.businessName || 'Shop').slice(0, 40), closeBy, description: purpose.slice(0, 80), notes }));
  const row = await prisma.boutiquePayment.create({ data: { id, clientId: a.clientId, reference, purpose, amountPaise, customerName: name, customerPhone: phone, method, qrId: qr.qrId, qrImageUrl: qr.imageUrl, closeBy, createdBy: by(a) } });
  return view(row);
}

async function own(clientId: string, id: string) {
  const p = await prisma.boutiquePayment.findFirst({ where: { id, clientId } });
  if (!p) throw problem('That payment is not this shop\'s.', 404);
  return p;
}

/** Tells the Boutique app a payment came in (signed, retried, in order). */
async function tellPaid(p: any) {
  const link = await prisma.boutiqueLink.findUnique({ where: { clientId: p.clientId }, select: { tenant: true, unlinkedAt: true } });
  if (!link || link.unlinkedAt) return;
  await prisma.moduleEvent.create({ data: { clientId: p.clientId, module: 'boutique', kind: 'payment.paid', sourceTable: 'boutique_payments', rowId: p.id,
    payload: { tenant: link.tenant, paymentId: p.id, reference: p.reference, amount: rupees(p.paidPaise), method: p.method, utr: p.utr ?? null, paidAt: p.paidAt?.toISOString() ?? null } } });
}

/** Asks Razorpay whether it is paid (captures an authorised checkout of the right amount). Safe to ask again. */
export async function check(a: Actor, id: string) {
  const p = await own(a.clientId, id);
  if (p.status !== 'WAITING') return view(p);
  const g = await gatewayOf(a.clientId);
  let paid: { paymentId: string; amountPaise: number; utr: string | null; at: Date } | null = null;
  if (p.method === 'CHECKOUT' && p.gatewayOrderId) {
    for (const x of await said(() => g.paymentsForOrder(p.gatewayOrderId!))) {
      if (x.status === 'AUTHORIZED' && x.amountPaise === p.amountPaise) {
        const c = await said(() => g.capture(x.paymentId, p.amountPaise));
        if (c.status === 'CAPTURED') { paid = { paymentId: x.paymentId, amountPaise: c.amountPaise, utr: null, at: new Date() }; break; }
      }
      if (x.status === 'CAPTURED') { paid = { paymentId: x.paymentId, amountPaise: x.amountPaise, utr: null, at: new Date() }; break; }
    }
  } else if (p.qrId) {
    const got = (await said(() => g.upiQrPayments(p.qrId!))).filter(x => x.status === 'CAPTURED');
    if (got.length) paid = { paymentId: got[0].paymentId, amountPaise: got.reduce((s, x) => s + x.amountPaise, 0), utr: got[0].utr, at: got[0].paidAt ?? new Date() };
    else if (p.closeBy && p.closeBy.getTime() < Date.now()) {
      await prisma.boutiquePayment.updateMany({ where: { id: p.id, status: 'WAITING' }, data: { status: 'EXPIRED' } });
      return view(await own(a.clientId, id));
    }
  }
  if (!paid) return view(p);
  // Exactly once: only a WAITING row becomes PAID, so a webhook and a check at the same moment tell the app once.
  const moved = await prisma.boutiquePayment.updateMany({ where: { id: p.id, status: 'WAITING' }, data: { status: 'PAID', paymentId: paid.paymentId, paidPaise: paid.amountPaise, utr: paid.utr, paidAt: paid.at } });
  const now = await own(a.clientId, id);
  if (moved.count) await tellPaid(now);
  if (p.qrId) await g.closeUpiQr(p.qrId).catch(() => undefined);
  return view(now);
}

/** Stops waiting: the QR is closed, the checkout is no longer offered. A paid one cannot be cancelled (refund it). */
export async function cancel(a: Actor, id: string) {
  take(a);
  const p = await own(a.clientId, id);
  if (p.status === 'PAID' || p.status === 'PART_REFUNDED' || p.status === 'REFUNDED') throw problem('It is already paid. Refund it instead.', 409);
  if (p.status !== 'WAITING') return view(p);
  const after = await check(a, id); // paid at the last moment? then it is paid, not cancelled
  if (after.status !== 'WAITING') return after;
  if (p.qrId) { const g = await gatewayOf(a.clientId); await g.closeUpiQr(p.qrId).catch(() => undefined); }
  await prisma.boutiquePayment.updateMany({ where: { id: p.id, status: 'WAITING' }, data: { status: 'CANCELLED' } });
  return view(await own(a.clientId, id));
}

/** Gives back all or part of a paid one: { amount (rupees), reason }. */
export async function refund(a: Actor, id: string, body: any, key: string) {
  refundRight(a);
  const p = await own(a.clientId, id);
  if (!p.paymentId || !['PAID', 'PART_REFUNDED'].includes(p.status)) throw problem('Only a paid payment can be refunded.', 409);
  const amountPaise = Math.round(Number(body?.amount ?? p.paidPaise / 100) * 100);
  const left = p.paidPaise - p.refundedPaise;
  if (!(amountPaise >= 100 && amountPaise <= left)) throw problem(`amount is in rupees, up to ${rupees(left)} (what is left of it).`);
  const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'Refund';
  const g = await gatewayOf(a.clientId);
  const r = await said(() => g.refund(p.paymentId!, amountPaise, reason, `btq-${key}`.slice(0, 40)));
  const refunded = p.refundedPaise + (r.status === 'FAILED' ? 0 : amountPaise);
  const refunds = [...((p.refunds as any[]) ?? []), { refundId: r.refundId, amount: rupees(amountPaise), status: r.status, reason, by: by(a), at: new Date().toISOString() }];
  await prisma.boutiquePayment.update({ where: { id: p.id }, data: { refundedPaise: refunded, refunds, status: refunded >= p.paidPaise ? 'REFUNDED' : refunded > 0 ? 'PART_REFUNDED' : p.status } });
  return view(await own(a.clientId, id));
}

export async function list(a: Actor, q: Record<string, unknown>) {
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20)), page = Math.max(1, Number(q.page) || 1);
  const where: any = { clientId: a.clientId, ...(q.status ? { status: String(q.status).toUpperCase() } : {}), ...(q.reference ? { reference: String(q.reference) } : {}) };
  const [total, rows] = await Promise.all([prisma.boutiquePayment.count({ where }), prisma.boutiquePayment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit })]);
  return { payments: rows.map(view), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
export async function getOne(a: Actor, id: string) { return view(await own(a.clientId, id)); }

/* ── Razorpay's webhook, for a boutique payment (called from payments/online-payment.service applyWebhook) ── */
const actorFor = (clientId: string): Actor => ({ clientId, name: 'Razorpay', can: [] });
export async function onOrderPaid(clientId: string, gatewayOrderId: string | null | undefined): Promise<'APPLIED' | 'IGNORED'> {
  if (!gatewayOrderId) return 'IGNORED';
  const p = await prisma.boutiquePayment.findFirst({ where: { clientId, gatewayOrderId } });
  if (!p) return 'IGNORED';
  const after = await check(actorFor(clientId), p.id);
  return after.status === 'PAID' ? 'APPLIED' : 'IGNORED';
}
export async function onQrCredited(clientId: string, qrId: string | null | undefined): Promise<'APPLIED' | 'IGNORED'> {
  if (!qrId) return 'IGNORED';
  const p = await prisma.boutiquePayment.findFirst({ where: { clientId, qrId } });
  if (!p) return 'IGNORED';
  const after = await check(actorFor(clientId), p.id);
  return after.status === 'PAID' ? 'APPLIED' : 'IGNORED';
}
