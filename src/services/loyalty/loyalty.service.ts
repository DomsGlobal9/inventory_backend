/**
 * Loyalty points: customers earn them on what they pay, and spend them at the counter.
 *
 * Its own module. The counter sale asks it two things inside the sale's transaction -- may these
 * points pay this much, and write what was earned and used -- and a completed return asks it to
 * undo the returned goods' share. The rules themselves are in rules.ts, free of the database.
 *
 * THE BALANCE: every change is an entry in loyalty_entries, and customers.loyalty_points is their
 * sum. Both are written together, and a debit is one guarded UPDATE ("only if at least this many
 * are held"), so two tills spending the same points at the same moment cannot both succeed.
 *
 * ONCE ONLY: every entry has a once-key ("EARNED:<order>", "BIRTHDAY:<customer>:2026"). A retried
 * sale, a job that runs twice, or two servers running it together all find the entry already there
 * and change nothing. Inserted with ON CONFLICT DO NOTHING, because a failed insert inside a
 * Postgres transaction would abort the whole sale.
 */
import { LoyaltyEntryKind, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, forbidden, notFound } from '../../utils/httpError';
import { grants, holdsEverything } from '../../config/permissions';
import { fromMinor, toMinor } from '../pricing';
import {
  checkRules, DEFAULT_RULES, LoyaltyRules, mostUsable, pointsEarned, pointsForPayment, rupeesOf, shareBetween, valueOf
} from './rules';

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; clientId: string; name?: string | null; permissions?: string[]; roles?: string[] };

const may = (a: Actor, key: string) => holdsEverything(a.permissions, a.roles) || grants(a.permissions ?? [], key);

export type LoyaltySettingsView = LoyaltyRules & {
  enabled: boolean;
  notifyAfterSale: boolean;
  birthdayWish: boolean;
  birthdayText: string | null;
  anniversaryWish: boolean;
  anniversaryText: string | null;
  expiryReminder: boolean;
};

export const DEFAULT_BIRTHDAY_TEXT = 'Happy birthday, {name}! Wishing you a wonderful year from all of us at {shop}.';
export const DEFAULT_ANNIVERSARY_TEXT = 'Happy anniversary, {name}! Warm wishes from all of us at {shop}.';

export async function getSettings(clientId: string, db: Tx | typeof prisma = prisma): Promise<LoyaltySettingsView> {
  const row = await db.loyaltySettings.findUnique({ where: { clientId } });
  return {
    enabled: row?.enabled ?? false,
    pointsPer100: row?.pointsPer100 ?? DEFAULT_RULES.pointsPer100,
    pointValuePaise: row?.pointValuePaise ?? DEFAULT_RULES.pointValuePaise,
    minRedeemPoints: row?.minRedeemPoints ?? DEFAULT_RULES.minRedeemPoints,
    maxRedeemPercent: row?.maxRedeemPercent ?? DEFAULT_RULES.maxRedeemPercent,
    expiryMonths: row?.expiryMonths ?? DEFAULT_RULES.expiryMonths,
    birthdayPoints: row?.birthdayPoints ?? DEFAULT_RULES.birthdayPoints,
    notifyAfterSale: row?.notifyAfterSale ?? false,
    birthdayWish: row?.birthdayWish ?? false,
    birthdayText: row?.birthdayText ?? null,
    anniversaryWish: row?.anniversaryWish ?? false,
    anniversaryText: row?.anniversaryText ?? null,
    expiryReminder: row?.expiryReminder ?? false
  };
}

const MAX_WISH = 700;
function wishText(raw: unknown, what: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') throw badRequest(`Write the ${what} message as text.`);
  const t = raw.trim();
  if (t.length > MAX_WISH) throw badRequest(`Keep the ${what} message under ${MAX_WISH} letters.`);
  return t || null;
}
function flag(raw: unknown, what: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw badRequest(`Say yes or no for ${what}.`);
  return raw;
}

