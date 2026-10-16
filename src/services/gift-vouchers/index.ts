/**
 * Gift vouchers (PLAN-gift-vouchers.md, agreed with POS 16 Oct 2026).
 *
 * Inventory holds every voucher's balance, the way it holds store credit: one balance for every till
 * (and the online shop later). The till takes the money, asks Inventory for a code (sell), checks a
 * code before using it (check), and spends it through the same reserve / confirm / release holds as
 * points and credit (pos-holds, kind VOUCHER), settled inside the sale event.
 *
 * Money from selling a voucher is not a sale: it is money the shop owes back in goods. It is kept
 * on the SOLD entry (payments) for the Day Book's own Gift vouchers section, never in sales or
 * profit. Spending a voucher pays part of a bill and is not money in.
 *
 * Every change to a balance is an entry (gift_voucher_entries) and gift_vouchers.balance_paise is
 * their sum, changed only under the voucher's row lock.
 */
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { badRequest, notFound } from '../../utils/httpError';
import { referenceIfClean } from '../payments/payment-rules';

type Tx = Prisma.TransactionClient;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: read off a printed voucher
export const CASH_LIMIT_PAISE = 2_00_000 * 100;       // section 269ST: ₹2,00,000 or more in cash is refused
const SOLD_WITH = ['CASH', 'UPI', 'CARD'] as const;
const MAX_MISSES_PER_MINUTE = 20;                     // wrong codes per till key, so codes cannot be guessed
export const REFUND_GRACE_DAYS = 30;                  // money returned onto an expired voucher can still be spent

/** A refusal the till shows as one plain line; `answer` is its code on the wire (same shape as pos-holds). */
export const refusal = (statusCode: number, answer: string, message: string) => ({ statusCode, answer, message });

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const masked = (e164: string | null) => !e164 ? null : e164.length > 7 ? `${e164.slice(0, 3)} ${e164.slice(3, 5)}${'•'.repeat(Math.max(3, e164.length - 7))}${e164.slice(-2)}` : e164;
const firstName = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] || null;

/** "gv7kq29xma", "GV-7KQ2 9XMA", "7KQ2-9XMA" all mean GV-7KQ2-9XMA. Null when it cannot be a code. */
export function normaliseCode(raw: unknown): string | null {
  const s = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/^GV/, '');
  return /^[A-Z0-9]{8}$/.test(s) ? `GV-${s.slice(0, 4)}-${s.slice(4)}` : null;
}

