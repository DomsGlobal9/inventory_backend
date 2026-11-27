/**
 * Pay by UPI in the online shop (26 Nov 2026, PLAN-upi-mockups.html, approved by the owner).
 *
 * Two ways, set in Settings -> Payments; the "Pay by UPI" tick in the online shop's ways to pay switches it on:
 *   DIRECT    straight to the shop's own UPI ID. No gateway sees that money, so:
 *               1. the shopper presses "Pay by UPI": the order is placed and its pieces held (AWAITING, 30 minutes);
 *               2. they pay by QR or their UPI app and type the 12-digit reference: TO_CHECK, the shop is told once;
 *               3. the owner checks the bank and presses Payment received (the payment is recorded, the customer
 *                  told) or Not received (the customer asked; cancelled after a day unless it turns up).
 *             No reference in 30 minutes: cancelled, pieces back on sale. Shipping waits for Payment received.
 *   RAZORPAY  the shop's own Razorpay, limited to UPI: the ONLINE flow (payments/online-payment.service) with the
 *             window showing UPI only. Confirms itself; nothing here.
 */
import { prisma } from '../../lib/prisma';
import { OnlineShopRuleError } from './rules';
import { paymentAccounts } from '../payments/account.service';
import { recordPayments } from '../payments';
import { salesOrderService } from '../sales-order.service';
import { sendOrderPlacedNotice, emailOrderPlaced, tellTheShop, orderCancelled } from './notices';

export const AWAIT_MS = 30 * 60_000;
export const NOT_RECEIVED_MS = 24 * 60 * 60_000;
/** name@bank: letters, digits, dot, dash, underscore before the @; a bank handle after it. */
export const UPI_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const UTR = /^\d{12}$/;
const OPEN = ['AWAITING', 'TO_CHECK', 'NOT_RECEIVED'];

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0 })}`;

/** The upi:// link a QR carries and a phone opens: payee, name, the exact amount, and the order to match it by. */
export function upiLink(p: { upiId: string; name: string | null; amountPaise: number; orderNumber: string }) {
  const q = new URLSearchParams({
    pa: p.upiId, pn: (p.name || 'Shop').slice(0, 50), am: (p.amountPaise / 100).toFixed(2), cu: 'INR',
    tn: `Order ${p.orderNumber}`.slice(0, 80), tr: p.orderNumber.slice(0, 35)
  });
  return `upi://pay?${q.toString()}`;
}

// ── Settings ──────────────────────────────────────────────────────────────────────────────────

export async function upiSettings(clientId: string) {
  const shop = await prisma.onlineShop.findUnique({ where: { clientId }, select: { payByUpi: true, upiWay: true, upiId: true, upiName: true } });
  const razorpayReady = (await paymentAccounts.readiness(clientId).catch(() => ({ ready: false }))).ready;
  return {
    hasShop: !!shop,
    on: !!shop?.payByUpi,
    way: (shop?.upiWay === 'RAZORPAY' ? 'RAZORPAY' : 'DIRECT') as 'DIRECT' | 'RAZORPAY',
    upiId: shop?.upiId ?? null,
    upiName: shop?.upiName ?? null,
    razorpayReady,
    /** Set up = the chosen way can take money: a UPI ID, or working Razorpay keys. */
    ready: shop?.upiWay === 'RAZORPAY' ? razorpayReady : !!shop?.upiId,
    /** ₹1 to the shop's own UPI ID, so the owner sees the name their shoppers will see. */
    testLink: shop?.upiId ? upiLink({ upiId: shop.upiId, name: shop.upiName, amountPaise: 100, orderNumber: 'TEST' }) : null
  };
}