export async function saveSettings(actor: Actor, input: Record<string, unknown>) {
  if (!may(actor, 'loyalty:manage')) throw forbidden('Setting loyalty points is not part of your role. Ask the owner.');
  const rules = checkRules(input as any);
  const data = {
    ...rules,
    enabled: flag(input.enabled, 'loyalty points'),
    notifyAfterSale: flag(input.notifyAfterSale, 'the message after a sale'),
    birthdayWish: flag(input.birthdayWish, 'birthday wishes'),
    anniversaryWish: flag(input.anniversaryWish, 'anniversary wishes'),
    expiryReminder: flag(input.expiryReminder, 'the reminder before points lapse'),
    birthdayText: wishText(input.birthdayText, 'birthday'),
    anniversaryText: wishText(input.anniversaryText, 'anniversary')
  };
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await prisma.loyaltySettings.upsert({
    where: { clientId: actor.clientId },
    create: { clientId: actor.clientId, ...clean, updatedBy: actor.id },
    update: { ...clean, updatedBy: actor.id }
  });
  return getSettings(actor.clientId);
}

// ── Writing entries ─────────────────────────────────────────────────────────────────────────

type Entry = {
  clientId: string;
  customerId: string;
  kind: LoyaltyEntryKind;
  points: number;
  onceKey: string;
  salesOrderId?: string | null;
  salesReturnId?: string | null;
  note?: string | null;
  createdById?: string | null;
  /** Counts as the customer being active (earning or using), which holds off expiry. */
  activity?: boolean;
  /** May leave the balance below zero -- a return taking back points already spent. */
  mayGoNegative?: boolean;
};

/**
 * One change to a customer's points, inside the caller's transaction. Returns the new balance, or
 * null when this once-key was already written (nothing changed).
 *
 * ONE STATEMENT. The customer's row is locked, the entry inserted with the balance it leaves, and
 * the balance moved, all in one round trip: a counter sale waits on every trip to a database in
 * another region, and three per change made a sale with points seconds slower. The entry is only
 * written when the balance may move (a guarded debit that would go below zero writes nothing), and
 * the balance only moves when the entry was new (a repeated once-key changes nothing).
 */
export async function post(tx: Tx, e: Entry): Promise<number | null> {
  if (!Number.isInteger(e.points) || e.points === 0) return null;
  const guard = e.points < 0 && !e.mayGoNegative;
  const rows = await tx.$queryRaw<{ balance: number | null; held: number | null }[]>`
    WITH cur AS (
      SELECT id, loyalty_points FROM customers WHERE id = ${e.customerId} AND client_id = ${e.clientId} FOR UPDATE
    ), ins AS (
      -- clock_timestamp, not the column default: two entries in one transaction (points used, then
      -- earned) would otherwise share its start time and list in either order.
      INSERT INTO loyalty_entries (id, client_id, customer_id, kind, points, balance, sales_order_id, sales_return_id, note, created_by_id, once_key, created_at)
      SELECT gen_random_uuid()::text, ${e.clientId}, cur.id, ${e.kind}::"LoyaltyEntryKind", ${e.points}, cur.loyalty_points + ${e.points},
             ${e.salesOrderId ?? null}, ${e.salesReturnId ?? null}, ${e.note ?? null}, ${e.createdById ?? null}, ${e.onceKey}, clock_timestamp()
        FROM cur
       WHERE (${!guard} OR cur.loyalty_points + ${e.points} >= 0)
      ON CONFLICT (once_key) DO NOTHING
      RETURNING balance
    ), moved AS (
      UPDATE customers
         SET loyalty_points = loyalty_points + ${e.points},
             -- A purchase or a use restarts the lapse clock; the first points of any kind start it,
             -- so a birthday gift to somebody who never bought does not lapse the next morning.
             loyalty_active_at = CASE WHEN ${!!e.activity} THEN NOW() ELSE COALESCE(loyalty_active_at, NOW()) END,
             updated_at = NOW()
       WHERE id = ${e.customerId} AND EXISTS (SELECT 1 FROM ins)
      RETURNING loyalty_points
    )
    SELECT (SELECT balance FROM ins) AS balance, (SELECT loyalty_points FROM cur) AS held`;
  const r = rows[0];
  if (r?.balance !== null && r?.balance !== undefined) return Number(r.balance);
  if (r?.held === null || r?.held === undefined) throw notFound('Customer not found');
  // Nothing written: either this once-key was already done, or a guarded debit would go below zero.
  const already = await tx.loyaltyEntry.findUnique({ where: { onceKey: e.onceKey }, select: { id: true } });
  if (already) return null;
  throw badRequest('The customer does not have that many points any more. Check their points and try again.');
}

