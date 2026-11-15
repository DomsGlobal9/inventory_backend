import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { lowStockSql, outOfStockSql } from '../../lib/lowStock';
import { inventoryValueFor, UNIT_COST, PRICED_NOT_COSTED } from '../../lib/inventoryValuation';
import { KINDS } from '../../lib/units';

/**
 * THE FULL PAGES BEHIND THE DASHBOARD CARDS (15 Nov 2026): Sales, Stock value, Stock on hand, Running low.
 *
 * Each card is a summary; its page is the whole picture, store by store. The figures use the dashboard's own
 * definitions, so a page never disagrees with the card it was opened from:
 *   - a sale is an order not cancelled, not a draft, not deleted (before returns), dated in India;
 *   - "at the till" is the till and the counter; "online" is the online shop and marketplaces;
 *   - stock value at cost is inventoryValueFor (the card's figure), with the same cost chain;
 *   - low is at or under the reorder level with something left; sold out is nothing left.
 * Per store, "sold out" counts only what that store carries (it has held the item): a branch is not short of
 * every item it never stocked.
 *
 * Amounts of stock are in base units (cm for fabric, g for weight, pieces otherwise) with soldBy beside them;
 * the screens show them in metres. Who may ask is decided on the route (analytics:sales, analytics:stock_value,
 * analytics:stock), and only the owner holds those until the owner gives them to a role.
 */
const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;
const IST_MS = 5.5 * 3600_000;
const ROWS_CAP = 500;
const n = (v: unknown) => Number(v ?? 0) || 0;
const problem = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const istKey = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
const istMidnight = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) - IST_MS);
const KIND_LABEL = new Map(KINDS.map(k => [k.key, k.label]));

/** What a product is called in a breakdown: its fabric kind (Lining, Lace), else its garment type (Saree), else Other. */
const groupSql = Prisma.sql`COALESCE(NULLIF(p.kind, ''), NULLIF(p.dress_type, ''), '')`;
const groupLabel = (g: string | null) => (g ? (KIND_LABEL.get(g) ?? g) : 'Other');

/** A store of this shop, or none. A store from another shop, or one that does not exist, is refused. */
async function storeOf(clientId: string, locationId: unknown) {
  if (locationId === undefined || locationId === null || locationId === '' || locationId === 'all') return null;
  if (typeof locationId !== 'string' || locationId.length > 64) throw problem('The selected store could not be found.', 404);
  const store = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true, name: true } });
  if (!store) throw problem('The selected store could not be found.', 404);
  return store;
}

async function storesOf(clientId: string) {
  return prisma.stockLocation.findMany({ where: { clientId }, select: { id: true, name: true, active: true, type: true }, orderBy: [{ createdAt: 'asc' }] });
}

// ── the period ─────────────────────────────────────────────────────────────────────────────────────

export type PeriodQuery = { period?: unknown; from?: unknown; to?: unknown };
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(Date.parse(`${s}T00:00:00Z`)).toISOString().slice(0, 10) === s;

/**
 * 7 days, 30 days (the card's window), this month, the last 12 months, or two dates (India days, both
 * included, at most a year, nothing in the future). The period before is the same length, just before.
 */
export function periodOf(q: PeriodQuery, now = new Date()) {
  const period = q.period === undefined || q.period === '' ? '30d' : String(q.period);
  let from: Date;
  let to = now;
  if (period === '7d') from = new Date(now.getTime() - 7 * DAY);
  else if (period === '30d') from = new Date(now.getTime() - 30 * DAY);
  else if (period === 'month') from = istMidnight(`${istKey(now).slice(0, 7)}-01`);
  else if (period === 'year') from = new Date(now.getTime() - 365 * DAY);
  else if (period === 'custom') {
    if (!isDay(q.from) || !isDay(q.to)) throw problem('Select a start date and an end date.');
    if (q.from > q.to) throw problem('The start date must be on or before the end date.');
    const today = istKey(now);
    if (q.from > today) throw problem('The start date cannot be in the future.');
    if (q.from < '2020-01-01') throw problem('Select a start date from 2020 onwards.');
    const last = q.to > today ? today : q.to;
    from = istMidnight(q.from);
    to = new Date(Math.min(now.getTime(), istMidnight(last).getTime() + DAY - 1));
    if (to.getTime() - from.getTime() > 366 * DAY) throw problem('Select a date range of up to one year.');
  } else throw problem('Select 7 days, 30 days, this month, a year, or a custom range.');
  const len = Math.max(1, to.getTime() - from.getTime());
  return {
    period, from, to, prevFrom: new Date(from.getTime() - len), prevTo: from,
    by: (len <= 62 * DAY ? 'day' : 'month') as 'day' | 'month',
    fromDay: istKey(from), toDay: istKey(to)
  };
}

