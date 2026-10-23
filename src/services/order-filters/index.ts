import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { literal } from '../../utils/likeText';
import { phoneSearchDigits } from '../../lib/phone';
import { paymentSummary } from '../payments/payment-rules';
import { toMinor } from '../pricing/money';

/**
 * THE ORDERS PAGE'S SEARCH, FILTERS, SORT AND EXPORT.
 *
 * Asked for only by the Orders page (`facets=1`); every other caller of GET /sales-orders gets the
 * plain list exactly as before.
 *
 * Before this the page showed the newest 500 orders and nothing said so. Now every order is
 * reachable: the page is counted, filtered and paged here, 50 at a time.
 *
 * Beside every choice is how many orders it would leave with all the OTHER filters on, as on the
 * Products page. Done in code over the shop's orders rather than in SQL, because two of the filters
 * are worked out, not stored: what is still owed (paymentSummary, the same rule the order page uses)
 * and whether a kept order is overdue. A shop's orders are hundreds to a few thousand rows; the date
 * and the search are still narrowed in SQL first.
 */

const list = z.preprocess(
  (v) => (typeof v === 'string' ? v.split('|').map(s => s.trim()).filter(Boolean) : Array.isArray(v) ? v : []),
  z.array(z.string().max(80)).max(60)
);
const rupees = z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().min(0).max(1e9).optional());
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

export const orderFilterQuery = z.object({
  page: z.preprocess((v) => (v === undefined ? 1 : parseInt(String(v), 10)), z.number().int().min(1).default(1)),
  limit: z.preprocess((v) => (v === undefined ? 50 : parseInt(String(v), 10)), z.number().int().min(1).max(100).default(50)),
  q: z.string().max(100).optional(),
  from: day, to: day,
  status: list, payment: list, source: list, kept: list, store: list,
  min: rupees, max: rupees,
  sort: z.enum(['new', 'old', 'thi', 'tlo', 'due']).default('new'),
  export: z.literal('1').optional()
});
export type OrderFilterQuery = z.infer<typeof orderFilterQuery>;

/** Where an order came from, as a shop says it. The stored values are the senders' own. */
const SOURCE_OF: Record<string, string> = { SCALEEZY_POS: 'TILL', SCALEEZY_SHOP: 'ONLINE_SHOP', SHOPIFY: 'SHOPIFY', SCALEEZY_COUNTER: 'COUNTER' };
const sourceOf = (s: string | null) => (s && SOURCE_OF[s]) || 'MANUAL';

const FACETS = ['status', 'payment', 'source', 'kept', 'store'] as const;
type Facet = typeof FACETS[number];

/** Amount bands, by what the customer pays (the bill plus its round-off). */
const BANDS: { min: number | null; max: number | null }[] = [
  { min: null, max: 1000 }, { min: 1000, max: 5000 }, { min: 5000, max: 20000 }, { min: 20000, max: null }
];

/** India's day: a date the owner picks runs midnight to midnight IST. */
const IST_MS = 330 * 60_000;
const startOfDay = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - IST_MS);
const todayInIndia = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);

/** The most a page (or an export) will consider: well past any shop today, and a ceiling if one grows. */
const MAX_ROWS = 20_000;