export function newCode(): string {
  const b = crypto.randomBytes(8);
  const c = Array.from(b, x => ALPHABET[x % 32]).join('');
  return `GV-${c.slice(0, 4)}-${c.slice(4)}`;
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────
const DEFAULTS = { enabled: false, validMonths: 12, minPaise: 50_000, maxPaise: 50_000_00 };

export async function getSettings(clientId: string, db: Tx | typeof prisma = prisma) {
  const s = await db.giftVoucherSettings.findUnique({ where: { clientId } });
  return s ? { enabled: s.enabled, validMonths: s.validMonths, minPaise: s.minPaise, maxPaise: s.maxPaise } : { ...DEFAULTS };
}

export async function saveSettings(clientId: string, body: any, userId: string | null) {
  const now = await getSettings(clientId);
  const next = {
    enabled: body?.enabled === undefined ? now.enabled : body.enabled === true,
    validMonths: body?.validMonths === undefined ? now.validMonths : Number(body.validMonths),
    minPaise: body?.minPaise === undefined ? now.minPaise : Number(body.minPaise),
    maxPaise: body?.maxPaise === undefined ? now.maxPaise : Number(body.maxPaise)
  };
  if (!Number.isInteger(next.validMonths) || next.validMonths < 1 || next.validMonths > 60) throw badRequest('Vouchers can be valid for 1 to 60 months.');
  if (!Number.isInteger(next.minPaise) || next.minPaise < 100) throw badRequest('The smallest voucher is at least ₹1.');
  if (!Number.isInteger(next.maxPaise) || next.maxPaise < next.minPaise) throw badRequest('The largest voucher cannot be smaller than the smallest.');
  if (next.maxPaise > 10_00_000 * 100) throw badRequest('Keep the largest voucher at ₹10,00,000 or less.');
  await prisma.giftVoucherSettings.upsert({ where: { clientId }, create: { clientId, ...next, updatedBy: userId }, update: { ...next, updatedBy: userId } });
  return next;
}

// ── Wrong-code limit ─────────────────────────────────────────────────────────────────────────────
// shortcut: in memory, one backend instance (as today on Render); move to the database if it ever scales out.
const misses = new Map<string, number[]>();
function tooManyMisses(who: string, now = Date.now()) {
  const recent = (misses.get(who) ?? []).filter(t => now - t < 60_000);
  misses.set(who, recent);
  return recent.length >= MAX_MISSES_PER_MINUTE;
}
const missed = (who: string) => { misses.set(who, [...(misses.get(who) ?? []), Date.now()]); };
/** For tests. */
export const forgetMisses = () => misses.clear();

// ── Selling (POST /pos/v1/vouchers) ─────────────────────────────────────────────────────────────
const shapeSold = (v: { code: string; initialPaise: number; balancePaise: number; expiresAt: Date; status: string }) =>
  ({ code: v.code, amountPaise: v.initialPaise, balancePaise: v.balancePaise, expiresAt: v.expiresAt.toISOString(), status: v.status });

/** A UPI / card reference already used on a bill or another voucher in this shop. */
async function referenceUsed(db: Tx | typeof prisma, clientId: string, reference: string) {
  const onBill = await db.salesOrderPayment.findFirst({ where: { clientId, reference, method: { in: ['UPI', 'CARD'] } }, select: { id: true } });
  if (onBill) return true;
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM gift_voucher_entries
     WHERE client_id = ${clientId} AND kind = 'SOLD' AND payments @> ${JSON.stringify([{ reference }])}::jsonb LIMIT 1`;
  return rows.length > 0;
}

export async function sell(clientId: string, till: { connectionId: string; locationId: string | null }, body: any) {
  const key = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (!key || key.length > 120) throw badRequest('Send an idempotencyKey for the sale, up to 120 characters.');
  const same = await prisma.giftVoucher.findUnique({ where: { clientId_idempotencyKey: { clientId, idempotencyKey: key } } });
  if (same) return shapeSold(same);

  const s = await getSettings(clientId);
  if (!s.enabled) throw refusal(422, 'VOUCHERS_OFF', 'Gift vouchers are switched off for this shop.');
  const amount = Number(body?.amountPaise);
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Say the voucher amount in whole paise, in amountPaise.');
  if (amount < s.minPaise || amount > s.maxPaise) throw refusal(422, 'AMOUNT', `A voucher here is ${rupees(s.minPaise)} to ${rupees(s.maxPaise)}.`);

  const rawPayments = Array.isArray(body?.payments) ? body.payments : [];
  if (!rawPayments.length || rawPayments.length > 6) throw badRequest('Say how the voucher was paid: 1 to 6 payments.');
  const payments: { method: string; amountPaise: number; reference: string | null }[] = [];
  for (const p of rawPayments) {
    const method = String(p?.method ?? '').toUpperCase();
    if (!(SOLD_WITH as readonly string[]).includes(method)) throw refusal(422, 'BAD_PAYMENT', 'A voucher is paid for in cash, UPI or card.');
    const paise = Number(p?.amountPaise);
    if (!Number.isInteger(paise) || paise <= 0) throw badRequest('Each payment needs amountPaise, a whole number above zero.');
    const ref = referenceIfClean(method as any, p?.reference);
    if (ref.problem) throw refusal(422, 'BAD_REFERENCE', ref.problem);
    payments.push({ method, amountPaise: paise, reference: ref.reference });
  }
  const paid = payments.reduce((t, p) => t + p.amountPaise, 0);
  if (paid !== amount) throw refusal(422, 'PAYMENTS_DONT_ADD_UP', `The payments come to ${rupees(paid)}, not the ${rupees(amount)} voucher.`);
  const cash = payments.filter(p => p.method === 'CASH').reduce((t, p) => t + p.amountPaise, 0);
  if (cash >= CASH_LIMIT_PAISE) throw refusal(422, 'CASH_LIMIT', 'Cash of ₹2,00,000 or more for one voucher cannot be taken (Income Tax Act, section 269ST). Take the rest by UPI or card.');
  const refs = payments.map(p => p.reference).filter((r): r is string => !!r);
  if (new Set(refs).size !== refs.length) throw refusal(409, 'REFERENCE_USED', 'The same reference is on two payments.');
  for (const r of refs) if (await referenceUsed(prisma, clientId, r)) throw refusal(409, 'REFERENCE_USED', `Reference ${r} is already on a bill or another voucher here.`);

  const buyerName = typeof body?.buyer?.name === 'string' ? body.buyer.name.trim().slice(0, 80) || null : null;
  let buyerPhone: string | null = null;
  if (body?.buyer?.phone) {
    const n = normalisePhone(body.buyer.phone);
    if (!n.ok) throw refusal(422, 'BAD_PHONE', n.reason);
    buyerPhone = n.value;
  }
  const buyer = buyerPhone ? await prisma.customer.findFirst({ where: { clientId, phone: buyerPhone, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } }) : null;

  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + s.validMonths);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const v = await tx.giftVoucher.create({ data: {
          clientId, code: newCode(), initialPaise: amount, balancePaise: amount, status: 'ACTIVE', expiresAt,
          soldLocationId: till.locationId, soldConnectionId: till.connectionId,
          buyerCustomerId: buyer?.id ?? null, buyerName: buyerName ?? buyer?.name ?? null, buyerPhone, idempotencyKey: key
        } });
        await tx.giftVoucherEntry.create({ data: {
          clientId, voucherId: v.id, kind: 'SOLD', amountPaise: amount, balancePaise: amount, payments: payments as any,
          locationId: till.locationId, createdBy: `till:${till.connectionId}`, onceKey: `SOLD:${v.id}`
        } });
        return shapeSold(v);
      });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      // The same key arriving twice at once: the first one is the voucher.
      const won = await prisma.giftVoucher.findUnique({ where: { clientId_idempotencyKey: { clientId, idempotencyKey: key } } });
      if (won) return shapeSold(won);
      // Otherwise a code collision (1 in a trillion): try a new code.
    }
  }
  throw new Error('Could not make a voucher code; try again.');
}

// ── Checking (GET /pos/v1/vouchers/:code) ──────────────────────────────────────────────────────
/** What is held against a voucher by tills right now. Sweeps its expired reserves first. */
export async function heldOn(db: Tx | typeof prisma, clientId: string, voucherId: string, now = new Date()) {
  await db.posHold.updateMany({ where: { clientId, giftVoucherId: voucherId, status: 'RESERVED', expiresAt: { lt: now } }, data: { status: 'SWEPT', releasedAt: now } });
  const live = await db.posHold.aggregate({ where: { clientId, giftVoucherId: voucherId, kind: 'VOUCHER', salesOrderId: null, OR: [{ status: 'RESERVED' }, { status: 'CONFIRMED' }] }, _sum: { amount: true } });
  return live._sum.amount ?? 0;
}

/** Why a voucher cannot be spent now, or null. */
export function unusable(v: { status: string; expiresAt: Date }, available: number, now = new Date()): { status: string; reason: string } | null {
  if (v.status === 'BLOCKED') return { status: 'BLOCKED', reason: 'This voucher has been blocked by the shop.' };
  if (v.expiresAt.getTime() < now.getTime()) return { status: 'EXPIRED', reason: `This voucher expired on ${day(v.expiresAt)}.` };
  if (available <= 0) return { status: 'USED_UP', reason: 'Nothing is left on this voucher.' };
  return null;
}

export async function check(clientId: string, who: string, rawCode: unknown, rawBill: unknown) {
  if (tooManyMisses(who)) throw refusal(429, 'TOO_MANY_TRIES', 'Too many wrong codes from this till. Wait a minute and type it again.');
  const code = normaliseCode(rawCode);
  const v = code ? await prisma.giftVoucher.findUnique({ where: { clientId_code: { clientId, code } } }) : null;
  if (!v) {
    missed(who);
    return { code: code ?? String(rawCode ?? '').slice(0, 20), status: 'UNKNOWN', balancePaise: 0, usablePaise: 0, expiresAt: null, buyerName: null, buyerPhone: null, reason: 'No voucher with that code here.' };
  }
  const bill = rawBill === undefined || rawBill === null || rawBill === '' ? null : Number(rawBill);
  if (bill !== null && (!Number.isInteger(bill) || bill < 0)) throw badRequest('Say the bill in whole paise, in billPaise.');
  const available = Math.max(0, v.balancePaise - await heldOn(prisma, clientId, v.id));
  const no = unusable(v, available);
  return {
    code: v.code, status: no?.status ?? 'ACTIVE', balancePaise: available,
    usablePaise: no ? 0 : bill === null ? available : Math.min(available, bill),
    expiresAt: v.expiresAt.toISOString(), buyerName: firstName(v.buyerName), buyerPhone: masked(v.buyerPhone),
    reason: no?.reason ?? null
  };
}

/** For pos-holds: the voucher a till names, locked, with what may be held on it. */
export async function lockForHold(tx: Tx, clientId: string, who: string, rawCode: unknown, now = new Date()) {
  if (tooManyMisses(who)) throw refusal(429, 'TOO_MANY_TRIES', 'Too many wrong codes from this till. Wait a minute and type it again.');
  const code = normaliseCode(rawCode);
  const v = code ? await tx.giftVoucher.findUnique({ where: { clientId_code: { clientId, code } } }) : null;
  if (!v) { missed(who); throw refusal(404, 'UNKNOWN_VOUCHER', 'No voucher with that code here.'); }
  await tx.$queryRaw`SELECT id FROM gift_vouchers WHERE id = ${v.id} AND client_id = ${clientId} FOR UPDATE`;
  const fresh = await tx.giftVoucher.findUniqueOrThrow({ where: { id: v.id } });
  const available = Math.max(0, fresh.balancePaise - await heldOn(tx, clientId, v.id, now));
  const no = unusable(fresh, available, now);
  if (no) throw refusal(409, no.status === 'USED_UP' ? 'NOT_ENOUGH' : no.status, no.reason);
  return { voucher: fresh, available };
}

/**
 * Inside the sale's transaction (pos-holds settleOnSale): take the held amount off the voucher.
 * Throws when the balance is no longer there, so the caller warns and releases, like credit.
 */
export async function spendOnSale(tx: Tx, clientId: string, p: { voucherId: string; paise: number; orderId: string; invoiceNo: string | null; holdId: string; locationId?: string | null }) {
  await tx.$queryRaw`SELECT id FROM gift_vouchers WHERE id = ${p.voucherId} AND client_id = ${clientId} FOR UPDATE`;
  const v = await tx.giftVoucher.findUniqueOrThrow({ where: { id: p.voucherId } });
  if (v.balancePaise < p.paise) throw new Error(`voucher ${v.code} has only ${rupees(v.balancePaise)} left`);
  const balance = v.balancePaise - p.paise;
  await tx.giftVoucher.update({ where: { id: v.id }, data: { balancePaise: balance } });
  await tx.giftVoucherEntry.create({ data: {
    clientId, voucherId: v.id, kind: 'USED', amountPaise: -p.paise, balancePaise: balance, salesOrderId: p.orderId, invoiceNo: p.invoiceNo,
    locationId: p.locationId ?? null, onceKey: `USED:${p.orderId}:${p.holdId}`
  } });
  return v.code;
}

/**
 * A return of a bill paid (partly) by voucher: that part goes back onto the voucher(s) that paid it,
 * never out as money. The code the till sends picks the voucher; without one, the vouchers that paid
 * this bill are refilled in order. Money returned onto an expired voucher gets REFUND_GRACE_DAYS to
 * be spent -- the customer did nothing wrong by returning something.
 * Returns the codes credited, for the REFUND row's reference.
 */
export async function refundOntoVouchers(tx: Tx, clientId: string, p: { orderId: string; returnId: string; paise: number; code?: string | null; locationId?: string | null }) {
  const used = await tx.giftVoucherEntry.findMany({ where: { clientId, salesOrderId: p.orderId, kind: 'USED' }, orderBy: { createdAt: 'asc' } });
  if (!used.length) throw badRequest('This bill was not paid with a gift voucher, so nothing can go back onto one.');
  const already = await tx.giftVoucherEntry.findMany({ where: { clientId, salesOrderId: p.orderId, kind: 'REFUNDED' } });
  const want = normaliseCode(p.code);
  const byVoucher = new Map<string, number>();
  for (const u of used) byVoucher.set(u.voucherId, (byVoucher.get(u.voucherId) ?? 0) - u.amountPaise);
  for (const r of already) byVoucher.set(r.voucherId, (byVoucher.get(r.voucherId) ?? 0) - r.amountPaise);
  const order = [...byVoucher.keys()];
  if (want) {
    const v = await tx.giftVoucher.findUnique({ where: { clientId_code: { clientId, code: want } } });
    if (!v || !byVoucher.has(v.id)) throw badRequest(`Voucher ${want} did not pay this bill.`);
    order.sort((a, b) => (a === v.id ? -1 : b === v.id ? 1 : 0));
  }
  const room = [...byVoucher.values()].reduce((t, x) => t + Math.max(0, x), 0);
  if (p.paise > room) throw badRequest(`Only ${rupees(room)} of this bill was paid by voucher and not yet returned.`);
  let left = p.paise;
  const codes: string[] = [];
  for (const id of order) {
    if (left <= 0) break;
    const back = Math.min(left, Math.max(0, byVoucher.get(id) ?? 0));
    if (!back) continue;
    await tx.$queryRaw`SELECT id FROM gift_vouchers WHERE id = ${id} AND client_id = ${clientId} FOR UPDATE`;
    const v = await tx.giftVoucher.findUniqueOrThrow({ where: { id } });
    const balance = v.balancePaise + back;
    const graceUntil = new Date(Date.now() + REFUND_GRACE_DAYS * 86_400_000);
    await tx.giftVoucher.update({ where: { id }, data: { balancePaise: balance, ...(v.expiresAt < graceUntil ? { expiresAt: graceUntil } : {}) } });
    await tx.giftVoucherEntry.create({ data: {
      clientId, voucherId: id, kind: 'REFUNDED', amountPaise: back, balancePaise: balance, salesOrderId: p.orderId, locationId: p.locationId ?? null,
      note: v.expiresAt < graceUntil ? `Returned goods; valid until ${day(graceUntil)}` : 'Returned goods', onceKey: `REFUNDED:${p.returnId}:${id}`
    } });
    codes.push(v.code);
    left -= back;
  }
  return codes;
}

// ── The shop's screens ──────────────────────────────────────────────────────────────────────────
export async function summary(clientId: string, now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const soon = new Date(now.getTime() + 30 * 86_400_000);
  const [owed, sold, expiring] = await Promise.all([
    prisma.giftVoucher.aggregate({ where: { clientId, status: 'ACTIVE', expiresAt: { gte: now }, balancePaise: { gt: 0 } }, _sum: { balancePaise: true }, _count: true }),
    prisma.giftVoucher.aggregate({ where: { clientId, soldAt: { gte: monthStart } }, _sum: { initialPaise: true }, _count: true }),
    prisma.giftVoucher.count({ where: { clientId, status: 'ACTIVE', balancePaise: { gt: 0 }, expiresAt: { gte: now, lte: soon } } })
  ]);
  return {
    owedPaise: owed._sum.balancePaise ?? 0, openVouchers: owed._count,
    soldThisMonthPaise: sold._sum.initialPaise ?? 0, soldThisMonth: sold._count, expiringIn30Days: expiring
  };
}

export async function list(clientId: string, q: { search?: unknown; status?: unknown }, now = new Date()) {
  const text = String(q.search ?? '').trim();
  const code = normaliseCode(text);
  const phone = text ? normalisePhone(text) : null;
  const where: Prisma.GiftVoucherWhereInput = { clientId };
  if (text) where.OR = [
    ...(code ? [{ code }] : []),
    { code: { contains: text.toUpperCase() } },
    ...(phone?.ok ? [{ buyerPhone: phone.value }] : []),
    { buyerName: { contains: text, mode: 'insensitive' } }
  ];
  const status = String(q.status ?? '');
  if (status === 'OPEN') Object.assign(where, { status: 'ACTIVE', expiresAt: { gte: now }, balancePaise: { gt: 0 } });
  // Same order as `state` below (blocked, then expired, then used up), so a filter never shows a row labelled otherwise.
  if (status === 'USED_UP') Object.assign(where, { status: 'ACTIVE', expiresAt: { gte: now }, balancePaise: { lte: 0 } });
  if (status === 'EXPIRED') Object.assign(where, { status: 'ACTIVE', expiresAt: { lt: now } });
  if (status === 'BLOCKED') Object.assign(where, { status: 'BLOCKED' });
  const rows = await prisma.giftVoucher.findMany({ where, orderBy: { soldAt: 'desc' }, take: 200 });
  return rows.map(v => ({
    id: v.id, code: v.code, initialPaise: v.initialPaise, balancePaise: v.balancePaise, soldAt: v.soldAt, expiresAt: v.expiresAt,
    buyerName: v.buyerName, buyerPhone: v.buyerPhone, buyerCustomerId: v.buyerCustomerId,
    state: v.status === 'BLOCKED' ? 'BLOCKED' : v.expiresAt < now ? 'EXPIRED' : v.balancePaise <= 0 ? 'USED_UP' : 'OPEN'
  }));
}

export async function detail(clientId: string, id: string) {
  const v = await prisma.giftVoucher.findFirst({ where: { id, clientId } });
  if (!v) throw notFound('That voucher could not be found.');
  const entries = await prisma.giftVoucherEntry.findMany({ where: { clientId, voucherId: id }, orderBy: { createdAt: 'asc' } });
  const orderIds = [...new Set(entries.map(e => e.salesOrderId).filter((x): x is string => !!x))];
  const orders = orderIds.length ? await prisma.salesOrder.findMany({ where: { id: { in: orderIds }, clientId }, select: { id: true, orderNumber: true, externalOrderId: true } }) : [];
  const locIds = [...new Set(entries.map(e => e.locationId).filter((x): x is string => !!x))];
  const locs = locIds.length ? await prisma.stockLocation.findMany({ where: { id: { in: locIds }, clientId }, select: { id: true, name: true } }) : [];
  return {
    id: v.id, code: v.code, initialPaise: v.initialPaise, balancePaise: v.balancePaise, status: v.status, expiresAt: v.expiresAt, soldAt: v.soldAt,
    buyerName: v.buyerName, buyerPhone: v.buyerPhone, buyerCustomerId: v.buyerCustomerId,
    entries: entries.map(e => {
      const o = orders.find(x => x.id === e.salesOrderId);
      return {
        id: e.id, kind: e.kind, amountPaise: e.amountPaise, balancePaise: e.balancePaise, at: e.createdAt, note: e.note,
        payments: e.payments, store: locs.find(l => l.id === e.locationId)?.name ?? null,
        order: o ? { id: o.id, number: o.externalOrderId || o.orderNumber } : null, invoiceNo: e.invoiceNo, by: e.createdBy
      };
    })
  };
}

async function changeOne(clientId: string, id: string, userId: string | null, change: (v: any) => { data: Prisma.GiftVoucherUpdateInput; kind: string; note: string }) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM gift_vouchers WHERE id = ${id} AND client_id = ${clientId} FOR UPDATE`;
    const v = await tx.giftVoucher.findFirst({ where: { id, clientId } });
    if (!v) throw notFound('That voucher could not be found.');
    const c = change(v);
    await tx.giftVoucher.update({ where: { id }, data: c.data });
    await tx.giftVoucherEntry.create({ data: { clientId, voucherId: id, kind: c.kind, amountPaise: 0, balancePaise: v.balancePaise, note: c.note, createdBy: userId, onceKey: `${c.kind}:${id}:${crypto.randomUUID()}` } });
  });
  // Read after the change is saved, so the answer shows it.
  return detail(clientId, id);
}

