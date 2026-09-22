/**
 * A customer brings something back to the counter: take it back and pay them back, in one go.
 *
 * The ordinary return is built for a parcel: booked, then received, checked and completed as it
 * travels. At the counter the piece is already in the cashier's hand, so here the same steps run
 * together in one transaction -- the same code (return.service) books it, restocks it and settles
 * loyalty points, and then the money going back is RECORDED: cash, UPI, card, or store credit.
 *
 * THE RULES
 *   Who        Anyone with return:counter (salespeople, by default), or whoever may both book and
 *              finish returns.
 *   Window     The shop may set how many days after a sale a return is taken without a manager.
 *   Limit      The shop may set the most a salesperson pays back on one return without a manager.
 *              A manager (return:complete) is never stopped by either; the screen still says so.
 *   Money      What the customer paid for those pieces, net of every discount, never the tag. The
 *              share they paid with loyalty points goes back as points, not money.
 *   Exchange   The money becomes store credit, spent straight away on the new pieces at New sale.
 *   Twice      The screen makes one key per return; a retried Complete is the same return.
 */
import { Prisma, ReturnReason } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { runTransaction } from '../../lib/txRetry';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { grants, holdsEverything } from '../../config/permissions';
import { portionOf, toMinor, fromMinor } from '../pricing';
import { returnService } from '../return.service';
import { shareOfBill } from '../loyalty';
import { post as postCredit, rupees } from '../store-credit';
import { normalisePhone } from '../../lib/phone';

export type Actor = { id: string; clientId: string; name?: string | null; permissions?: string[]; roles?: string[] };
const may = (a: Actor, key: string) => holdsEverything(a.permissions, a.roles) || grants(a.permissions ?? [], key);
const isManager = (a: Actor) => may(a, 'return:complete');
function requireCounter(a: Actor) {
  if (!(may(a, 'return:counter') || (may(a, 'return:create') && may(a, 'return:complete')))) {
    throw forbidden('Taking returns at the counter is not part of your role. Ask the owner.');
  }
}

export type RefundMethod = 'CASH' | 'UPI' | 'CARD' | 'CREDIT';
const METHODS: RefundMethod[] = ['CASH', 'UPI', 'CARD', 'CREDIT'];
const METHOD_WORD: Record<RefundMethod, string> = { CASH: 'cash', UPI: 'UPI', CARD: 'card', CREDIT: 'store credit' };
const DAY = 86_400_000;

// ── The shop's rules ───────────────────────────────────────────────────────────────────────

export async function getRules(clientId: string) {
  const s = await prisma.clientSettings.findUnique({ where: { clientId }, select: { returnWindowDays: true, counterReturnMax: true } });
  return { returnWindowDays: s?.returnWindowDays ?? null, counterReturnMax: s?.counterReturnMax === null || s?.counterReturnMax === undefined ? null : Number(s.counterReturnMax) };
}

export async function saveRules(actor: Actor, input: { returnWindowDays?: unknown; counterReturnMax?: unknown }) {
  if (!isManager(actor)) throw forbidden('Setting the return rules needs someone who can finish returns. Ask the owner.');
  const data: { returnWindowDays?: number | null; counterReturnMax?: Prisma.Decimal | null } = {};
  if (input.returnWindowDays !== undefined) {
    const v = input.returnWindowDays;
    if (v === null || v === '') data.returnWindowDays = null;
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3650) data.returnWindowDays = v;
    else throw badRequest('Days for returns must be a whole number from 0 to 3650, or empty for no limit.');
  }
  if (input.counterReturnMax !== undefined) {
    const v = input.counterReturnMax;
    if (v === null || v === '') data.counterReturnMax = null;
    else if (typeof v === 'number' && v >= 0 && v <= 10_000_000 && Math.round(v * 100) === v * 100) data.counterReturnMax = new Prisma.Decimal(v);
    else throw badRequest('The most a salesperson may pay back must be an amount in rupees, or empty for no limit.');
  }
  await prisma.clientSettings.upsert({ where: { clientId: actor.clientId }, create: { clientId: actor.clientId, ...data }, update: data });
  return getRules(actor.clientId);
}