export async function saveUpiSettings(clientId: string, body: any) {
  const shop = await prisma.onlineShop.findUnique({ where: { clientId }, select: { id: true } });
  if (!shop) throw fail(409, 'Set up your online shop first (Settings → Online shop), then choose how it takes UPI.');
  const way = body?.way === 'RAZORPAY' ? 'RAZORPAY' : body?.way === 'DIRECT' ? 'DIRECT' : null;
  if (!way) throw fail(400, 'Choose how your shop takes UPI: straight to your UPI ID, or through Razorpay.');

  let upiId: string | null | undefined;
  let upiName: string | null | undefined;
  let holder: string | null = null;
  if (way === 'DIRECT') {
    upiId = String(body?.upiId ?? '').trim();
    if (!UPI_ID.test(upiId)) throw fail(400, 'That does not look like a UPI ID. It is written like name@okhdfc or 98480xxxxx@ybl.');
    upiName = String(body?.upiName ?? '').replace(/[&=?#]/g, ' ').replace(/\s+/g, ' ').trim();
    if (upiName.length < 2 || upiName.length > 50) throw fail(400, 'Give the name shoppers should see in their UPI app (2 to 50 letters).');
    // With Razorpay connected, UPI itself is asked whose ID this is: a typo is caught before any shopper pays it.
    const gateway = await paymentAccounts.gatewayFor(clientId).catch(() => null);
    if (gateway?.validateVpa) {
      const checked = await gateway.validateVpa(upiId).catch(() => null);
      if (checked && checked.valid === false) throw fail(400, `UPI does not know ${upiId}. Check it in your UPI app (Profile → UPI ID) and type it again.`);
      holder = checked?.name ?? null;
    }
  } else {
    const ready = (await paymentAccounts.readiness(clientId)).ready;
    if (!ready) throw fail(409, 'Connect your Razorpay account first (Settings → Payments → Razorpay). Then UPI can go through it.');
  }
  await prisma.onlineShop.update({
    where: { clientId },
    data: { upiWay: way, ...(upiId !== undefined ? { upiId } : {}), ...(upiName !== undefined ? { upiName } : {}) }
  });
  return { ...(await upiSettings(clientId)), holder };
}

// ── The shopper ───────────────────────────────────────────────────────────────────────────────

/** Written inside the order's own transaction (checkout.place), so an order paid by UPI never exists without it. */
export async function claimInTx(tx: any, clientId: string, salesOrderId: string, orderToken: string, amountPaise: number, shop: { upiId: string; upiName: string | null }) {
  await tx.upiClaim.create({
    data: { clientId, salesOrderId, orderToken, amountPaise, upiId: shop.upiId, upiName: shop.upiName, status: 'AWAITING', expiresAt: new Date(Date.now() + AWAIT_MS) }
  });
}

/** What the shopper's UPI page shows. The order token is the only key; nothing personal. */
export async function forShopper(clientId: string, rawToken: unknown) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const claim = token ? await prisma.upiClaim.findFirst({ where: { clientId, orderToken: token } }) : null;
  if (!claim) throw new OnlineShopRuleError('That payment could not be found.');
  await settleIfOrderGone(claim);
  if (OPEN.includes(claim.status) && claim.status !== 'TO_CHECK' && claim.expiresAt.getTime() < Date.now()) await sweep(new Date(), [clientId]);
  const fresh = (await prisma.upiClaim.findUnique({ where: { id: claim.id } }))!;
  const order = await prisma.salesOrder.findUnique({ where: { id: fresh.salesOrderId }, select: { orderNumber: true } });
  return {
    state: fresh.status,
    amount: fresh.amountPaise / 100,
    orderNumber: order?.orderNumber ?? '',
    payee: fresh.upiName || 'the shop',
    upiId: fresh.upiId,
    link: upiLink({ upiId: fresh.upiId, name: fresh.upiName, amountPaise: fresh.amountPaise, orderNumber: order?.orderNumber ?? '' }),
    utr: fresh.utr,
    expiresAt: fresh.expiresAt.toISOString()
  };
}

/** "I have paid": the 12-digit UPI reference. Once more allowed while the shop has not decided (a typo). */
export async function iHavePaid(clientId: string, rawToken: unknown, rawUtr: unknown) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const utr = String(rawUtr ?? '').replace(/[\s-]/g, '');
  if (!UTR.test(utr)) throw new OnlineShopRuleError('Type the 12-digit UPI Ref. No. your UPI app shows after paying (some apps call it UTR or UPI transaction ID).');
  const claim = token ? await prisma.upiClaim.findFirst({ where: { clientId, orderToken: token } }) : null;
  if (!claim) throw new OnlineShopRuleError('That payment could not be found.');
  await settleIfOrderGone(claim);
  if (claim.status === 'AWAITING' && claim.expiresAt.getTime() < Date.now()) await sweep(new Date(), [clientId]);
  const now = (await prisma.upiClaim.findUnique({ where: { id: claim.id } }))!;
  if (now.status === 'RECEIVED') return forShopper(clientId, token);
  if (now.status === 'EXPIRED' || now.status === 'CANCELLED') {
    throw new OnlineShopRuleError('This order was cancelled before a UPI Ref. No. arrived. If money left your account, message the shop with this number and they will sort it out.');
  }
  if (now.utr === utr) return forShopper(clientId, token);   // the same press twice
  if (now.utr && now.claimedAt && Date.now() - now.claimedAt.getTime() > 60 * 60_000) {
    throw new OnlineShopRuleError('The shop is already checking the reference you gave. Message them if it needs changing.');
  }
  const used = await prisma.upiClaim.findFirst({ where: { clientId, utr, id: { not: claim.id } }, select: { id: true } });
  if (used) throw new OnlineShopRuleError('That UPI Ref. No. was already given for another order. Check the 12 digits in your UPI app.');
  const first = !now.utr;
  let landed = 0;
  try {
    // Only while the payment is still open, in the same statement: a "Pay another way", the 30 minutes running out or
    // the shop's Payment received in the same moment must not be overwritten back to "to check" (26 Nov 2026).
    landed = (await prisma.upiClaim.updateMany({
      where: { id: claim.id, status: { in: ['AWAITING', 'TO_CHECK', 'NOT_RECEIVED'] } },
      data: { utr, status: 'TO_CHECK', claimedAt: new Date(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000) }
    })).count;
  } catch (e: any) {
    if (e?.code === 'P2002') throw new OnlineShopRuleError('That UPI Ref. No. was already given for another order. Check the 12 digits in your UPI app.');
    throw e;
  }
  if (!landed) {
    const then = await prisma.upiClaim.findUnique({ where: { id: claim.id }, select: { status: true } });
    if (then?.status === 'RECEIVED') return forShopper(clientId, token);
    throw new OnlineShopRuleError('This order was cancelled before a UPI Ref. No. arrived. If money left your account, message the shop with this number and they will sort it out.');
  }
  // The shop's ONE line to check (owner, 26 Nov 2026): the order now shows in Orders as "UPI · to check". The
  // customer's order confirmation and the shop's "new order to pack" wait for Payment received (received()).
  void first;
  void refreshShopAlert(clientId);
  return forShopper(clientId, token);
}