// ── At the counter ─────────────────────────────────────────────────────────────────────────

/** What the New sale screen shows once a customer is chosen. */
export async function forCounter(clientId: string, customerId: string | null, billMinor: number | null) {
  const s = await getSettings(clientId);
  if (!s.enabled) return { enabled: false as const };
  const held = customerId
    ? (await prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { loyaltyPoints: true } }))?.loyaltyPoints ?? 0
    : 0;
  const usable = billMinor && billMinor > 0 ? mostUsable(held, billMinor, s) : 0;
  return {
    enabled: true as const,
    points: held,
    value: valueOf(Math.max(0, held), s) / 100,
    pointValue: s.pointValuePaise / 100,
    minRedeemPoints: s.minRedeemPoints,
    maxRedeemPercent: s.maxRedeemPercent,
    usablePoints: usable,
    usableValue: valueOf(usable, s) / 100,
    earnsPer100: s.pointsPer100
  };
}

/**
 * Inside the counter sale's transaction, once the bill is written: take the points used on it and
 * give the points earned. Refuses the sale if points were used that the customer may not spend.
 */
export type SaleCheck = { settings: LoyaltySettingsView; held?: number };

/**
 * Before the sale's transaction opens: the rules, and what the customer holds, so a points payment
 * that cannot be allowed is refused with its reason without holding a transaction open. Inside the
 * transaction the debit is still guarded, so points spent at another till meanwhile cannot go twice.
 */
export async function checkSale(clientId: string, customerId: string | null, billMinor: number | null, pointsPaidMinor: number): Promise<SaleCheck> {
  const [settings, customer] = await Promise.all([
    getSettings(clientId),
    customerId ? prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { loyaltyPoints: true } }) : null
  ]);
  if (pointsPaidMinor > 0) {
    if (!settings.enabled) throw badRequest('Loyalty points are switched off for this shop. Take the payment another way.');
    // The share of the bill needs the bill as written; checked inside the sale when that is known.
    if (billMinor !== null) pointsForPayment(pointsPaidMinor, billMinor, customer?.loyaltyPoints ?? 0, settings);
  }
  return { settings, held: customer?.loyaltyPoints ?? 0 };
}

/**
 * Inside the counter sale's transaction, once the bill is written: take the points used on it and
 * give the points earned. Refuses the sale if points were used that the customer may not spend.
 */
export async function settleSale(tx: Tx, input: {
  clientId: string; customerId: string; orderId: string; billMinor: number; pointsPaidMinor: number; userId: string | null;
}, checked?: SaleCheck) {
  const s = checked?.settings ?? await getSettings(input.clientId, tx);
  if (!s.enabled) {
    if (input.pointsPaidMinor > 0) throw badRequest('Loyalty points are switched off for this shop. Take the payment another way.');
    return { earned: 0, used: 0, balance: null as number | null };
  }

  let used = 0;
  let balance: number | null = null;
  if (input.pointsPaidMinor > 0) {
    // The bill as written can differ from the screen's (a price changed): checked again against it.
    const held = checked?.held !== undefined ? checked.held
      : (await tx.customer.findFirst({ where: { id: input.customerId, clientId: input.clientId }, select: { loyaltyPoints: true } }))?.loyaltyPoints ?? 0;
    used = pointsForPayment(input.pointsPaidMinor, input.billMinor, held, s);
    balance = await post(tx, {
      clientId: input.clientId, customerId: input.customerId, kind: 'USED', points: -used,
      onceKey: `USED:${input.orderId}`, salesOrderId: input.orderId, createdById: input.userId, activity: true,
      note: `${rupeesOf(input.pointsPaidMinor)} off the bill`
    });
  }

  const earned = pointsEarned(input.billMinor - input.pointsPaidMinor, s);
  if (earned > 0) {
    balance = await post(tx, {
      clientId: input.clientId, customerId: input.customerId, kind: 'EARNED', points: earned,
      onceKey: `EARNED:${input.orderId}`, salesOrderId: input.orderId, createdById: input.userId, activity: true
    });
  }
  return { earned, used, balance };
}