/** Staff extend a voucher by whole months, before it expires (the owner's rule: after expiry the shop keeps the money). */
export async function extend(clientId: string, id: string, months: unknown, userId: string | null) {
  const m = Number(months);
  if (!Number.isInteger(m) || m < 1 || m > 24) throw badRequest('Extend by 1 to 24 months.');
  return changeOne(clientId, id, userId, v => {
    if (v.expiresAt < new Date()) throw badRequest(`This voucher expired on ${day(v.expiresAt)}. It can only be extended before it expires.`);
    const to = new Date(v.expiresAt); to.setMonth(to.getMonth() + m);
    return { data: { expiresAt: to }, kind: 'EXTENDED', note: `Valid until ${day(to)} (was ${day(v.expiresAt)})` };
  });
}

export async function block(clientId: string, id: string, reason: unknown, userId: string | null) {
  const why = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (why.length < 3) throw badRequest('Say why the voucher is being blocked, like "lost".');
  return changeOne(clientId, id, userId, v => {
    if (v.status === 'BLOCKED') throw badRequest('This voucher is already blocked.');
    return { data: { status: 'BLOCKED' }, kind: 'BLOCKED', note: why.slice(0, 200) };
  });
}

export async function unblock(clientId: string, id: string, userId: string | null) {
  return changeOne(clientId, id, userId, v => {
    if (v.status !== 'BLOCKED') throw badRequest('This voucher is not blocked.');
    return { data: { status: 'ACTIVE' }, kind: 'UNBLOCKED', note: 'Unblocked' };
  });
}