export async function filterOrders(clientId: string, query: OrderFilterQuery) {
  const where: any = { clientId, deletedAt: null };
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = startOfDay(query.from);
    if (query.to) where.createdAt.lt = new Date(startOfDay(query.to).getTime() + 86_400_000);
  }
  /*
   * What a person at the counter has in hand: an order number, the till's bill number, a phone, a
   * name, or the code on a tag (any item in the order).
   */
  const q = query.q?.trim();
  if (q) {
    const text = literal(q.slice(0, 80));
    const digits = phoneSearchDigits(q);
    where.OR = [
      { orderNumber: { contains: text, mode: 'insensitive' } },
      { externalOrderId: { contains: text, mode: 'insensitive' } },
      { customerName: { contains: text, mode: 'insensitive' } },
      { customer: { name: { contains: text, mode: 'insensitive' } } },
      { items: { some: { variant: { OR: [{ variantCode: { contains: text, mode: 'insensitive' } }, { sku: { contains: text, mode: 'insensitive' } }] } } } },
      ...(digits ? [{ customerPhone: { contains: digits } }, { customer: { phone: { contains: digits } } }] : [])
    ];
  }

  const rows = await prisma.salesOrder.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
    select: {
      id: true, orderNumber: true, externalOrderId: true, createdAt: true, status: true, sourceSystem: true,
      handover: true, promisedAt: true, handedOverAt: true, locationId: true, location: { select: { name: true } },
      total: true, roundOff: true, writtenOff: true, customerName: true, customerPhone: true,
      customer: { select: { name: true, phone: true } },
      payments: { select: { kind: true, amount: true } },
      items: { select: { quantity: true } }
    }
  });

  const today = todayInIndia();
  /*
   * What is really owed. paymentSummary looks only at money against the bill, so on its own it calls
   * a cancelled online order "₹29,500 not paid" and a Shopify order (paid on Shopify, nothing recorded
   * here) "not paid" too -- the first sphl run summed both into the money due (23 Oct). Neither is
   * owed: a cancelled or draft order with money still open, and a Shopify order, have no payment
   * state here and nothing due. A cancelled order that was paid and refunded still says Refunded.
   */
  const notOwed = (o: typeof rows[number], status: string) =>
    o.sourceSystem === 'SHOPIFY' || ((o.status === 'CANCELLED' || o.status === 'DRAFT') && (status === 'UNPAID' || status === 'PART_PAID'));
  const orders = rows.map(o => {
    const payableMinor = toMinor(o.total) + toMinor(o.roundOff ?? 0);
    const summed = paymentSummary(payableMinor, o.payments, toMinor(o.writtenOff ?? 0));
    const pay = notOwed(o, summed.status) ? { ...summed, due: 0, status: null as string | null } : { ...summed, status: summed.status as string | null };
    const kept = o.handover !== 'KEEP_FOR_CUSTOMER' ? null
      : o.handedOverAt ? 'HANDED_OVER'
      : o.promisedAt && o.promisedAt.toISOString().slice(0, 10) < today ? 'OVERDUE'
      : 'WAITING';
    return { o, payable: payableMinor / 100, pay, kept, source: sourceOf(o.sourceSystem) };
  });
  type O = typeof orders[number];

  const valueOf = (x: O, f: Facet): string | null => {
    switch (f) {
      case 'status': return x.o.status;
      case 'payment': return x.pay.status;
      case 'source': return x.source;
      // Only kept orders have a kept state; the rest are simply not in this filter's list.
      case 'kept': return x.kept;
      case 'store': return x.o.locationId;
    }
  };
  const inBand = (x: O) =>
    (query.min === undefined || x.payable >= query.min) && (query.max === undefined || x.payable <= query.max);
  const passes = (x: O, skip?: Facet | 'amount') => {
    for (const f of FACETS) {
      if (f === skip || !query[f].length) continue;
      const v = valueOf(x, f);
      if (v === null || !query[f].includes(v)) return false;
    }
    return skip === 'amount' || inBand(x);
  };

  // How many each choice would leave, with every other filter on.
  const facets: Record<string, { value: string; count: number; label?: string }[]> = {};
  const storeNames = new Map(orders.map(x => [x.o.locationId, x.o.location?.name ?? 'Store']));
  for (const f of FACETS) {
    const counts = new Map<string, number>();
    for (const x of orders) {
      const v = valueOf(x, f);
      if (v !== null && !counts.has(v)) counts.set(v, 0);
    }
    for (const x of orders) {
      if (!passes(x, f)) continue;
      const v = valueOf(x, f);
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    // A choice already picked stays in the list even when nothing has it any more, so it can be undone.
    for (const v of query[f]) if (!counts.has(v)) counts.set(v, 0);
    facets[f] = [...counts].map(([value, count]) => ({ value, count, ...(f === 'store' ? { label: storeNames.get(value) ?? 'Store' } : {}) }));
  }
  const banded = orders.filter(x => passes(x, 'amount'));
  facets.amount = BANDS.map(b => ({
    value: `${b.min ?? ''}-${b.max ?? ''}`,
    count: banded.filter(x => (b.min === null || x.payable >= b.min) && (b.max === null || x.payable <= b.max)).length
  }));

  const matched = orders.filter(x => passes(x));
  const by: Record<OrderFilterQuery['sort'], (a: O, b: O) => number> = {
    new: (a, b) => b.o.createdAt.getTime() - a.o.createdAt.getTime(),
    old: (a, b) => a.o.createdAt.getTime() - b.o.createdAt.getTime(),
    thi: (a, b) => b.payable - a.payable,
    tlo: (a, b) => a.payable - b.payable,
    due: (a, b) => b.pay.due - a.pay.due || b.o.createdAt.getTime() - a.o.createdAt.getTime()
  };
  matched.sort(by[query.sort]);

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const summary = {
    count: matched.length,
    // In sales: cancelled orders and drafts are never sales (the dashboard's rule too), though they are counted and listed.
    total: round2(matched.filter(x => x.o.status !== 'CANCELLED' && x.o.status !== 'DRAFT').reduce((t, x) => t + x.payable, 0)),
    due: round2(matched.reduce((t, x) => t + x.pay.due, 0)),
    // True only for a shop past MAX_ROWS in the chosen dates: the page then says so.
    capped: rows.length === MAX_ROWS
  };

  // The whole match as rows for a spreadsheet: what the owner or the accountant reads, nothing more.
  if (query.export) {
    return {
      summary,
      rows: matched.map(x => ({
        orderNumber: x.o.orderNumber,
        billNumber: x.o.externalOrderId,
        date: x.o.createdAt.toISOString(),
        store: x.o.location?.name ?? null,
        source: x.source,
        customer: x.o.customerName || x.o.customer?.name || null,
        phone: x.o.customerPhone || x.o.customer?.phone || null,
        status: x.o.status,
        pieces: x.o.items.reduce((t, i) => t + i.quantity, 0),
        total: x.payable,
        paid: x.pay.paid,
        refunded: x.pay.refunded,
        writtenOff: x.pay.writtenOff,
        due: x.pay.due,
        payment: x.pay.status,
        kept: x.kept,
        promisedAt: x.o.promisedAt?.toISOString().slice(0, 10) ?? null,
        handedOverAt: x.o.handedOverAt?.toISOString() ?? null
      }))
    };
  }

  const start = (query.page - 1) * query.limit;
  const pageRows = matched.slice(start, start + query.limit);
  return {
    summary,
    facets,
    // Just the ids of this page, in order; the caller reads the full orders for them.
    ids: pageRows.map(x => x.o.id),
    kept: Object.fromEntries(pageRows.filter(x => x.kept).map(x => [x.o.id, { state: x.kept, promisedAt: x.o.promisedAt, handedOverAt: x.o.handedOverAt }])),
    meta: { page: query.page, limit: query.limit, total: matched.length, totalPages: Math.max(1, Math.ceil(matched.length / query.limit)) }
  };
}
