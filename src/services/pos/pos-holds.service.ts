/**
 * Loyalty points and store credit spent at the till (contract §10).
 *
 * POINTS ARE MONEY, so none of §9's "sell anyway" applies. The till never spends from a cached
 * number: it asks what this customer may use on THIS bill (wallet), RESERVES it before Complete,
 * CONFIRMS the hold the moment its sale commits, RELEASES it on cancel or parking, and Inventory
 * SWEEPS only what was never confirmed. The sale event, which may arrive hours later, then finds
 * the hold and writes the real debit.
 *
 * A hold does not write a ledger entry. It is a row taken under the customer's row lock, and the
 * balance a till may spend is the ledger balance less every live hold -- so two tills asking for
 * the same 500 points at the same moment get one yes and one NOT_ENOUGH. The ledger moves once,
 * when the sale lands (USED:<order>), exactly as the counter always did.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../utils/httpError';
import { normalisePhone } from '../../lib/phone';
import { getSettings, mostUsable, pointsForPayment, valueOf, rupeesOf } from '../loyalty';
import { post as postPoints } from '../loyalty/loyalty.service';
import { spendOnSale as spendCredit } from '../store-credit/store-credit.service';

type Tx = Prisma.TransactionClient;
export const HOLD_TTL_MS = 10 * 60 * 1000;
const KINDS = ['POINTS', 'CREDIT'] as const;
export type HoldKind = typeof KINDS[number];

/** A refusal the till shows as one plain line; `answer` is its code on the wire. */
const refusal = (statusCode: number, answer: string, message: string) => ({ statusCode, answer, message });

/**
 * The customer a till's phone names -- the ONE rule the sale, the wallet and the holds all use.
 *
 * Whoever holds that number in this shop comes first: the cashier is face to face with them, as
 * Inventory's own counter always was, and the wallet shows the name in full for checking. Only
 * then the till's own `POS:<ref>` row. Matching on the tag alone made a phone-less second copy of
 * any customer who first bought online, and hid their points and credit from the till.
 */
export async function customerForTill(db: Tx | typeof prisma, clientId: string, ref: string) {
  const select = { id: true, name: true, loyaltyPoints: true, storeCreditPaise: true } as const;
  const n = normalisePhone(ref);
  if (n.ok) {
    const holder = await db.customer.findFirst({ where: { clientId, phone: n.value, deletedAt: null }, select, orderBy: { createdAt: 'asc' } });
    if (holder) return holder;
  }
  return db.customer.findFirst({ where: { clientId, externalCustomerId: `POS:${ref}`, deletedAt: null }, select });
}

async function tillCustomer(db: Tx | typeof prisma, clientId: string, customerRef: unknown) {
  const ref = typeof customerRef === 'string' ? customerRef.trim() : '';
  if (!ref) throw badRequest('Say whose points: send customerRef.');
  return customerForTill(db, clientId, ref);
}

/** "+91 98765 •••10": enough to recognise, not enough to copy. */
const masked = (ref: string) => ref.length <= 5 ? ref : `${ref.slice(0, 3)}${'•'.repeat(Math.max(3, ref.length - 5))}${ref.slice(-2)}`;

/** Holds that still occupy the balance: reserved, or confirmed and not yet tied to an order. Expired ones are swept first. */
async function liveHeld(db: Tx | typeof prisma, clientId: string, customerId: string, kind: HoldKind, now = new Date()) {
  await db.posHold.updateMany({ where: { clientId, customerId, status: 'RESERVED', expiresAt: { lt: now } }, data: { status: 'SWEPT', releasedAt: now } });
  const live = await db.posHold.aggregate({
    where: { clientId, customerId, kind, salesOrderId: null, OR: [{ status: 'RESERVED' }, { status: 'CONFIRMED' }] },
    _sum: { amount: true }
  });
  return live._sum.amount ?? 0;
}

const shape = (h: any) => ({
  holdId: h.id, kind: h.kind, amount: h.amount, valuePaise: h.valuePaise, status: h.status,
  expiresAt: h.expiresAt.toISOString(), confirmedAt: h.confirmedAt ? h.confirmedAt.toISOString() : null
});

