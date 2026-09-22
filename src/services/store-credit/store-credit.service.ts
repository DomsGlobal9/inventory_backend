/**
 * Store credit: money the shop owes a customer, kept to be spent in the shop.
 *
 * It comes from a return the customer took as credit instead of money, or from an exchange (the
 * returned goods' value, spent at once on the new ones). It is spent at the counter as a payment
 * (method CREDIT), and can still be paid out in money if the shop agrees.
 *
 * The same shape as loyalty points, for the same reasons: every change is an entry with a once-key,
 * customers.store_credit_paise is their sum, and each change is one statement that locks the
 * customer, writes the entry and moves the balance -- so two counters spending the same credit at
 * once cannot both succeed, and a retried press changes nothing.
 */
import { Prisma, StoreCreditKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, forbidden, notFound } from '../../utils/httpError';
import { grants, holdsEverything } from '../../config/permissions';
import { fromMinor } from '../pricing';

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; clientId: string; name?: string | null; permissions?: string[]; roles?: string[] };
const may = (a: Actor, key: string) => holdsEverything(a.permissions, a.roles) || grants(a.permissions ?? [], key);

export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

type Entry = {
  clientId: string; customerId: string; kind: StoreCreditKind; amountPaise: number; onceKey: string;
  salesOrderId?: string | null; salesReturnId?: string | null; note?: string | null; createdById?: string | null;
};

/** One change, inside the caller's transaction. The new balance, or null if this once-key was done. */
export async function post(tx: Tx, e: Entry): Promise<number | null> {
  if (!Number.isInteger(e.amountPaise) || e.amountPaise === 0) return null;
  const rows = await tx.$queryRaw<{ balance: number | null; held: number | null }[]>`
    WITH cur AS (
      SELECT id, store_credit_paise FROM customers WHERE id = ${e.customerId} AND client_id = ${e.clientId} FOR UPDATE
    ), ins AS (
      INSERT INTO store_credit_entries (id, client_id, customer_id, kind, amount_paise, balance_paise, sales_order_id, sales_return_id, note, created_by_id, once_key, created_at)
      SELECT gen_random_uuid()::text, ${e.clientId}, cur.id, ${e.kind}::"StoreCreditKind", ${e.amountPaise}, cur.store_credit_paise + ${e.amountPaise},
             ${e.salesOrderId ?? null}, ${e.salesReturnId ?? null}, ${e.note ?? null}, ${e.createdById ?? null}, ${e.onceKey}, clock_timestamp()
        FROM cur
       WHERE cur.store_credit_paise + ${e.amountPaise} >= 0
      ON CONFLICT (once_key) DO NOTHING
      RETURNING balance_paise AS balance
    ), moved AS (
      UPDATE customers SET store_credit_paise = store_credit_paise + ${e.amountPaise}, updated_at = NOW()
       WHERE id = ${e.customerId} AND EXISTS (SELECT 1 FROM ins)
      RETURNING store_credit_paise
    )
    SELECT (SELECT balance FROM ins) AS balance, (SELECT store_credit_paise FROM cur) AS held`;
  const r = rows[0];
  if (r?.balance !== null && r?.balance !== undefined) return Number(r.balance);
  if (r?.held === null || r?.held === undefined) throw notFound('Customer not found');
  const already = await tx.storeCreditEntry.findUnique({ where: { onceKey: e.onceKey }, select: { id: true } });
  if (already) return null;
  throw badRequest(`The customer has only ${rupees(Number(r.held))} of store credit. Take the rest another way.`);
}

/** Inside the counter sale: take the credit spent on this bill. */
export async function spendOnSale(tx: Tx, input: { clientId: string; customerId: string; orderId: string; paise: number; userId: string | null }) {
  if (input.paise <= 0) return null;
  return post(tx, {
    clientId: input.clientId, customerId: input.customerId, kind: 'USED', amountPaise: -input.paise,
    onceKey: `USED:${input.orderId}`, salesOrderId: input.orderId, createdById: input.userId, note: `${rupees(input.paise)} off the bill`
  });
}

/** What the New sale screen shows: the credit this customer holds. */
export async function forCounter(clientId: string, customerId: string) {
  const c = await prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { storeCreditPaise: true } });
  return { credit: (c?.storeCreditPaise ?? 0) / 100 };
}

const KIND_LABEL: Record<StoreCreditKind, string> = {
  FROM_RETURN: 'From a return',
  USED: 'Used on a bill',
  PAID_OUT: 'Paid out in money',
  ADJUSTED: 'Changed by hand'
};