// ── Finding the bill ───────────────────────────────────────────────────────────────────────

/**
 * The bills a customer might be bringing back from: by bill number ("SO-000123", or just "123"),
 * or by the customer's phone number or name. Every line with what can still come back.
 */
export async function findSales(actor: Actor, rawQ: unknown) {
  requireCounter(actor);
  const q = typeof rawQ === 'string' ? rawQ.trim() : '';
  if (q.length < 2) throw badRequest('Type the bill number, or the customer\'s phone number or name.');
  const digits = q.replace(/\D/g, '');
  const phone = normalisePhone(q);
  const or: Prisma.SalesOrderWhereInput[] = [
    { orderNumber: { contains: q, mode: 'insensitive' } },
    { customerName: { contains: q, mode: 'insensitive' } },
    { customer: { name: { contains: q, mode: 'insensitive' } } }
  ];
  if (phone.ok) or.push({ customer: { phone: phone.value } }, { customerPhone: phone.value });
  else if (digits.length >= 4) or.push({ customer: { phone: { contains: digits } } }, { orderNumber: { endsWith: digits.padStart(6, '0') } });

  const orders = await prisma.salesOrder.findMany({
    where: { clientId: actor.clientId, deletedAt: null, status: { not: 'CANCELLED' }, dispatches: { some: {} }, OR: or },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { id: true }
  });
  return Promise.all(orders.map(o => saleForReturn(actor.clientId, o.id)));
}

/** One bill for the return screen, opened from its order or receipt. */
export async function saleForCounter(actor: Actor, orderId: string) {
  requireCounter(actor);
  return saleForReturn(actor.clientId, orderId);
}

/** One bill as the return screen needs it. */
export async function saleForReturn(clientId: string, orderId: string) {
  const [order, rules] = await Promise.all([
    prisma.salesOrder.findFirst({
      where: { id: orderId, clientId, deletedAt: null },
      select: {
        id: true, orderNumber: true, createdAt: true, total: true, status: true, locationId: true, customerName: true,
        customer: { select: { id: true, name: true, phone: true, storeCreditPaise: true, loyaltyPoints: true } },
        location: { select: { name: true } },
        payments: { select: { kind: true, method: true, amount: true } },
        dispatches: {
          select: {
            id: true, dispatchNumber: true,
            items: {
              select: {
                id: true, quantity: true, returnedQty: true,
                returnItems: { where: { salesReturn: { status: { in: ['REQUESTED', 'RECEIVED', 'INSPECTED'] } } }, select: { quantity: true } },
                salesOrderItem: {
                  select: {
                    id: true, quantity: true, totalPrice: true, unitPrice: true,
                    variant: { select: { sku: true, colorName: true, size: true, product: { select: { title: true } } } }
                  }
                }
              }
            }
          }
        }
      }
    }),
    getRules(clientId)
  ]);
  if (!order) throw notFound('That bill was not found.');
  const days = Math.floor((Date.now() - order.createdAt.getTime()) / DAY);
  const lines = order.dispatches.flatMap(d => d.items.map(i => {
    const open = i.returnItems.reduce((s, r) => s + r.quantity, 0);
    const v = i.salesOrderItem.variant;
    return {
      dispatchItemId: i.id,
      salesOrderItemId: i.salesOrderItem.id,
      title: v.product.title, colorName: v.colorName, size: v.size, sku: v.sku,
      sold: i.quantity, returned: i.returnedQty, onOpenReturn: open,
      canReturn: Math.max(0, i.quantity - i.returnedQty - open),
      paidEach: Number(i.salesOrderItem.quantity ? Number(i.salesOrderItem.totalPrice) / i.salesOrderItem.quantity : 0)
    };
  }));
  const paidWith = [...new Set(order.payments.filter(p => p.kind === 'PAYMENT').map(p => p.method))];
  return {
    id: order.id, orderNumber: order.orderNumber, createdAt: order.createdAt, daysAgo: days,
    total: Number(order.total), store: order.location?.name ?? null, locationId: order.locationId,
    customer: order.customer ? {
      id: order.customer.id, name: order.customer.name,
      phone: order.customer.phone ? `••••${order.customer.phone.slice(-4)}` : null,
      storeCredit: order.customer.storeCreditPaise / 100, points: order.customer.loyaltyPoints
    } : (order.customerName ? { id: null, name: order.customerName, phone: null, storeCredit: 0, points: 0 } : null),
    paidWith,
    lines,
    window: rules.returnWindowDays === null ? null : { days: rules.returnWindowDays, over: days > rules.returnWindowDays }
  };
}

