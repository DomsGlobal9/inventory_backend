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
 * A bill counts only if money stayed (sold and taken back on one bill does not). Prices come from what
 * stayed on each bill; spend and item counts are net of returns, so an item taken back is not "bought".
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

  let silkKept = 0, fancyKept = 0, silkMoney = 0, fancyMoney = 0, returnLines = 0;
  const silkPrices: number[] = [], fancyPrices: number[] = [];
  for (const b of bills) {
    const onBill = new Map<string, { silk: boolean; price: number; qty: number }>();
    for (const l of b.lines) {
      if (l.amount < 0) returnLines++;
      if (isSilk(l)) { silkKept += l.quantity; silkMoney += l.amount; } else { fancyKept += l.quantity; fancyMoney += l.amount; }
      if (!l.quantity) continue;
      const price = Math.abs(money2(l.amount / l.quantity));
      const key = `${isSilk(l)}|${price}`;
      const was = onBill.get(key);
      if (was) was.qty += l.quantity; else onBill.set(key, { silk: isSilk(l), price, qty: l.quantity });
    }
    for (const { silk, price, qty } of onBill.values()) {
      for (let i = 0; i < qty; i++) (silk ? silkPrices : fancyPrices).push(price);
    }
  }
  const prices = [...silkPrices, ...fancyPrices];
  const typical = prices.length ? Math.round(median(prices)) : null;
  const silkSpend = Math.max(0, silkMoney), fancySpend = Math.max(0, fancyMoney);
  const buys = silkKept <= 0 && fancyKept <= 0 ? 'NONE' : silkKept > 0 && silkSpend >= fancySpend ? 'SILK' : silkKept > 0 ? 'MIXED' : 'FANCY';

  const pays = new Map<string, number>();
  for (const b of counted) if (b.paidBy) pays.set(b.paidBy, (pays.get(b.paidBy) ?? 0) + 1);
  const usuallyPaysBy = [...pays].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    billCount: counted.length,
    visitsEstimated: visits,
    netSpend: Math.round(bills.reduce((t, b) => t + b.net, 0)),
    items: Math.max(0, silkKept) + Math.max(0, fancyKept),
    silkItems: Math.max(0, silkKept),
    fancyItems: Math.max(0, fancyKept),
    silkSpend: Math.round(silkSpend),
    fancySpend: Math.round(fancySpend),
    buys,
    budgetTier: typical === null ? null : tierOf(typical),
    typicalItem: typical,
    silkBand: spendBand(silkPrices),
    fancyBand: spendBand(fancyPrices),
    dearestItem: prices.length ? Math.round(Math.max(...prices)) : null,
    returnLines,
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
