/**
 * What a customer bought before the shop came to ScaleEzy, loaded from the shop's own records
 * (./importer). Read only. Never a sales order, so stock, the Day Book, GST and reports cannot see it.
 *
 * The rows are the one source: the buying pattern is worked out from them each time, here and only here,
 * so the customer page, the Customer card and CRM can never disagree, and a deleted bill leaves no trace.
 */
import { prisma } from '../../lib/prisma';
import { spendBand } from '../customer-card/spend-band';

/**
 * One line of an old bill, for any shop. `kind` is the shop's own word for what it sold (Pattu, Kurti,
 * Lehenga...); nothing here knows any shop's words or what counts as dear. Everything but kind is optional:
 * a shop's records hold what they hold. A return is a negative line.
 */
export type PastLine = { kind: string; fabric?: string | null; craft?: string | null; colour?: string | null; size?: string | null; title?: string | null; quantity: number; amount: number };
export type PastBill = { billNo: string; billedOn: string | null; net: number; paidBy: string | null; lines: PastLine[] };

/** Bills of one customer within this many numbers are taken as one visit, when there are no dates. An estimate. */
export const VISIT_GAP = 5;
/** Rupees a returned item's price may differ from the sale it came from. */
const RETURN_MATCH = 1;

const money2 = (n: number) => Math.round(n * 100) / 100;
const numeric = (no: string) => /^\d+$/.test(no);

type Item = { line: PastLine; price: number };
/** Kept items by one thing about them, the most money first: { name, items, spend, usual price }. Blanks are left out. */
function groupBy(items: Item[], of: (l: PastLine) => string | null | undefined) {
  const groups = new Map<string, number[]>();
  for (const i of items) {
    const name = of(i.line)?.trim();
    if (name) groups.set(name, [...(groups.get(name) ?? []), i.price]);
  }
  return [...groups].map(([name, prices]) => ({ name, items: prices.length, spend: Math.round(prices.reduce((t, x) => t + x, 0)), usual: spendBand(prices) }))
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
}

function median(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** The order the bills were written in, as far as the numbers can say. */
function byNumber(bills: PastBill[]) {
  return [...bills].sort((a, b) => numeric(a.billNo) && numeric(b.billNo) ? Number(a.billNo) - Number(b.billNo) : a.billNo.localeCompare(b.billNo));
}

/**
 * The buying pattern from a customer's past bills. Null when they have none.
 *
 * A bill counts only if money stayed (sold and taken back on one bill does not). Items and prices are
 * what they kept: an item taken back, even bills later, is not "bought" and sets no budget.
 * netSpend is the plain sum of their bills, so it matches the shop's records and can go below zero when
 * they returned something bought before these records.
 *
 * It says what they bought and at what price, in the shop's own words. It never says what is dear: what
 * counts as a high budget belongs to the shop, not to this code.
 */
export function analyse(input: PastBill[]) {
  if (!input.length) return null;
  const bills = byNumber(input);
  const counted = bills.filter(b => b.net > 0);

  // Dates when every bill has one: a visit is a day. Otherwise bill numbers close together, an estimate.
  // Without bill numbers that count either, nothing says which bills sit together: each is its own visit.
  const dated = counted.length > 0 && counted.every(b => b.billedOn);
  const numbers = counted.map(b => b.billNo);
  const visits = dated ? new Set(counted.map(b => b.billedOn)).size
    : numbers.every(numeric)
      ? (numbers.length ? 1 + numbers.slice(1).filter((n, i) => Number(n) - Number(numbers[i]) > VISIT_GAP).length : 0)
      : numbers.length;

  // Every item sold, one price each; then each return takes its item back out, on whichever bill it came.
  const kept: Item[] = [], returns: Item[] = [];
  let returnLines = 0;
  for (const b of bills) {
    for (const line of b.lines) {
      if (line.amount < 0) returnLines++;
      if (!line.quantity) continue;
      const price = Math.abs(money2(line.amount / line.quantity));
      for (let i = 0; i < Math.abs(line.quantity); i++) (line.quantity > 0 ? kept : returns).push({ line, price });
    }
  }
  // A return of something not among these bills was bought before the records begin, or under another
  // number. The money still comes off their spend, but it takes no item of theirs away.
  let returnsNotInRecords = 0;
  for (const r of returns) {
    // Within a rupee: a bill's discount spread over its lines can sell at 5,434.78 and take back at 5,435.
    const at = kept.findIndex(i => i.line.kind === r.line.kind && Math.abs(i.price - r.price) <= RETURN_MATCH);
    if (at >= 0) kept.splice(at, 1); else returnsNotInRecords++;
  }
  const prices = kept.map(i => i.price);
  const byKind = groupBy(kept, l => l.kind);

  const pays = new Map<string, number>();
  for (const b of counted) if (b.paidBy) pays.set(b.paidBy, (pays.get(b.paidBy) ?? 0) + 1);
  const usuallyPaysBy = [...pays].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    billCount: counted.length,
    visits,
    visitsAreAnEstimate: !dated,
    netSpend: Math.round(bills.reduce((t, b) => t + b.net, 0)),
    items: kept.length,
    topKind: byKind[0]?.name ?? null,
    byKind,
    byFabric: groupBy(kept, l => l.fabric),
    byCraft: groupBy(kept, l => l.craft),
    byColour: groupBy(kept, l => l.colour),
    bySize: groupBy(kept, l => l.size),
    typicalItem: prices.length ? Math.round(median(prices)) : null,
    dearestItem: prices.length ? Math.round(Math.max(...prices)) : null,
    returnLines,
    returnsNotInRecords,
    usuallyPaysBy,
    allBills: bills.length,
    datesKnown: bills.some(b => b.billedOn)
  };
}