// ── What it comes to ───────────────────────────────────────────────────────────────────────

type LineIn = { dispatchItemId: string; quantity: number; condition?: 'RESTOCK' | 'DAMAGED' };

function checkLines(raw: unknown): LineIn[] {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('Choose what is coming back.');
  if (raw.length > 100) throw badRequest('A return can have 100 lines at most.');
  const seen = new Set<string>();
  return raw.map((l: any) => {
    if (!l || typeof l.dispatchItemId !== 'string') throw badRequest('Choose what is coming back.');
    if (seen.has(l.dispatchItemId)) throw badRequest('The same item is on the return twice. Change its number instead.');
    seen.add(l.dispatchItemId);
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw badRequest('Return whole pieces, at least one.');
    const condition = l.condition ?? 'RESTOCK';
    if (condition !== 'RESTOCK' && condition !== 'DAMAGED') throw badRequest('Say whether each piece goes back on sale or is damaged.');
    return { dispatchItemId: l.dispatchItemId, quantity: l.quantity, condition };
  }).filter(l => l.quantity > 0);
}

/**
 * The money for these pieces, worked out the way the return itself will: each line's share of what
 * was paid for it, after earlier returns of the same line; then the share paid with points.
 */
async function worth(db: Prisma.TransactionClient | typeof prisma, clientId: string, orderId: string, lines: LineIn[]) {
  const items = await db.dispatchItem.findMany({
    where: { id: { in: lines.map(l => l.dispatchItemId) }, dispatch: { clientId, salesOrderId: orderId } },
    select: {
      id: true, quantity: true, returnedQty: true,
      returnItems: { where: { salesReturn: { status: { in: ['REQUESTED', 'RECEIVED', 'INSPECTED'] } } }, select: { quantity: true } },
      salesOrderItem: { select: { id: true, quantity: true, totalPrice: true } }
    }
  });
  if (items.length !== lines.length) throw badRequest('An item on this return is not on that bill. Search for the bill again.');
  let totalMinor = 0;
  for (const l of lines) {
    const it = items.find(i => i.id === l.dispatchItemId)!;
    const open = it.returnItems.reduce((s, r) => s + r.quantity, 0);
    const can = it.quantity - it.returnedQty - open;
    if (l.quantity > can) {
      throw Object.assign(conflict(can <= 0 ? 'Those pieces have already come back.' : `Only ${can} of that item can still come back.`), { details: { code: 'TOO_MANY', dispatchItemId: l.dispatchItemId, canReturn: Math.max(0, can) } });
    }
    const earlier = await db.salesReturnItem.aggregate({
      where: { salesOrderItemId: it.salesOrderItem.id, salesReturn: { status: { not: 'REJECTED' } } },
      _sum: { quantity: true }
    });
    const before = earlier._sum.quantity ?? 0;
    totalMinor += portionOf(toMinor(it.salesOrderItem.totalPrice as any), it.salesOrderItem.quantity, before, Math.min(before + l.quantity, it.salesOrderItem.quantity));
  }
  const share = await shareOfBill(db, clientId, orderId, totalMinor);
  const pointsBackMinor = share?.backMinor ?? 0;
  return {
    valueMinor: totalMinor,
    moneyMinor: totalMinor - pointsBackMinor,
    pointsBack: share?.back ?? 0,
    pointsBackMinor,
    pointsTakenBack: share?.takeBack ?? 0
  };
}

