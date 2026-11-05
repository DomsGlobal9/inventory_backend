/**
 * What a customer bought before the shop came to ScaleEzy, loaded from the shop's own records
 * (./importer). Read only. Never a sales order, so stock, the Day Book, GST and reports cannot see it.
 *
 * The rows are the one source: the buying pattern is worked out from them each time, here and only here,
 * so the customer page, the Customer card and CRM can never disagree, and a deleted bill leaves no trace.
 */
import { prisma } from '../../lib/prisma';
import { spendBand } from '../customer-card/spend-band';

export type PastLine = { kind: string; fabric?: string | null; quantity: number; amount: number };
export type PastBill = { billNo: string; billedOn: string | null; net: number; paidBy: string | null; lines: PastLine[] };
export type BudgetTier = 'UNDER_3K' | '3K_8K' | '8K_20K' | '20K_PLUS';

/** Bills of one customer within this many numbers are taken as one visit. With no dates it is an estimate. */
export const VISIT_GAP = 5;
/** Rupees a returned item's price may differ from the sale it came from. */
const RETURN_MATCH = 1;

const money2 = (n: number) => Math.round(n * 100) / 100;
const isSilk = (l: PastLine) => l.fabric === 'Silk';
const numeric = (no: string) => /^\d+$/.test(no);

export function tierOf(price: number): BudgetTier {
  return price < 3000 ? 'UNDER_3K' : price < 8000 ? '3K_8K' : price < 20000 ? '8K_20K' : '20K_PLUS';
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
 * A bill counts only if money stayed (sold and taken back on one bill does not). Items, prices, silk and
 * fancy are what they kept: an item taken back, even bills later, is not "bought" and sets no budget.
 * netSpend is the plain sum of their bills, so it matches the shop's sheet and can go below zero when
 * they returned something bought before these records.
 */
export function analyse(input: PastBill[]) {
  if (!input.length) return null;
  const bills = byNumber(input);
  const counted = bills.filter(b => b.net > 0);

  const numbers = counted.map(b => b.billNo);
  // Without bill numbers that count, nothing says which bills sit together: each is its own visit.
  const visits = numbers.every(numeric)
    ? (numbers.length ? 1 + numbers.slice(1).filter((n, i) => Number(n) - Number(numbers[i]) > VISIT_GAP).length : 0)
    : numbers.length;

  // Every item sold, one price each; then each return takes its item back out, on whichever bill it came.
  const silkPrices: number[] = [], fancyPrices: number[] = [];
  const returns: { silk: boolean; price: number }[] = [];
  let returnLines = 0;
  for (const b of bills) {
    for (const l of b.lines) {
      if (l.amount < 0) returnLines++;
      if (!l.quantity) continue;
      const price = Math.abs(money2(l.amount / l.quantity));
      for (let i = 0; i < Math.abs(l.quantity); i++) {
        if (l.quantity > 0) (isSilk(l) ? silkPrices : fancyPrices).push(price);
        else returns.push({ silk: isSilk(l), price });
      }
    }
  }
  // A return of something not among these bills was bought before the records begin, or under another
  // number. The money still comes off their spend, but it takes no item of theirs away.
  let returnsNotInRecords = 0;
  for (const r of returns) {
    const list = r.silk ? silkPrices : fancyPrices;
    // Within a rupee: a bill's discount spread over its lines can sell at 5,434.78 and take back at 5,435.
    const at = list.findIndex(p => Math.abs(p - r.price) <= RETURN_MATCH);
    if (at >= 0) list.splice(at, 1); else returnsNotInRecords++;
  }
  const sum = (v: number[]) => v.reduce((t, x) => t + x, 0);
  const prices = [...silkPrices, ...fancyPrices];
  const typical = prices.length ? Math.round(median(prices)) : null;
  const silkKept = silkPrices.length, fancyKept = fancyPrices.length;
  const silkSpend = sum(silkPrices), fancySpend = sum(fancyPrices);
  const buys = !silkKept && !fancyKept ? 'NONE' : silkKept && silkSpend >= fancySpend ? 'SILK' : silkKept ? 'MIXED' : 'FANCY';

  const pays = new Map<string, number>();
  for (const b of counted) if (b.paidBy) pays.set(b.paidBy, (pays.get(b.paidBy) ?? 0) + 1);
  const usuallyPaysBy = [...pays].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    billCount: counted.length,
    visitsEstimated: visits,
    netSpend: Math.round(bills.reduce((t, b) => t + b.net, 0)),
    items: silkKept + fancyKept,
    silkItems: silkKept,
    fancyItems: fancyKept,
    silkSpend: Math.round(silkSpend),
    fancySpend: Math.round(fancySpend),
    buys,
    budgetTier: typical === null ? null : tierOf(typical),
    typicalItem: typical,
    silkBand: spendBand(silkPrices),
    fancyBand: spendBand(fancyPrices),
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