export async function customerCredit(clientId: string, customerId: string) {
  const c = await prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { storeCreditPaise: true } });
  if (!c) throw notFound('Customer not found');
  const entries = await prisma.storeCreditEntry.findMany({
    where: { clientId, customerId }, orderBy: { createdAt: 'desc' }, take: 100,
    select: { id: true, kind: true, amountPaise: true, balancePaise: true, note: true, salesOrderId: true, salesReturnId: true, createdAt: true }
  });
  const orderIds = [...new Set(entries.map(e => e.salesOrderId).filter(Boolean) as string[])];
  const returnIds = [...new Set(entries.map(e => e.salesReturnId).filter(Boolean) as string[])];
  const [orders, returns] = await Promise.all([
    orderIds.length ? prisma.salesOrder.findMany({ where: { id: { in: orderIds }, clientId }, select: { id: true, orderNumber: true } }) : [],
    returnIds.length ? prisma.salesReturn.findMany({ where: { id: { in: returnIds }, clientId }, select: { id: true, returnNumber: true } }) : []
  ]);
  const orderNo = new Map(orders.map(o => [o.id, o.orderNumber]));
  const returnNo = new Map(returns.map(r => [r.id, r.returnNumber]));
  return {
    credit: c.storeCreditPaise / 100,
    entries: entries.map(e => ({
      id: e.id, kind: e.kind, label: KIND_LABEL[e.kind], amount: e.amountPaise / 100, balance: e.balancePaise / 100, note: e.note,
      orderId: e.salesOrderId, orderNumber: e.salesOrderId ? orderNo.get(e.salesOrderId) ?? null : null,
      returnId: e.salesReturnId, returnNumber: e.salesReturnId ? returnNo.get(e.salesReturnId) ?? null : null,
      at: e.createdAt
    }))
  };
}

/**
 * Pay store credit out in money after all -- a customer who was given credit and then asks for the
 * cash. Written as a refund on the bill the credit came from, so the drawer and the order agree.
 */
export async function payOut(actor: Actor, customerId: string, input: { amount: unknown; method: unknown; reference?: unknown; locationId?: unknown; nonce: unknown }) {
  if (!may(actor, 'return:complete')) throw forbidden('Paying out store credit needs someone who can finish returns. Ask a manager.');
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) throw badRequest('Enter the amount to pay out, in rupees.');
  const paise = Math.round(amount * 100);
  if (input.method !== 'CASH' && input.method !== 'UPI') throw badRequest('Pay out in cash or UPI.');
  const nonce = typeof input.nonce === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input.nonce) ? input.nonce : null;
  if (!nonce) throw badRequest('Reload the page and try again.');
  const reference = typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim().slice(0, 40) : null;

  const source = await prisma.storeCreditEntry.findFirst({
    where: { clientId: actor.clientId, customerId, kind: 'FROM_RETURN' }, orderBy: { createdAt: 'desc' },
    select: { salesOrderId: true, salesReturnId: true }
  });
  if (!source?.salesOrderId) throw badRequest('This customer has no store credit from a return to pay out.');
  const order = await prisma.salesOrder.findFirst({ where: { id: source.salesOrderId, clientId: actor.clientId }, select: { id: true, locationId: true } });
  if (!order) throw notFound('The bill this credit came from was not found.');
  const locationId = typeof input.locationId === 'string' && input.locationId ? input.locationId : order.locationId;
  if (!locationId) throw badRequest('Choose the store you are paying out from.');

  await prisma.$transaction(async tx => {
    const done = await post(tx, {
      clientId: actor.clientId, customerId, kind: 'PAID_OUT', amountPaise: -paise, onceKey: `PAID_OUT:${customerId}:${nonce}`,
      salesOrderId: order.id, salesReturnId: source.salesReturnId, createdById: actor.id, note: `Paid out in ${input.method === 'CASH' ? 'cash' : 'UPI'}`
    });
    if (done === null) return;
    await tx.salesOrderPayment.create({
      data: {
        clientId: actor.clientId, salesOrderId: order.id, locationId, kind: 'REFUND', method: input.method as any,
        amount: fromMinor(paise), reference, salesReturnId: source.salesReturnId, receivedById: actor.id
      }
    });
  }, { timeout: 20000, maxWait: 15000 });
  return customerCredit(actor.clientId, customerId);
}