// ── Sales ──────────────────────────────────────────────────────────────────────────────────────────

export async function salesPage(clientId: string, q: PeriodQuery & { locationId?: unknown }, now = new Date()) {
  const p = periodOf(q, now);
  const store = await storeOf(clientId, q.locationId);
  const here = store ? Prisma.sql`AND so.location_id = ${store.id}` : Prisma.empty;
  const real = Prisma.sql`so.client_id = ${clientId} AND so.deleted_at IS NULL AND so.status::text NOT IN ('CANCELLED', 'DRAFT') ${here}`;
  const within = (a: Date, b: Date) => Prisma.sql`so.created_at > ${a} AND so.created_at <= ${b}`;
  const online = Prisma.sql`so.channel::text IN ('ONLINE', 'MARKETPLACE')`;
  const istDay = Prisma.sql`((so.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::date`;
  const bucket = p.by === 'day' ? Prisma.sql`to_char(${istDay}, 'YYYY-MM-DD')` : Prisma.sql`to_char(${istDay}, 'YYYY-MM')`;

  const [[now_], [before], series, perStore, best, pays, groups, [returns], stores] = await Promise.all([
    prisma.$queryRaw<{ total: unknown; till: unknown; online: unknown; bills: bigint; till_bills: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(so.total), 0) AS total, COALESCE(SUM(so.total) FILTER (WHERE NOT ${online}), 0) AS till,
             COALESCE(SUM(so.total) FILTER (WHERE ${online}), 0) AS online, COUNT(*) AS bills, COUNT(*) FILTER (WHERE NOT ${online}) AS till_bills
      FROM sales_orders so WHERE ${real} AND ${within(p.from, p.to)}`),
    prisma.$queryRaw<{ total: unknown; bills: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(so.total), 0) AS total, COUNT(*) AS bills FROM sales_orders so WHERE ${real} AND ${within(p.prevFrom, p.prevTo)}`),
    prisma.$queryRaw<{ k: string; till: unknown; online: unknown; bills: bigint }[]>(Prisma.sql`
      SELECT ${bucket} AS k, COALESCE(SUM(so.total) FILTER (WHERE NOT ${online}), 0) AS till, COALESCE(SUM(so.total) FILTER (WHERE ${online}), 0) AS online, COUNT(*) AS bills
      FROM sales_orders so WHERE ${real} AND ${within(p.from, p.to)} GROUP BY 1`),
    prisma.$queryRaw<{ location_id: string; total: unknown; bills: bigint }[]>(Prisma.sql`
      SELECT so.location_id, COALESCE(SUM(so.total), 0) AS total, COUNT(*) AS bills FROM sales_orders so WHERE ${real} AND ${within(p.from, p.to)} GROUP BY 1`),
    prisma.$queryRaw<{ product_id: string; title: string; sold_by: string | null; qty: unknown; revenue: unknown }[]>(Prisma.sql`
      SELECT p.id AS product_id, p.title, p.sold_by, SUM(i.quantity) AS qty, SUM(i.total_price) AS revenue
      FROM sales_orders so JOIN sales_order_items i ON i.sales_order_id = so.id
      JOIN inventory_product_variants v ON v.id = i.variant_id JOIN inventory_products p ON p.id = v.product_id
      WHERE ${real} AND ${within(p.from, p.to)} GROUP BY p.id, p.title, p.sold_by ORDER BY SUM(i.total_price) DESC, p.title LIMIT 10`),
    prisma.$queryRaw<{ method: string; amount: unknown }[]>(Prisma.sql`
      SELECT pay.method::text AS method, COALESCE(SUM(pay.amount), 0) AS amount
      FROM sales_order_payments pay JOIN sales_orders so ON so.id = pay.sales_order_id
      WHERE ${real} AND ${within(p.from, p.to)} AND pay.kind::text = 'PAYMENT' GROUP BY 1`),
    prisma.$queryRaw<{ g: string | null; revenue: unknown }[]>(Prisma.sql`
      SELECT ${groupSql} AS g, COALESCE(SUM(i.total_price), 0) AS revenue
      FROM sales_orders so JOIN sales_order_items i ON i.sales_order_id = so.id
      JOIN inventory_product_variants v ON v.id = i.variant_id JOIN inventory_products p ON p.id = v.product_id
      WHERE ${real} AND ${within(p.from, p.to)} GROUP BY 1 ORDER BY 2 DESC`),
    // Returns finished in the period, for this store's orders (or the whole shop's).
    prisma.$queryRaw<{ amount: unknown; count: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(r.refund_total), 0) AS amount, COUNT(*) AS count
      FROM sales_returns r JOIN sales_orders so ON so.id = r.sales_order_id
      WHERE r.client_id = ${clientId} AND r.status::text = 'COMPLETED' ${here}
        AND COALESCE(r.completed_at, r.created_at) > ${p.from} AND COALESCE(r.completed_at, r.created_at) <= ${p.to}`),
    storesOf(clientId)
  ]);

  // Every day (or month) present, zeros included, so a gap in the chart is a real quiet day.
  const byKey = new Map(series.map(r => [r.k, r]));
  const keys: string[] = [];
  if (p.by === 'day') for (let t = istMidnight(p.fromDay).getTime(); istKey(new Date(t)) <= p.toDay; t += DAY) keys.push(istKey(new Date(t)));
  else {
    const [y0, m0] = p.fromDay.split('-').map(Number), [y1, m1] = p.toDay.split('-').map(Number);
    for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, m = 1) : m++) keys.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  const total = n(now_?.total), prev = n(before?.total), bills = Number(now_?.bills ?? 0);
  const names = new Map(stores.map(s => [s.id, s.name]));
  return {
    period: { period: p.period, from: p.fromDay, to: p.toDay, by: p.by },
    store: store ? { id: store.id, name: store.name } : null,
    totals: {
      sales: total, previous: prev, change: prev > 0 ? Math.round(((total - prev) / prev) * 1000) / 10 : null,
      bills, previousBills: Number(before?.bills ?? 0), tillBills: Number(now_?.till_bills ?? 0), onlineBills: bills - Number(now_?.till_bills ?? 0),
      average: bills ? Math.round((total / bills) * 100) / 100 : null,
      till: n(now_?.till), online: n(now_?.online),
      returns: n(returns?.amount), returnCount: Number(returns?.count ?? 0), returnShare: total > 0 ? Math.round((n(returns?.amount) / total) * 1000) / 10 : null
    },
    series: keys.map(k => { const r = byKey.get(k); return { key: k, till: n(r?.till), online: n(r?.online), bills: Number(r?.bills ?? 0) }; }),
    stores: perStore.map(r => ({ id: r.location_id, name: names.get(r.location_id) ?? 'Removed store', sales: n(r.total), bills: Number(r.bills) }))
      .sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name)),
    bestSellers: best.map(r => ({ productId: r.product_id, title: r.title, soldBy: r.sold_by ?? 'PIECE', quantity: n(r.qty), sales: n(r.revenue) })),
    payments: pays.map(r => ({ method: r.method, amount: n(r.amount) })).filter(r => r.amount !== 0).sort((a, b) => b.amount - a.amount),
    categories: groups.map(r => ({ name: groupLabel(r.g), sales: n(r.revenue) })).filter(r => r.sales !== 0)
  };
}

// ── Stock value ────────────────────────────────────────────────────────────────────────────────────

const stockBase = (clientId: string) => Prisma.sql`
  FROM inventory_stocks s
  JOIN inventory_product_variants v ON v.id = s.variant_id
  JOIN inventory_products p ON p.id = v.product_id
  WHERE s.client_id = ${clientId} AND v.client_id = ${clientId} AND p.status::text <> 'TRASHED' AND p.is_service = false`;
const amounts = Prisma.sql`
  COALESCE(SUM(s.quantity) FILTER (WHERE COALESCE(p.sold_by::text, 'PIECE') NOT IN ('METRE', 'KILOGRAM')), 0) AS pieces,
  COALESCE(SUM(s.quantity) FILTER (WHERE p.sold_by::text = 'METRE'), 0) AS cm,
  COALESCE(SUM(s.quantity) FILTER (WHERE p.sold_by::text = 'KILOGRAM'), 0) AS grams`;

export async function stockValuePage(clientId: string, now = new Date()) {
  const [rows, groups, [caveat], stores, total, nights] = await Promise.all([
    prisma.$queryRaw<{ location_id: string; pieces: unknown; cm: unknown; grams: unknown; at_price: unknown }[]>(Prisma.sql`
      SELECT s.location_id, ${amounts},
             COALESCE(SUM(s.quantity * COALESCE(NULLIF(v.selling_price, 0), NULLIF(v.compare_at_price, 0), NULLIF(p.base_price, 0), 0)), 0) AS at_price
      ${stockBase(clientId)} GROUP BY 1`),
    prisma.$queryRaw<{ g: string | null; at_cost: unknown }[]>(Prisma.sql`
      SELECT ${groupSql} AS g, COALESCE(SUM(s.quantity * ${UNIT_COST}), 0) AS at_cost ${stockBase(clientId)} GROUP BY 1 ORDER BY 2 DESC`),
    prisma.$queryRaw<{ priced: unknown }[]>(Prisma.sql`
      SELECT COALESCE(SUM(s.quantity) FILTER (WHERE s.quantity > 0 AND COALESCE(p.sold_by::text, 'PIECE') NOT IN ('METRE', 'KILOGRAM') AND ${PRICED_NOT_COSTED}), 0) AS priced ${stockBase(clientId)}`),
    storesOf(clientId),
    inventoryValueFor(clientId),
    prisma.dailyInventorySnapshot.findMany({ where: { clientId, snapshotDate: { gte: new Date(now.getTime() - 190 * DAY) } }, orderBy: { snapshotDate: 'asc' }, select: { snapshotDate: true, totalValue: true } })
  ]);
  // Each store at cost: the very figure its dashboard card shows (inventoryValueFor), one store at a time.
  const held = rows.filter(r => n(r.pieces) || n(r.cm) || n(r.grams));
  const atCost = new Map(await Promise.all(held.map(async r => [r.location_id, await inventoryValueFor(clientId, r.location_id)] as const)));
  const names = new Map(stores.map(s => [s.id, s]));
  const perStore = held.map(r => ({
    id: r.location_id, name: names.get(r.location_id)?.name ?? 'Removed store', active: names.get(r.location_id)?.active ?? false,
    pieces: n(r.pieces), fabricCm: n(r.cm), weightG: n(r.grams), atCost: atCost.get(r.location_id) ?? 0, atPrice: n(r.at_price)
  })).sort((a, b) => b.atCost - a.atCost || a.name.localeCompare(b.name));
  // The last six months: each month's last nightly figure, and today's live figure to end on.
  const months = new Map<string, number>();
  for (const s of nights) months.set(istKey(s.snapshotDate).slice(0, 7), n(s.totalValue));
  months.set(istKey(now).slice(0, 7), total);
  const trend = [...months.entries()].slice(-6).map(([month, value]) => ({ month, value }));
  return {
    totals: {
      atCost: total, atPrice: perStore.reduce((t, s) => t + s.atPrice, 0),
      pieces: perStore.reduce((t, s) => t + s.pieces, 0), fabricCm: perStore.reduce((t, s) => t + s.fabricCm, 0), weightG: perStore.reduce((t, s) => t + s.weightG, 0),
      pricedNotCosted: n(caveat?.priced)
    },
    stores: perStore,
    emptyStores: stores.filter(s => s.active && !perStore.some(p => p.id === s.id)).map(s => ({ id: s.id, name: s.name })),
    trend,
    categories: groups.map(r => ({ name: groupLabel(r.g), atCost: n(r.at_cost) })).filter(r => r.atCost !== 0)
  };
}

// ── Stock on hand ──────────────────────────────────────────────────────────────────────────────────

export async function stockOnHandPage(clientId: string, q: { group?: unknown } = {}) {
  const group = typeof q.group === 'string' && q.group.trim() ? q.group.trim().slice(0, 80) : null;
  const inGroup = group ? Prisma.sql`AND ${groupSql} = ${group === 'Other' ? '' : ([...KIND_LABEL.entries()].find(([, l]) => l === group)?.[0] ?? group)}` : Prisma.empty;
  const selling = Prisma.sql`p.status::text IN ('ACTIVE', 'DRAFT')`;
  const qty = Prisma.sql`s.quantity`;
  const [rows, matrix, [whole], stores] = await Promise.all([
    // Per store: only what that store carries (has a stock row for).
    prisma.$queryRaw<{ location_id: string; pieces: unknown; cm: unknown; grams: unknown; colours: bigint; low: bigint; out: bigint }[]>(Prisma.sql`
      SELECT s.location_id, ${amounts}, COUNT(*) AS colours,
             COUNT(*) FILTER (WHERE ${selling} AND ${lowStockSql(qty)}) AS low,
             COUNT(*) FILTER (WHERE p.status::text = 'ACTIVE' AND ${outOfStockSql(qty)}) AS out
      ${stockBase(clientId)} ${inGroup} GROUP BY 1`),
    prisma.$queryRaw<{ g: string | null; location_id: string; pieces: unknown; cm: unknown; grams: unknown }[]>(Prisma.sql`
      SELECT ${groupSql} AS g, s.location_id, ${amounts} ${stockBase(clientId)} ${inGroup} GROUP BY 1, 2`),
    // The whole shop, counted the dashboard's way (each colour once, all stores together).
    prisma.$queryRaw<{ colours: bigint; low: bigint; out: bigint }[]>(Prisma.sql`
      SELECT COUNT(*) AS colours, COUNT(*) FILTER (WHERE ${selling} AND ${lowStockSql(Prisma.sql`COALESCE(t.qty, 0)`)}) AS low,
             COUNT(*) FILTER (WHERE ${selling} AND ${outOfStockSql(Prisma.sql`COALESCE(t.qty, 0)`)}) AS out
      FROM inventory_product_variants v JOIN inventory_products p ON p.id = v.product_id
      LEFT JOIN (SELECT variant_id, SUM(quantity) AS qty FROM inventory_stocks WHERE client_id = ${clientId} GROUP BY variant_id) t ON t.variant_id = v.id
      WHERE v.client_id = ${clientId} AND p.status::text <> 'TRASHED' AND p.is_service = false ${inGroup}`),
    storesOf(clientId)
  ]);
  const names = new Map(stores.map(s => [s.id, s]));
  const perStore = rows.map(r => ({
    id: r.location_id, name: names.get(r.location_id)?.name ?? 'Removed store', active: names.get(r.location_id)?.active ?? false,
    pieces: n(r.pieces), fabricCm: n(r.cm), weightG: n(r.grams),
    colours: Number(r.colours), low: Number(r.low), out: Number(r.out), plenty: Math.max(0, Number(r.colours) - Number(r.low) - Number(r.out))
  })).filter(s => s.pieces || s.fabricCm || s.weightG || s.low || s.out)
    .sort((a, b) => (b.pieces + b.fabricCm / 100) - (a.pieces + a.fabricCm / 100) || a.name.localeCompare(b.name));
  const shown = new Set(perStore.map(s => s.id));
  const cats = new Map<string, Record<string, { pieces: number; fabricCm: number; weightG: number }>>();
  for (const r of matrix) {
    if (!shown.has(r.location_id)) continue;
    const name = groupLabel(r.g);
    if (!cats.has(name)) cats.set(name, {});
    const cell = cats.get(name)![r.location_id] ?? { pieces: 0, fabricCm: 0, weightG: 0 };
    cell.pieces += n(r.pieces); cell.fabricCm += n(r.cm); cell.weightG += n(r.grams);
    cats.get(name)![r.location_id] = cell;
  }
  return {
    group,
    totals: {
      pieces: perStore.reduce((t, s) => t + s.pieces, 0), fabricCm: perStore.reduce((t, s) => t + s.fabricCm, 0), weightG: perStore.reduce((t, s) => t + s.weightG, 0),
      colours: Number(whole?.colours ?? 0), low: Number(whole?.low ?? 0), out: Number(whole?.out ?? 0)
    },
    stores: perStore,
    emptyStores: stores.filter(s => s.active && !shown.has(s.id)).map(s => ({ id: s.id, name: s.name })),
    categories: [...cats.entries()].map(([name, byStore]) => ({ name, byStore }))
      .sort((a, b) => Object.values(b.byStore).reduce((t, c) => t + c.pieces + c.fabricCm / 100, 0) - Object.values(a.byStore).reduce((t, c) => t + c.pieces + c.fabricCm / 100, 0)),
    groups: [...new Set(matrix.map(r => groupLabel(r.g)))].sort()
  };
}

// ── Running low ────────────────────────────────────────────────────────────────────────────────────

/**
 * Every colour that is low or sold out in a store that carries it, with how fast it sells there (the last 28
 * days), how long what is left will last, and one next step:
 *   MOVE      another store holds spare (above its own reorder level) -- the cheapest fix, no new order;
 *   STOCK_IN  fabric and weight (purchase orders count pieces);
 *   SLOW      nothing sold here in 60 days -- the reorder level is probably too high;
 *   ORDER     a purchase order.
 * The screen shows a step only to somebody allowed to take it.
 */
export async function runningLowPage(clientId: string, q: { locationId?: unknown; state?: unknown; sort?: unknown } = {}, now = new Date()) {
  const store = await storeOf(clientId, q.locationId);
  const state = q.state === undefined || q.state === '' ? 'all' : String(q.state);
  if (!['all', 'low', 'out'].includes(state)) throw problem('Select low stock, out of stock, or all.');
  const sort = q.sort === undefined || q.sort === '' ? 'soonest' : String(q.sort);
  if (!['soonest', 'fewest', 'name'].includes(sort)) throw problem('Sort by earliest stock-out, lowest stock, or name.');
  const here = store ? Prisma.sql`AND s.location_id = ${store.id}` : Prisma.empty;
  // Always both, so the Low and Sold out tabs can show their counts; the state picks which rows go back.
  const which = Prisma.sql`((p.status::text IN ('ACTIVE', 'DRAFT') AND ${lowStockSql(Prisma.sql`s.quantity`)}) OR (p.status::text = 'ACTIVE' AND ${outOfStockSql(Prisma.sql`s.quantity`)}))`;
  const [rows, stores] = await Promise.all([
    prisma.$queryRaw<{ variant_id: string; location_id: string; qty: number; level: number; product_id: string; title: string; colour: string | null; size: string | null; sku: string | null; sold_by: string | null }[]>(Prisma.sql`
      SELECT s.variant_id, s.location_id, s.quantity AS qty, v.reorder_level AS level, p.id AS product_id, p.title, v.color_name AS colour, v.size, v.sku, p.sold_by
      ${stockBase(clientId)} ${here} AND ${which}
      ORDER BY s.quantity ASC, p.title LIMIT ${ROWS_CAP + 1}`),
    storesOf(clientId)
  ]);
  const capped = rows.length > ROWS_CAP;
  const list = rows.slice(0, ROWS_CAP);
  const variantIds = [...new Set(list.map(r => r.variant_id))];
  const [sold28, sold60, spare] = variantIds.length ? await Promise.all([
    prisma.$queryRaw<{ variant_id: string; location_id: string; qty: unknown }[]>(Prisma.sql`
      SELECT i.variant_id, so.location_id, SUM(i.quantity) AS qty FROM sales_orders so JOIN sales_order_items i ON i.sales_order_id = so.id
      WHERE so.client_id = ${clientId} AND so.deleted_at IS NULL AND so.status::text NOT IN ('CANCELLED', 'DRAFT')
        AND so.created_at > ${new Date(now.getTime() - 28 * DAY)} AND i.variant_id IN (${Prisma.join(variantIds)}) GROUP BY 1, 2`),
    prisma.$queryRaw<{ variant_id: string; location_id: string }[]>(Prisma.sql`
      SELECT DISTINCT i.variant_id, so.location_id FROM sales_orders so JOIN sales_order_items i ON i.sales_order_id = so.id
      WHERE so.client_id = ${clientId} AND so.deleted_at IS NULL AND so.status::text NOT IN ('CANCELLED', 'DRAFT')
        AND so.created_at > ${new Date(now.getTime() - 60 * DAY)} AND i.variant_id IN (${Prisma.join(variantIds)})`),
    // What other stores could give: held there above that store's own reorder level (minus what is held for orders).
    prisma.$queryRaw<{ variant_id: string; location_id: string; spare: number }[]>(Prisma.sql`
      SELECT s.variant_id, s.location_id, (s.quantity - COALESCE(s.reserved_qty, 0) - GREATEST(v.reorder_level, 0))::int AS spare
      FROM inventory_stocks s JOIN inventory_product_variants v ON v.id = s.variant_id JOIN inventory_locations l ON l.id = s.location_id
      WHERE s.client_id = ${clientId} AND l.active = true AND s.variant_id IN (${Prisma.join(variantIds)})
        AND s.quantity - COALESCE(s.reserved_qty, 0) - GREATEST(v.reorder_level, 0) > 0`)
  ]) : [[], [], []];
  const names = new Map(stores.map(s => [s.id, s.name]));
  const key = (v: string, l: string) => `${v}|${l}`;
  const rate = new Map(sold28.map(r => [key(r.variant_id, r.location_id), n(r.qty) / 4]));
  const recent = new Set(sold60.map(r => key(r.variant_id, r.location_id)));
  const out = list.map(r => {
    const perWeek = rate.get(key(r.variant_id, r.location_id)) ?? 0;
    const daysLeft = r.qty <= 0 ? 0 : perWeek > 0 ? Math.floor(r.qty / (perWeek / 7)) : null;
    const measured = r.sold_by === 'METRE' || r.sold_by === 'KILOGRAM';
    // Enough to bring it back to twice its reorder level (at least one), from the store with the most spare.
    const want = Math.max(1, Math.max(r.level, 1) * 2 - r.qty);
    const giver = spare.filter(s => s.variant_id === r.variant_id && s.location_id !== r.location_id).sort((a, b) => b.spare - a.spare)[0];
    const next = giver ? { kind: 'MOVE' as const, fromLocationId: giver.location_id, fromName: names.get(giver.location_id) ?? 'another store', quantity: Math.min(giver.spare, want) }
      : measured ? { kind: 'STOCK_IN' as const, quantity: want }
      : r.qty > 0 && !recent.has(key(r.variant_id, r.location_id)) ? { kind: 'SLOW' as const }
      : { kind: 'ORDER' as const, quantity: want };
    return {
      variantId: r.variant_id, productId: r.product_id, title: r.title, colour: r.colour, size: r.size, sku: r.sku, soldBy: r.sold_by ?? 'PIECE',
      locationId: r.location_id, store: names.get(r.location_id) ?? 'Removed store',
      left: r.qty, reorderLevel: r.level, soldOut: r.qty <= 0, perWeek, daysLeft, next
    };
  });
  const by = {
    soonest: (a: typeof out[0], b: typeof out[0]) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) || a.left - b.left || a.title.localeCompare(b.title),
    fewest: (a: typeof out[0], b: typeof out[0]) => a.left / Math.max(1, a.reorderLevel) - b.left / Math.max(1, b.reorderLevel) || a.title.localeCompare(b.title),
    name: (a: typeof out[0], b: typeof out[0]) => a.title.localeCompare(b.title) || (a.colour ?? '').localeCompare(b.colour ?? '') || a.store.localeCompare(b.store)
  } as const;
  out.sort(by[sort as keyof typeof by]);
  return {
    store: store ? { id: store.id, name: store.name } : null, state, sort,
    counts: { low: out.filter(r => !r.soldOut).length, out: out.filter(r => r.soldOut).length },
    capped, rows: state === 'low' ? out.filter(r => !r.soldOut) : state === 'out' ? out.filter(r => r.soldOut) : out
  };
}