// ── Returns ────────────────────────────────────────────────────────────────────────────────

/** The points share of one return, worked out without writing anything. */
async function returnShare(db: Tx | typeof prisma, clientId: string, returnId: string) {
  const ret = await db.salesReturn.findFirst({
    where: { id: returnId, clientId },
    select: { id: true, returnNumber: true, refundTotal: true, salesOrderId: true, salesOrder: { select: { total: true, customerId: true } } }
  });
  if (!ret || !ret.salesOrder.customerId) return null;
  const orderEntries = await db.loyaltyEntry.findMany({
    where: { clientId, salesOrderId: ret.salesOrderId, kind: { in: ['EARNED', 'USED'] } },
    select: { kind: true, points: true }
  });
  if (orderEntries.length === 0) return null;
  const earned = orderEntries.filter(e => e.kind === 'EARNED').reduce((a, e) => a + e.points, 0);
  const used = -orderEntries.filter(e => e.kind === 'USED').reduce((a, e) => a + e.points, 0);

  const payments = await db.salesOrderPayment.findMany({
    where: { clientId, salesOrderId: ret.salesOrderId, kind: 'PAYMENT', method: 'POINTS' }, select: { amount: true }
  });
  const pointsPaidMinor = payments.reduce((a, p) => a + toMinor(p.amount as any), 0);
  const totalMinor = toMinor(ret.salesOrder.total as any);

  // Value already back from earlier completed returns of this bill: money owed plus points given back.
  const earlier = await db.salesReturn.findMany({
    where: { clientId, salesOrderId: ret.salesOrderId, status: 'COMPLETED', id: { not: ret.id } },
    select: { refundTotal: true, pointsBackValue: true }
  });
  const beforeMinor = earlier.reduce((a, r) => a + toMinor(r.refundTotal as any) + toMinor(r.pointsBackValue as any), 0);
  const thisMinor = toMinor(ret.refundTotal as any);
  const afterMinor = beforeMinor + thisMinor;

  const back = shareBetween(used, totalMinor, beforeMinor, afterMinor);
  const backMinor = used > 0 ? Math.min(thisMinor, Math.round((back * pointsPaidMinor) / used)) : 0;
  const takeBack = shareBetween(earned, totalMinor, beforeMinor, afterMinor);
  return { ret, customerId: ret.salesOrder.customerId, back, backMinor, takeBack, thisMinor };
}

/**
 * Inside the transaction that completes a return: give back the points used on the returned goods'
 * share of the bill, take back the points earned on it, and lower the money owed by what went back
 * as points. Nothing to do for a bill with no points on it.
 */
export async function settleReturn(tx: Tx, clientId: string, returnId: string, userId: string | null = null) {
  const share = await returnShare(tx, clientId, returnId);
  if (!share) return null;
  const { ret, customerId, back, backMinor, takeBack, thisMinor } = share;

  if (back > 0) {
    await post(tx, {
      clientId, customerId, kind: 'RETURN_GIVEN_BACK', points: back, onceKey: `RETURN_GIVEN_BACK:${ret.id}`,
      salesOrderId: ret.salesOrderId, salesReturnId: ret.id, createdById: userId,
      note: `Return ${ret.returnNumber}: points used on these goods`
    });
  }
  if (takeBack > 0) {
    await post(tx, {
      clientId, customerId, kind: 'RETURN_TAKEN_BACK', points: -takeBack, onceKey: `RETURN_TAKEN_BACK:${ret.id}`,
      salesOrderId: ret.salesOrderId, salesReturnId: ret.id, createdById: userId, mayGoNegative: true,
      note: `Return ${ret.returnNumber}: points earned on these goods`
    });
  }
  if (back > 0 || takeBack > 0) {
    await tx.salesReturn.update({
      where: { id: ret.id },
      data: {
        pointsBack: back, pointsBackValue: fromMinor(backMinor), pointsTakenBack: takeBack,
        refundTotal: fromMinor(thisMinor - backMinor),
        ...(thisMinor - backMinor === 0 ? { refundStatus: 'NONE' } : {})
      }
    });
  }
  return { pointsBack: back, pointsBackValue: backMinor / 100, pointsTakenBack: takeBack };
}