/** What the screen shows before Complete: the money, the points, and anything needing a manager. */
export async function preview(actor: Actor, input: { orderId?: unknown; lines?: unknown }) {
  requireCounter(actor);
  if (typeof input.orderId !== 'string') throw badRequest('Choose the bill first.');
  const lines = checkLines(input.lines);
  const sale = await saleForReturn(actor.clientId, input.orderId);
  const w = await worth(prisma, actor.clientId, input.orderId, lines);
  const rules = await getRules(actor.clientId);
  return {
    money: w.moneyMinor / 100,
    value: w.valueMinor / 100,
    pointsBack: w.pointsBack,
    pointsBackValue: w.pointsBackMinor / 100,
    pointsTakenBack: w.pointsTakenBack,
    needsManager: needsManager(actor, sale.daysAgo, w.moneyMinor, rules)
  };
}

function needsManager(actor: Actor, daysAgo: number, moneyMinor: number, rules: { returnWindowDays: number | null; counterReturnMax: number | null }): string | null {
  const reasons: string[] = [];
  if (rules.returnWindowDays !== null && daysAgo > rules.returnWindowDays) {
    reasons.push(`this bill is ${daysAgo} days old and your shop takes returns within ${rules.returnWindowDays} days`);
  }
  if (rules.counterReturnMax !== null && moneyMinor > Math.round(rules.counterReturnMax * 100)) {
    reasons.push(`${rupees(moneyMinor)} is more than the ${rupees(Math.round(rules.counterReturnMax * 100))} a salesperson may pay back`);
  }
  if (!reasons.length) return null;
  const sentence = reasons.join(', and ');
  return isManager(actor)
    ? `Note: ${sentence}. You may still take it back.`
    : `A manager needs to take this return: ${sentence}.`;
}

// ── Taking it back ─────────────────────────────────────────────────────────────────────────

const REASONS: ReturnReason[] = ['DAMAGED_IN_TRANSIT', 'DEFECTIVE', 'WRONG_ITEM', 'SIZE_ISSUE', 'CUSTOMER_REJECTED', 'OTHER'];

function cleanReference(method: RefundMethod, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const t = String(raw).trim().slice(0, 40);
  if (!/^[A-Za-z0-9 ./@_-]*$/.test(t)) throw badRequest('A reference can only have letters, digits, spaces and . / @ _ -');
  if (method === 'CARD' && /\d{12,}/.test(t.replace(/[\s-]/g, ''))) throw badRequest('Never type the card number. Use the last 4 digits or the approval code.');
  return t || null;
}