/** §10.1: what this customer may spend on THIS bill, with the arithmetic done. */
export async function wallet(clientId: string, query: { customerRef?: unknown; billPaise?: unknown }) {
  const billPaise = Number(query.billPaise);
  if (!Number.isInteger(billPaise) || billPaise < 0) throw badRequest('Say the bill in whole paise, in billPaise.');
  const c = await tillCustomer(prisma, clientId, query.customerRef);
  const ref = String(query.customerRef).trim();
  if (!c) return { customerRef: masked(ref), customerName: null, points: null, credit: null, reason: 'No customer with that number here yet.' };

  const s = await getSettings(clientId);
  let points: any = null;
  let reason: string | null = null; // why `points` is null; credit never depends on loyalty
  if (!s.enabled) {
    reason = 'Loyalty points are off for this shop.';
  } else {
    const available = Math.max(0, c.loyaltyPoints - await liveHeld(prisma, clientId, c.id, 'POINTS'));
    const usable = mostUsable(available, billPaise, s);
    points = {
      balance: available, pointValuePaise: s.pointValuePaise, minRedeemPoints: s.minRedeemPoints, maxRedeemPercent: s.maxRedeemPercent,
      usablePoints: usable, usablePaise: valueOf(usable, s),
      reason: usable > 0 ? null
        : available < Math.max(1, s.minRedeemPoints) ? `Needs ${s.minRedeemPoints.toLocaleString('en-IN')} points to start; holds ${available.toLocaleString('en-IN')}.`
        : 'Nothing of this bill can be paid with points.'
    };
  }
  const creditAvailable = Math.max(0, c.storeCreditPaise - await liveHeld(prisma, clientId, c.id, 'CREDIT'));
  return {
    customerRef: masked(ref), customerName: c.name, points,
    credit: { balancePaise: creditAvailable, usablePaise: Math.min(creditAvailable, billPaise) }, reason
  };
}

/** §10.2: reserve points or credit for one bill, under the customer's row lock. The same key again answers the same hold. */
export async function reserve(clientId: string, connectionId: string, body: any) {
  const key = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!key || key.length > 120) throw badRequest('Send an idempotencyKey for the reserve, up to 120 characters.');
  const kind = String(body?.kind ?? '') as HoldKind;
  if (!KINDS.includes(kind)) throw badRequest('kind must be POINTS or CREDIT.');
  const amount = Number(body?.amount);
  const billPaise = Number(body?.billPaise);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest(kind === 'POINTS' ? 'Say how many points, a whole number above zero.' : 'Say the credit in whole paise, above zero.');
  if (!Number.isInteger(billPaise) || billPaise <= 0) throw badRequest('Say the bill in whole paise, in billPaise.');

  const same = await prisma.posHold.findUnique({ where: { clientId_idempotencyKey: { clientId, idempotencyKey: key } } });
  if (same) return shape(same);

  return prisma.$transaction(async (tx) => {
    const c = await tillCustomer(tx, clientId, body?.customerRef);
    if (!c) throw refusal(404, 'UNKNOWN_CUSTOMER', 'No customer with that number here yet.');
    // The lock: nobody else reserves or spends this customer's balance until this commits.
    await tx.$queryRaw`SELECT id FROM customers WHERE id = ${c.id} AND client_id = ${clientId} FOR UPDATE`;
    const now = new Date();
    let valuePaise: number;
    if (kind === 'POINTS') {
      const s = await getSettings(clientId, tx);
      if (!s.enabled) throw refusal(422, 'POINTS_OFF', 'Loyalty points are off for this shop.');
      const available = Math.max(0, c.loyaltyPoints - await liveHeld(tx, clientId, c.id, 'POINTS', now));
      valuePaise = valueOf(amount, s);
      try {
        pointsForPayment(valuePaise, billPaise, available, s); // the counter's own rules: steps, minimum, cap, held
      } catch (e: any) {
        const notEnough = /does not have|points, not/.test(e?.message ?? '');
        throw refusal(notEnough ? 409 : 422, notEnough ? 'NOT_ENOUGH' : 'BAD_PAYLOAD', e?.message ?? 'Those points cannot be used on this bill.');
      }
    } else {
      const available = Math.max(0, c.storeCreditPaise - await liveHeld(tx, clientId, c.id, 'CREDIT', now));
      if (amount > billPaise) throw badRequest(`Store credit cannot pay more than the bill (${rupeesOf(billPaise)}).`);
      if (amount > available) throw refusal(409, 'NOT_ENOUGH', `The customer has ${rupeesOf(available)} of store credit left.`);
      valuePaise = amount;
    }
    const made = await tx.posHold.create({
      data: { clientId, connectionId, customerId: c.id, kind, amount, valuePaise, billPaise, idempotencyKey: key, status: 'RESERVED', expiresAt: new Date(now.getTime() + HOLD_TTL_MS) }
    });
    return shape(made);
  });
}

async function holdOf(clientId: string, holdId: string) {
  const h = await prisma.posHold.findFirst({ where: { id: String(holdId), clientId } });
  if (!h) throw refusal(404, 'HOLD_UNKNOWN', 'No such hold here.');
  return h;
}

/** §10.2: the till's sale committed. Idempotent; what keeps a hold alive, however long the sale event takes. */
export async function confirm(clientId: string, holdId: string, body: any) {
  const h = await holdOf(clientId, holdId);
  if (h.status === 'CONFIRMED') return shape(h);
  if (h.status === 'SWEPT') throw refusal(409, 'HOLD_EXPIRED', 'This hold expired before the sale was confirmed. The customer\'s points were not used; take the rest another way.');
  if (h.status === 'RELEASED') throw refusal(409, 'HOLD_RELEASED', 'This hold was released. Reserve again.');
  const invoiceNo = typeof body?.invoiceNo === 'string' && body.invoiceNo.trim() ? body.invoiceNo.trim() : null;
  const done = await prisma.posHold.update({ where: { id: h.id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), invoiceNo } });
  return shape(done);
}