/**
 * For a return not yet completed: how the amount owed will split between money and points, so the
 * person at the counter never pays in cash what is going back as points.
 */
export async function previewReturn(clientId: string, returnId: string) {
  const share = await returnShare(prisma, clientId, returnId);
  if (!share || (share.back === 0 && share.takeBack === 0)) return null;
  return {
    pointsBack: share.back,
    pointsBackValue: share.backMinor / 100,
    money: (share.thisMinor - share.backMinor) / 100,
    pointsTakenBack: share.takeBack
  };
}

// ── A customer's points ────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<LoyaltyEntryKind, string> = {
  EARNED: 'Earned on a purchase',
  USED: 'Used on a bill',
  RETURN_GIVEN_BACK: 'Given back (return)',
  RETURN_TAKEN_BACK: 'Taken back (return)',
  BIRTHDAY: 'Birthday gift',
  EXPIRED: 'Lapsed',
  ADJUSTED: 'Changed by hand'
};

export function lapseDate(activeAt: Date | null, months: number): Date | null {
  if (!activeAt || months <= 0) return null;
  const d = new Date(activeAt);
  d.setMonth(d.getMonth() + months);
  return d;
}

export async function customerPoints(clientId: string, customerId: string) {
  const [s, customer] = await Promise.all([
    getSettings(clientId),
    prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { loyaltyPoints: true, loyaltyActiveAt: true } })
  ]);
  if (!customer) throw notFound('Customer not found');
  const entries = await prisma.loyaltyEntry.findMany({
    where: { clientId, customerId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, kind: true, points: true, balance: true, note: true, salesOrderId: true, salesReturnId: true, createdAt: true }
  });
  const orderIds = [...new Set(entries.map(e => e.salesOrderId).filter(Boolean) as string[])];
  const orders = orderIds.length
    ? await prisma.salesOrder.findMany({ where: { id: { in: orderIds }, clientId }, select: { id: true, orderNumber: true } })
    : [];
  const numberOf = new Map(orders.map(o => [o.id, o.orderNumber]));
  const lapses = customer.loyaltyPoints > 0 ? lapseDate(customer.loyaltyActiveAt, s.expiryMonths) : null;
  return {
    enabled: s.enabled,
    points: customer.loyaltyPoints,
    value: valueOf(Math.max(0, customer.loyaltyPoints), s) / 100,
    lapsesOn: lapses,
    entries: entries.map(e => ({
      id: e.id, kind: e.kind, label: KIND_LABEL[e.kind], points: e.points, balance: e.balance, note: e.note,
      orderId: e.salesOrderId, orderNumber: e.salesOrderId ? numberOf.get(e.salesOrderId) ?? null : null,
      returnId: e.salesReturnId, at: e.createdAt
    }))
  };
}