export async function complete(actor: Actor, input: {
  key?: unknown; orderId?: unknown; locationId?: unknown; lines?: unknown; reason?: unknown; note?: unknown;
  refund?: { method?: unknown; reference?: unknown } | null; exchange?: unknown;
}) {
  requireCounter(actor);
  const key = typeof input.key === 'string' && /^[0-9a-f-]{36}$/i.test(input.key) ? input.key : null;
  if (!key) throw badRequest('Reload the return screen and try again.');
  if (typeof input.orderId !== 'string') throw badRequest('Choose the bill first.');
  if (typeof input.locationId !== 'string' || !input.locationId) throw badRequest('Choose the store you are at in the top bar.');
  const orderId = input.orderId, locationId = input.locationId;
  const lines = checkLines(input.lines);
  const reason = REASONS.includes(input.reason as ReturnReason) ? (input.reason as ReturnReason) : null;
  if (!reason) throw badRequest('Say why it is coming back.');
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : undefined;
  const exchange = input.exchange === true;
  const method: RefundMethod | null = exchange ? 'CREDIT' : (METHODS.includes(input.refund?.method as RefundMethod) ? input.refund!.method as RefundMethod : null);

  // The same press again: the same return, whatever happened to the first answer.
  const already = await prisma.salesReturn.findFirst({ where: { counterKey: key }, select: { id: true, clientId: true, salesOrderId: true } });
  if (already) {
    if (already.clientId !== actor.clientId || already.salesOrderId !== orderId) throw conflict('This return was already completed for another bill. Start a new return.');
    return { replayed: true, ...(await summary(actor.clientId, already.id)) };
  }

  const [sale, location, rules] = await Promise.all([
    saleForReturn(actor.clientId, orderId),
    prisma.stockLocation.findFirst({ where: { id: locationId, clientId: actor.clientId, active: true }, select: { id: true } }),
    getRules(actor.clientId)
  ]);
  if (!location) throw badRequest('That store was not found. Choose your store in the top bar.');
  const before = await worth(prisma, actor.clientId, orderId, lines);
  if (before.moneyMinor > 0 && !method) throw badRequest('Say how the money goes back: cash, UPI, card or store credit.');
  if (method === 'CREDIT' && !sale.customer?.id) throw badRequest('Store credit needs a customer on the bill. Give the money back another way.');
  const reference = method ? cleanReference(method, input.refund?.reference) : null;
  const block = needsManager(actor, sale.daysAgo, before.moneyMinor, rules);
  if (block && !isManager(actor)) throw forbidden(block);

  const returnId = await runTransaction(async tx => {
    const created = await returnService.createReturnIn(tx, actor.clientId, orderId, lines.map(l => ({ dispatchItemId: l.dispatchItemId, quantity: l.quantity })), note, reason);
    for (const item of created.items) {
      const l = lines.find(x => x.dispatchItemId === item.dispatchItemId)!;
      await tx.salesReturnItem.update({ where: { id: item.id }, data: { disposition: l.condition } });
    }
    await tx.salesReturn.update({ where: { id: created.id }, data: { status: 'INSPECTED', atCounter: true, counterKey: key, locationId } });
    await returnService.completeReturnIn(tx, actor.clientId, created.id, { restockAt: locationId });

    // What is left to pay back in money, after the points share went back as points.
    const done = await tx.salesReturn.findUniqueOrThrow({ where: { id: created.id }, select: { refundTotal: true, returnNumber: true } });
    const moneyMinor = toMinor(done.refundTotal as any);
    if (moneyMinor > 0 && method) {
      await tx.salesOrderPayment.create({
        data: {
          clientId: actor.clientId, salesOrderId: orderId, locationId, kind: 'REFUND', method,
          amount: fromMinor(moneyMinor), reference, salesReturnId: created.id, receivedById: actor.id
        }
      });
      if (method === 'CREDIT') {
        await postCredit(tx, {
          clientId: actor.clientId, customerId: sale.customer!.id!, kind: 'FROM_RETURN', amountPaise: moneyMinor,
          onceKey: `FROM_RETURN:${created.id}`, salesOrderId: orderId, salesReturnId: created.id, createdById: actor.id,
          note: exchange ? `Exchange: return ${done.returnNumber}` : `Return ${done.returnNumber}`
        });
      }
      await tx.salesReturn.update({
        where: { id: created.id },
        data: { refundStatus: 'REFUNDED', refundMethod: method, refundedAt: new Date(), refundedById: actor.id }
      });
    }
    return created.id;
  }, {
    label: 'take a return at the counter',
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    tooSlowMessage: 'Taking this return back took too long, so nothing was recorded. Try again.',
    // A retry after a lost answer finds the return the first attempt made.
    alreadyDone: async () => (await prisma.salesReturn.findFirst({ where: { counterKey: key }, select: { id: true } }))?.id ?? null
  }).catch(async (e: any) => {
    // Two presses racing: the other one made it.
    const winner = await prisma.salesReturn.findFirst({ where: { counterKey: key, clientId: actor.clientId }, select: { id: true } });
    if (winner) return winner.id;
    throw e;
  });

  return { replayed: false, exchange, ...(await summary(actor.clientId, returnId)) };
}