export type BuyingPattern = NonNullable<ReturnType<typeof analyse>>;

type Row = { billNo: string; billedOn: Date | null; net: unknown; paidBy: string | null; lines: unknown };
const billOf = (r: Row): PastBill => ({
  billNo: r.billNo,
  billedOn: r.billedOn ? r.billedOn.toISOString().slice(0, 10) : null,
  net: Number(r.net),
  paidBy: r.paidBy,
  lines: Array.isArray(r.lines) ? r.lines as PastLine[] : []
});

export const pastPurchases = {
  /** One customer: their pattern and their bills, the last bill number first. A customer of another shop, or deleted, has none. */
  async forCustomer(clientId: string, customerId: string) {
    const rows = await prisma.pastPurchase.findMany({
      where: { clientId, customerId, customer: { clientId, deletedAt: null } },
      select: { billNo: true, billedOn: true, net: true, paidBy: true, lines: true }
    });
    const bills = rows.map(billOf);
    return { pattern: analyse(bills), bills: byNumber(bills).reverse() };
  },

  /** The pattern of every customer of a shop who has past bills, a page at a time, for CRM's filters. Pass `next` as `after`. */
  async patterns(clientId: string, query: { after?: unknown; limit?: unknown }) {
    const after = typeof query.after === 'string' && query.after ? query.after : undefined;
    const asked = Number(query.limit);
    const take = Number.isInteger(asked) && asked >= 1 && asked <= 500 ? asked : 200;
    const rows = await prisma.customer.findMany({
      where: { clientId, deletedAt: null, pastPurchases: { some: {} }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' }, take,
      select: { id: true, pastPurchases: { select: { billNo: true, billedOn: true, net: true, paidBy: true, lines: true } } }
    });
    return {
      customers: rows.map(r => ({ customerId: r.id, pattern: analyse(r.pastPurchases.map(billOf)) })),
      next: rows.length === take ? rows[rows.length - 1].id : null
    };
  },

  /** Every past bill of a shop, for CRM to catch up on: pass the last id it got as `after`. */
  async page(clientId: string, query: { after?: unknown; limit?: unknown }) {
    const after = typeof query.after === 'string' && query.after ? query.after : undefined;
    const asked = Number(query.limit);
    const take = Number.isInteger(asked) && asked >= 1 && asked <= 500 ? asked : 200;
    const rows = await prisma.pastPurchase.findMany({
      where: { clientId, customer: { deletedAt: null }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' }, take,
      select: { id: true, customerId: true, source: true, billNo: true, billedOn: true, net: true, paidBy: true, lines: true }
    });
    return {
      bills: rows.map(r => ({ id: r.id, customerId: r.customerId, source: r.source, ...billOf(r) })),
      next: rows.length === take ? rows[rows.length - 1].id : null
    };
  }
};