// ── The owner ─────────────────────────────────────────────────────────────────────────────────

/** UPI payments waiting for the owner, newest first (Orders badge, the order's panel, the alert). */
export async function toCheck(clientId: string, salesOrderId?: string) {
  const found = await prisma.upiClaim.findMany({
    where: { clientId, ...(salesOrderId ? { salesOrderId } : { status: { in: ['TO_CHECK', 'NOT_RECEIVED'] } }) },
    orderBy: { claimedAt: 'desc' }, take: 200
  });
  for (const c of found) await settleIfOrderGone(c);
  const rows = await prisma.upiClaim.findMany({ where: { id: { in: found.map(f => f.id) }, ...(salesOrderId ? {} : { status: { in: ['TO_CHECK', 'NOT_RECEIVED'] } }) }, orderBy: { claimedAt: 'desc' } });
  return rows.map(r => ({ id: r.id, salesOrderId: r.salesOrderId, status: r.status, amount: r.amountPaise / 100, utr: r.utr, upiId: r.upiId, claimedAt: r.claimedAt, decidedAt: r.decidedAt, expiresAt: r.expiresAt }));
}

export async function received(clientId: string, by: { id: string | null; name: string | null }, claimId: string) {
  const claim = await prisma.upiClaim.findFirst({ where: { id: claimId, clientId } });
  if (!claim) throw fail(404, 'That UPI payment was not found.');
  if (claim.status === 'RECEIVED') return toCheck(clientId, claim.salesOrderId);
  await settleIfOrderGone(claim);
  const order = await prisma.salesOrder.findFirst({ where: { id: claim.salesOrderId, clientId }, select: { status: true, locationId: true } });
  if (!order || order.status === 'CANCELLED') throw fail(409, 'This order was cancelled, so its payment cannot be marked received. If the money did arrive, refund it from your UPI app, or place the order again at the counter.');
  const won = await prisma.$transaction(async tx => {
    const won = await tx.upiClaim.updateMany({ where: { id: claim.id, status: { in: OPEN } }, data: { status: 'RECEIVED', decidedAt: new Date(), decidedBy: by.name ?? by.id } });
    if (!won.count) return false;   // a second press, or a second person, at the same moment
    await recordPayments(tx, { clientId, salesOrderId: claim.salesOrderId, locationId: order.locationId, receivedById: by.id }, [
      { method: 'UPI', amountMinor: claim.amountPaise, cashReceivedMinor: null, changeMinor: null, reference: claim.utr ? `UPI ${claim.utr}` : 'UPI (online shop)' } as any
    ]);
    await tx.onlineShopOrder.updateMany({ where: { salesOrderId: claim.salesOrderId }, data: { paid: true, holdExpiresAt: null } });
    return true;
  }, { timeout: 30000, maxWait: 15000 });
  if (won) {
    // NOW the order is confirmed: the customer's order confirmation (WhatsApp and email, as "paid"), and the shop's
    // usual "new online order" to pack. Once, by whoever won the press.
    void sendOrderPlacedNotice(clientId, claim.orderToken);
    void emailOrderPlaced(clientId, claim.orderToken);
    void tellTheShop(clientId, claim.salesOrderId);
  }
  void refreshShopAlert(clientId);
  return toCheck(clientId, claim.salesOrderId);
}