/** §10.2: the cashier removed the points, cancelled, or parked the bill. Idempotent. */
export async function release(clientId: string, holdId: string) {
  const h = await holdOf(clientId, holdId);
  if (h.status === 'CONFIRMED') throw refusal(409, 'HOLD_CONFIRMED', 'This hold was confirmed by a sale and cannot be released.');
  if (h.status === 'RESERVED') await prisma.posHold.update({ where: { id: h.id }, data: { status: 'RELEASED', releasedAt: new Date() } });
  return { holdId: h.id, status: h.status === 'RESERVED' ? 'RELEASED' : h.status };
}

/** §10.4: only what was never confirmed. Housekeeping calls this; every wallet read and reserve sweeps the one customer too. */
export async function sweep(now = new Date()) {
  const r = await prisma.posHold.updateMany({ where: { status: 'RESERVED', expiresAt: { lt: now } }, data: { status: 'SWEPT', releasedAt: now } });
  return r.count;
}

/**
 * §10.3: inside the sale's transaction. Each POINTS / CREDIT payment row naming a hold has its
 * debit written (USED:<order>) and the hold tied to the order. A row with no hold, or a hold that
 * is missing, released, swept, somebody else's or already used by another bill: nothing moves and
 * a warning says so -- the bill is the bill. Returns what the points and credit paid, for earning.
 */
export async function settleOnSale(
  tx: Tx, clientId: string, order: { id: string; customerId: string | null; externalOrderId?: string | null },
  payments: { method: string; amountPaise: number; holdId?: string | null }[]
): Promise<{ pointsPaidMinor: number; creditPaidMinor: number; warnings: string[] }> {
  const out = { pointsPaidMinor: 0, creditPaidMinor: 0, warnings: [] as string[] };
  for (const row of payments) {
    if (row.method !== 'POINTS' && row.method !== 'CREDIT') continue;
    const what = row.method === 'POINTS' ? 'points' : 'store credit';
    const untouched = `The customer's ${what} were not changed.`;
    if (!row.holdId) { out.warnings.push(`This bill was part-paid with ${what} but names no hold, so Inventory could not settle it. ${untouched}`); continue; }
    const h = await tx.posHold.findFirst({ where: { id: String(row.holdId), clientId } });
    if (!h) { out.warnings.push(`Hold ${row.holdId} on this bill is not one Inventory gave. ${untouched}`); continue; }
    if (h.kind !== row.method) { out.warnings.push(`Hold ${h.id} is for ${h.kind === 'POINTS' ? 'points' : 'store credit'}, not ${what}. ${untouched}`); continue; }
    if (h.customerId !== order.customerId) { out.warnings.push(`Hold ${h.id} belongs to another customer. ${untouched}`); continue; }
    if (h.salesOrderId && h.salesOrderId !== order.id) { out.warnings.push(`Hold ${h.id} was already used by another bill. ${untouched}`); continue; }
    if (h.status === 'SWEPT') { out.warnings.push(`Hold ${h.id} expired before the sale was confirmed. ${untouched}`); continue; }
    if (h.status === 'RELEASED') { out.warnings.push(`Hold ${h.id} was released before this bill landed. ${untouched}`); continue; }
    if (Math.round(row.amountPaise) !== h.valuePaise) {
      out.warnings.push(`The ${what} row says ${rupeesOf(Math.round(row.amountPaise))} but hold ${h.id} reserved ${rupeesOf(h.valuePaise)}; the hold's amount was used.`);
    }
    try {
      if (h.kind === 'POINTS') {
        await postPoints(tx, { clientId, customerId: h.customerId, kind: 'USED', points: -h.amount, onceKey: `USED:${order.id}`, salesOrderId: order.id, activity: true, note: `${rupeesOf(h.valuePaise)} off the bill, at the till` });
        out.pointsPaidMinor += h.valuePaise;
      } else {
        await spendCredit(tx, { clientId, customerId: h.customerId, orderId: order.id, paise: h.amount, userId: null });
        out.creditPaidMinor += h.valuePaise;
      }
    } catch (e: any) {
      // The balance fell in between (a return took points back): the money was taken, so the bill stands; say so.
      out.warnings.push(`Hold ${h.id} could not be settled: ${e?.message ?? 'the balance was no longer enough.'} ${untouched}`);
      await tx.posHold.update({ where: { id: h.id }, data: { status: 'RELEASED', releasedAt: new Date() } });
      continue;
    }
    await tx.posHold.update({ where: { id: h.id }, data: { status: 'CONFIRMED', confirmedAt: h.confirmedAt ?? new Date(), salesOrderId: order.id, invoiceNo: h.invoiceNo ?? order.externalOrderId ?? null } });
  }
  return out;
}