/** Changed by hand, with a reason. One press is one change (the nonce is the once-key). */
export async function adjust(actor: Actor, customerId: string, input: { points: unknown; reason: unknown; nonce: unknown }) {
  if (!may(actor, 'loyalty:manage')) throw forbidden("Changing a customer's points is not part of your role. Ask the owner.");
  const points = input.points;
  if (typeof points !== 'number' || !Number.isInteger(points) || points === 0 || Math.abs(points) > 1_000_000) {
    throw badRequest('Enter how many points to add (or take away, with a minus), as a whole number.');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 3) throw badRequest('Say why the points are changing.');
  if (reason.length > 200) throw badRequest('Keep the reason under 200 letters.');
  const nonce = typeof input.nonce === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input.nonce) ? input.nonce : null;
  if (!nonce) throw badRequest('Reload the page and try again.');

  const customer = await prisma.customer.findFirst({ where: { id: customerId, clientId: actor.clientId, deletedAt: null }, select: { id: true } });
  if (!customer) throw notFound('Customer not found');
  await prisma.$transaction(tx => post(tx, {
    clientId: actor.clientId, customerId, kind: 'ADJUSTED', points, onceKey: `ADJUSTED:${customerId}:${nonce}`,
    note: reason, createdById: actor.id
  }), { timeout: 15000, maxWait: 10000 }).catch(e => {
    if (/does not have that many/.test(e?.message ?? '')) throw badRequest("That would take the customer's points below zero.");
    throw e;
  });
  return customerPoints(actor.clientId, customerId);
}

// ── Once a day ─────────────────────────────────────────────────────────────────────────────

/**
 * Points of customers quiet for longer than the shop's expiry lapse. Keyed by the day, so running
 * twice lapses once. Returns how many customers' points lapsed.
 */
export async function lapseQuietPoints(clientId: string, dayKey: string, now = new Date()): Promise<number> {
  const s = await getSettings(clientId);
  if (!s.enabled || s.expiryMonths <= 0) return 0;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - s.expiryMonths);
  const quiet = await prisma.customer.findMany({
    where: { clientId, deletedAt: null, loyaltyPoints: { gt: 0 }, loyaltyActiveAt: { lt: cutoff } },
    select: { id: true, loyaltyPoints: true },
    take: 2000
  });
  let lapsed = 0;
  for (const c of quiet) {
    const done = await prisma.$transaction(tx => post(tx, {
      clientId, customerId: c.id, kind: 'EXPIRED', points: -c.loyaltyPoints, onceKey: `EXPIRED:${c.id}:${dayKey}`,
      note: `No purchase for ${s.expiryMonths} months`, mayGoNegative: true
    })).catch(() => null);
    if (done !== null) lapsed += 1;
  }
  return lapsed;
}

/** The birthday gift, once a year per customer. Returns the new balance, or null if already given. */
export async function giveBirthdayPoints(clientId: string, customerId: string, year: number) {
  const s = await getSettings(clientId);
  if (!s.enabled || s.birthdayPoints <= 0) return null;
  return prisma.$transaction(tx => post(tx, {
    clientId, customerId, kind: 'BIRTHDAY', points: s.birthdayPoints, onceKey: `BIRTHDAY:${customerId}:${year}`,
    note: 'Birthday gift'
  }));
}

/** Short text for the WhatsApp after a sale, or null when there is nothing worth saying. */
export async function afterSaleText(clientId: string, orderId: string, shopName: string) {
  const s = await getSettings(clientId);
  if (!s.enabled || !s.notifyAfterSale) return null;
  const order = await prisma.salesOrder.findFirst({
    where: { id: orderId, clientId },
    select: { orderNumber: true, customer: { select: { id: true, name: true, phone: true, loyaltyPoints: true, whatsappStoppedAt: true } } }
  });
  const c = order?.customer;
  if (!c?.phone || c.whatsappStoppedAt) return null;
  const earned = await prisma.loyaltyEntry.findUnique({ where: { onceKey: `EARNED:${orderId}` }, select: { points: true } });
  const used = await prisma.loyaltyEntry.findUnique({ where: { onceKey: `USED:${orderId}` }, select: { points: true } });
  if (!earned && !used) return null;
  const lines = [`Thank you for shopping at ${shopName}, ${c.name.split(' ')[0]}!`];
  if (used) lines.push(`You used ${(-used.points).toLocaleString('en-IN')} points on bill ${order!.orderNumber}.`);
  if (earned) lines.push(`You earned ${earned.points.toLocaleString('en-IN')} points.`);
  lines.push(`You now have *${c.loyaltyPoints.toLocaleString('en-IN')} points* (worth ${rupeesOf(valueOf(Math.max(0, c.loyaltyPoints), s))}).`);
  return { customerId: c.id, phone: c.phone, text: lines.join('\n') };
}