export async function notReceived(clientId: string, by: { id: string | null; name: string | null }, claimId: string) {
  const claim = await prisma.upiClaim.findFirst({ where: { id: claimId, clientId } });
  if (!claim) throw fail(404, 'That UPI payment was not found.');
  if (claim.status === 'RECEIVED') throw fail(409, 'This payment was already marked received.');
  if (claim.status === 'NOT_RECEIVED') return toCheck(clientId, claim.salesOrderId);
  const won = await prisma.upiClaim.updateMany({
    where: { id: claim.id, status: { in: ['AWAITING', 'TO_CHECK'] } },
    data: { status: 'NOT_RECEIVED', decidedAt: new Date(), decidedBy: by.name ?? by.id, expiresAt: new Date(Date.now() + NOT_RECEIVED_MS) }
  });
  if (won.count) void tellCustomer(clientId, claim.orderToken, 'NOT_RECEIVED', claim);
  void refreshShopAlert(clientId);
  return toCheck(clientId, claim.salesOrderId);
}

/** Shipping waits for the money: refused in words while a direct-UPI payment is not received. */
export async function assertPaidBeforeSending(tx: any, clientId: string, salesOrderId: string) {
  const claim = await (tx ?? prisma).upiClaim.findUnique({ where: { salesOrderId }, select: { status: true, clientId: true } });
  if (claim && claim.clientId === clientId && claim.status !== 'RECEIVED') {
    throw fail(409, "This order's UPI payment is not confirmed yet. Check it on the order (Payment received), then send it.");
  }
}

// ── Time ──────────────────────────────────────────────────────────────────────────────────────