/**
 * The Day Book's Gift vouchers section for [from, to): what was sold (by how it was paid), spent on
 * bills, and returned onto vouchers; and what the shop owes in vouchers now. Not sales, not profit.
 */
export async function dayBook(clientId: string, from: Date, to: Date, locationId?: string | null) {
  const where: Prisma.GiftVoucherEntryWhereInput = { clientId, createdAt: { gte: from, lt: to }, ...(locationId ? { locationId } : {}) };
  const entries = await prisma.giftVoucherEntry.findMany({ where: { ...where, kind: { in: ['SOLD', 'USED', 'REFUNDED'] } }, select: { kind: true, amountPaise: true, payments: true } });
  const soldBy: Record<string, number> = {};
  let sold = 0, soldCount = 0, used = 0, refunded = 0;
  for (const e of entries) {
    if (e.kind === 'SOLD') {
      sold += e.amountPaise; soldCount += 1;
      for (const p of (e.payments as any[]) ?? []) soldBy[p.method] = (soldBy[p.method] ?? 0) + Number(p.amountPaise || 0);
    } else if (e.kind === 'USED') used += -e.amountPaise;
    else refunded += e.amountPaise;
  }
  const s = await summary(clientId, to < new Date() ? to : new Date());
  return { soldPaise: sold, soldCount, soldByMethodPaise: soldBy, usedPaise: used, refundedPaise: refunded, owedPaise: s.owedPaise };
}