/** What the screen shows once done. */
async function summary(clientId: string, returnId: string) {
  const r = await prisma.salesReturn.findFirstOrThrow({
    where: { id: returnId, clientId },
    select: {
      id: true, returnNumber: true, refundTotal: true, refundMethod: true, pointsBack: true, pointsBackValue: true, pointsTakenBack: true,
      salesOrder: { select: { id: true, orderNumber: true, customer: { select: { id: true, name: true, storeCreditPaise: true } } } },
      items: { select: { quantity: true, disposition: true } }
    }
  });
  const money = Number(r.refundTotal);
  return {
    returnId: r.id, returnNumber: r.returnNumber, orderId: r.salesOrder.id, orderNumber: r.salesOrder.orderNumber,
    customer: r.salesOrder.customer ? { id: r.salesOrder.customer.id, name: r.salesOrder.customer.name, storeCredit: r.salesOrder.customer.storeCreditPaise / 100 } : null,
    pieces: r.items.reduce((s, i) => s + i.quantity, 0),
    backOnSale: r.items.filter(i => i.disposition === 'RESTOCK').reduce((s, i) => s + i.quantity, 0),
    money, refundMethod: r.refundMethod, refundWords: r.refundMethod ? `${rupees(Math.round(money * 100))} in ${METHOD_WORD[r.refundMethod as RefundMethod]}` : null,
    pointsBack: r.pointsBack, pointsBackValue: Number(r.pointsBackValue), pointsTakenBack: r.pointsTakenBack
  };
}

// ── A return finished the long way, paid back afterwards ───────────────────────────────────

/**
 * Record how the money went back on a completed return that still says "refund owed" -- the parcel
 * flow finishes a return without any money moving, and this is where the counter says it paid.
 */
export async function recordRefund(actor: Actor, returnId: string, input: { method?: unknown; reference?: unknown; locationId?: unknown }) {
  if (!isManager(actor) && !may(actor, 'return:counter')) throw forbidden('Paying back a return is not part of your role.');
  const method = METHODS.includes(input.method as RefundMethod) ? input.method as RefundMethod : null;
  if (!method) throw badRequest('Say how the money went back: cash, UPI, card or store credit.');
  const reference = cleanReference(method, input.reference);
  const ret = await prisma.salesReturn.findFirst({
    where: { id: returnId, clientId: actor.clientId },
    select: { id: true, status: true, refundStatus: true, refundTotal: true, returnNumber: true, locationId: true, salesOrderId: true, salesOrder: { select: { locationId: true, customerId: true } } }
  });
  if (!ret) throw notFound('Return not found');
  if (ret.status !== 'COMPLETED') throw conflict('Finish the return first; then record how the money went back.');
  if (ret.refundStatus !== 'PENDING') throw conflict(ret.refundStatus === 'REFUNDED' ? 'The money for this return has already been recorded.' : 'Nothing is owed on this return.');
  if (method === 'CREDIT' && !ret.salesOrder.customerId) throw badRequest('Store credit needs a customer on the bill.');
  const locationId = (typeof input.locationId === 'string' && input.locationId) || ret.locationId || ret.salesOrder.locationId;
  if (!locationId) throw badRequest('Choose the store you are at in the top bar.');
  const moneyMinor = toMinor(ret.refundTotal as any);

  await prisma.$transaction(async tx => {
    const claimed = await tx.salesReturn.updateMany({
      where: { id: ret.id, refundStatus: 'PENDING' },
      data: { refundStatus: 'REFUNDED', refundMethod: method, refundedAt: new Date(), refundedById: actor.id }
    });
    if (claimed.count === 0) throw conflict('The money for this return has just been recorded by somebody else.');
    await tx.salesOrderPayment.create({
      data: { clientId: actor.clientId, salesOrderId: ret.salesOrderId, locationId, kind: 'REFUND', method, amount: fromMinor(moneyMinor), reference, salesReturnId: ret.id, receivedById: actor.id }
    });
    if (method === 'CREDIT') {
      await postCredit(tx, {
        clientId: actor.clientId, customerId: ret.salesOrder.customerId!, kind: 'FROM_RETURN', amountPaise: moneyMinor,
        onceKey: `FROM_RETURN:${ret.id}`, salesOrderId: ret.salesOrderId, salesReturnId: ret.id, createdById: actor.id, note: `Return ${ret.returnNumber}`
      });
    }
  }, { timeout: 20000, maxWait: 15000 });
  return summary(actor.clientId, ret.id);
}