/** An order cancelled some other way (the shop, the customer) closes its claim too. */
async function settleIfOrderGone(claim: { id: string; salesOrderId: string; status: string }) {
  if (!OPEN.includes(claim.status)) return;
  const order = await prisma.salesOrder.findUnique({ where: { id: claim.salesOrderId }, select: { status: true } });
  if (!order || order.status === 'CANCELLED') {
    await prisma.upiClaim.updateMany({ where: { id: claim.id, status: { in: OPEN } }, data: { status: 'CANCELLED' } });
  }
}

/**
 * Every minute (housekeeping): no reference in 30 minutes -> cancelled (EXPIRED); "Not received" a day ago and still
 * not received -> cancelled. The pieces go back on sale; the customer is told once.
 */
export async function sweep(now = new Date(), onlyClients?: string[]) {
  const due = await prisma.upiClaim.findMany({ where: { status: { in: ['AWAITING', 'NOT_RECEIVED'] }, expiresAt: { lt: now }, ...(onlyClients ? { clientId: { in: onlyClients } } : {}) }, take: 100 });
  let cancelled = 0;
  for (const c of due) {
    const to = c.status === 'AWAITING' ? 'EXPIRED' : 'CANCELLED';
    const won = await prisma.upiClaim.updateMany({ where: { id: c.id, status: c.status }, data: { status: to } });
    if (!won.count) continue;
    const order = await prisma.salesOrder.findUnique({ where: { id: c.salesOrderId }, select: { status: true } });
    if (order && order.status !== 'CANCELLED' && (order.status === 'CONFIRMED' || order.status === 'DRAFT')) {
      await salesOrderService.cancelOrder(c.clientId, c.salesOrderId).catch((e: any) => console.error('[upi] could not cancel', c.salesOrderId, e?.message));
      void orderCancelled(c.clientId, c.salesOrderId, to === 'EXPIRED' ? 'UPI_TIMED_OUT' : 'UPI_NOT_PAID');
      cancelled++;
    }
    void refreshShopAlert(c.clientId);
  }
  return cancelled;
}

/**
 * "Pay another way" (the QR page's back button, 26 Nov 2026): the shopper changed their mind before paying. Allowed
 * only while no UPI reference has been given -- once one has, money may have left their account and the shop decides.
 * The order is let go (its pieces back on sale) with NO messages: the shop was never told of it (placing a UPI order
 * is quiet) and the shopper is right here, going back to checkout with the same pieces in the bag.
 */
export async function payAnotherWay(clientId: string, rawToken: unknown) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const claim = token ? await prisma.upiClaim.findFirst({ where: { clientId, orderToken: token } }) : null;
  if (!claim) throw new OnlineShopRuleError('That payment could not be found.');
  if (claim.status === 'CANCELLED' || claim.status === 'EXPIRED') return { released: true };
  const why = (status: string) => new OnlineShopRuleError(status === 'RECEIVED'
    ? 'The shop has already received your payment, so this order is confirmed. Message the shop if you need to change it.'
    : 'You have already given a UPI Ref. No., so this order stays with the shop to check. Message the shop if you need to change it.');
  if (claim.status !== 'AWAITING' || claim.utr) throw why(claim.status);
  // Won first, so a reference typed at the same moment on another tab cannot be lost: only one of the two goes through.
  const won = await prisma.upiClaim.updateMany({ where: { id: claim.id, status: 'AWAITING', utr: null }, data: { status: 'CANCELLED', decidedAt: new Date(), decidedBy: 'shopper: pay another way' } });
  if (!won.count) {
    // Lost to the shop pressing Payment received, or a reference from another tab, in the same moment.
    const now = await prisma.upiClaim.findUnique({ where: { id: claim.id }, select: { status: true } });
    if (now?.status === 'CANCELLED' || now?.status === 'EXPIRED') return { released: true };
    throw why(now?.status ?? 'TO_CHECK');
  }
  const order = await prisma.salesOrder.findUnique({ where: { id: claim.salesOrderId }, select: { status: true } });
  if (order && (order.status === 'CONFIRMED' || order.status === 'DRAFT')) await salesOrderService.cancelOrder(clientId, claim.salesOrderId);
  void refreshShopAlert(clientId);
  return { released: true };
}

// ── Telling ───────────────────────────────────────────────────────────────────────────────────

/** ONE alert per shop for all UPI payments waiting, its count kept current; resolved when none wait. */
export async function refreshShopAlert(clientId: string) {
  try {
    for (const c of await prisma.upiClaim.findMany({ where: { clientId, status: 'TO_CHECK' }, select: { id: true, salesOrderId: true, status: true } })) await settleIfOrderGone(c);
    const waiting = await prisma.upiClaim.findMany({ where: { clientId, status: 'TO_CHECK' }, select: { amountPaise: true }, orderBy: { claimedAt: 'asc' } });
    const open = await prisma.inventoryAlert.findFirst({ where: { clientId, type: 'ONLINE_ORDER', title: { startsWith: 'UPI payment' }, isResolved: false } });
    if (!waiting.length) {
      if (open) await prisma.inventoryAlert.update({ where: { id: open.id }, data: { isResolved: true } });
      return;
    }
    const n = waiting.length;
    const title = n === 1 ? 'UPI payment to check' : `UPI payments to check (${n})`;
    const amounts = waiting.slice(0, 4).map(w => rupees(w.amountPaise)).join(', ') + (n > 4 ? ` and ${n - 4} more` : '');
    const message = `${amounts}. Open Orders, check your bank or UPI app for each, and press Payment received. Orders are not sent until you do.`;
    if (open) {
      if (open.title !== title || open.message !== message) await prisma.inventoryAlert.update({ where: { id: open.id }, data: { title, message, isRead: false } });
    } else {
      await prisma.inventoryAlert.create({ data: { clientId, type: 'ONLINE_ORDER', severity: 'WARNING', title, message } });
    }
  } catch (e: any) {
    console.warn('[upi] could not update the alert:', e?.message);
  }
}

async function tellCustomer(clientId: string, orderToken: string, what: 'RECEIVED' | 'NOT_RECEIVED', claim: { amountPaise: number; utr: string | null }) {
  try {
    const { whatsappConfigured } = await import('../whatsapp/client');
    if (!whatsappConfigured()) return;
    const row = await prisma.onlineShopOrder.findUnique({ where: { token: orderToken }, select: { customerPhone: true, salesOrder: { select: { orderNumber: true, customerName: true } } } });
    if (!row?.customerPhone) return;
    const shop = await prisma.onlineShop.findUnique({ where: { clientId }, select: { displayName: true } });
    const { getShopSettings } = await import('../../lib/clientSettings');
    const settings = await getShopSettings(clientId).catch(() => null);
    const name = shop?.displayName?.trim() || settings?.businessName?.trim() || 'the shop';
    const first = row.salesOrder.customerName ? row.salesOrder.customerName.split(' ')[0] : null;
    const text = what === 'RECEIVED'
      ? [`${first ? `${first}, your` : 'Your'} UPI payment of ${rupees(claim.amountPaise)} for order ${row.salesOrder.orderNumber} has reached ${name}. Thank you!`, '', 'We will message you again when it is sent.'].join('\n')
      : [`${first ? `${first}, we` : 'We'} could not find your UPI payment of ${rupees(claim.amountPaise)} for order ${row.salesOrder.orderNumber}${claim.utr ? ` (reference ${claim.utr})` : ''}.`, '', `Please check your UPI app. If the money left your account, reply here with a screenshot and ${name} will sort it out. The order is kept for 24 hours; after that it is cancelled.`].join('\n');
    const { sendShopText } = await import('../whatsapp/service');
    await sendShopText({ clientId, to: row.customerPhone.replace(/^\+/, ''), text, kind: 'ORDER_UPDATE' } as any);
  } catch (e: any) {
    console.warn('[upi] could not message the customer:', e?.message);
  }
}
