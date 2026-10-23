import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { lowStockSql, outOfStockSql } from '../../lib/lowStock';
import { inventoryValueFor, UNIT_COST } from '../../lib/inventoryValuation';
import { grants, holdsEverything } from '../../config/permissions';

/**
 * THE DASHBOARD'S TOP HALF: the welcome line, sales over the last 30 days, stock on hand, what is
 * running low, sales by month and by day, top sellers and the latest orders.
 *
 * Every part is answered only for somebody allowed to see it, here on the server: a salesperson's
 * browser is never sent the shop's takings and asked to hide them. A part they may not see comes back
 * as null and the screen leaves it out.
 *
 *   money (sales, values, revenue)   report:financial
 *   stock and what is running low    inventory:view
 *   top sellers (pieces sold)        report:view or report:financial
 *   latest orders (with their totals, as the Orders list shows them)   sales_order:view
 *
 * Sales are orders that happened: not cancelled, not drafts, not deleted, before any returns. "At the
 * till" is the till and the counter; "online" is the online shop and marketplaces. Days are India days.
 * With a store chosen, everything is that store's; without one, the whole shop.
 */
const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;
const MONTHS = 9;
const TOP = 5;
const LATEST = 5;
const LOW_LIST = 4;
const NEED_LIST = 30;

type User = { permissions?: string[]; roles?: string[] };

const n = (v: unknown) => Number(v ?? 0) || 0;

export async function dashboardOverview(clientId: string, user: User, locationId?: string, now = new Date()) {
  const may = (key: string) => holdsEverything(user.permissions ?? [], user.roles ?? []) || grants(user.permissions ?? [], key);
  const money = may('report:financial');
  const stockOk = may('inventory:view');
  const topOk = money || may('report:view');
  const ordersOk = may('sales_order:view');

  const here = locationId ? Prisma.sql`AND so.location_id = ${locationId}` : Prisma.empty;
  const real = Prisma.sql`so.client_id = ${clientId} AND so.deleted_at IS NULL AND so.status::text NOT IN ('CANCELLED', 'DRAFT') ${here}`;
  const istDay = Prisma.sql`((so.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::date`;
  const online = Prisma.sql`so.channel::text IN ('ONLINE', 'MARKETPLACE')`;

  // Every part at once: each is a trip to the database, and one after another they took ~3 s.
  // Today, in India, is counted for everybody who can see the dashboard: how many orders, not their value.
  const [[today], sales, stock, topSellers, latestOrders, tiedUp] = await Promise.all([
    prisma.$queryRaw<{ orders: bigint; total: unknown }[]>(Prisma.sql`
      SELECT COUNT(*) AS orders, COALESCE(SUM(so.total), 0) AS total FROM sales_orders so
      WHERE ${real} AND ${istDay} = ((${now}::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::date`),
    money ? salesPart(real, istDay, online, now) : null,
    stockOk ? stockPart(clientId, locationId, money, now) : null,
    topOk ? topPart(real, now, money) : null,
    ordersOk ? latestPart(clientId, locationId) : null,
    money ? tiedUpPart(clientId, locationId, now) : null
  ]);

  return {
    today: { orders: Number(today?.orders ?? 0), total: money ? n(today?.total) : null },
    sales, stock, topSellers, latestOrders, tiedUp
  };
}

/**
 * Money tied up: what suppliers still owe in goods, and stock that has not moved in 90 days.
 *
 * "Still to arrive" is what is LEFT on open purchase orders -- ordered less received, at the order's
 * price -- for orders coming to this store. The old Open PO tile summed the whole of every open
 * order across the shop, the parts already on the shelf included: sphl's Main Store read ₹26,500
 * with nothing on its way to it, and only ₹8,500 still to come anywhere.
 *
 * "Not moved in 90 days" is the old Dead Stock tile's figure, unchanged: same cost chain, binned
 * products out, pieces held here whose last movement (any store) was over 90 days ago.
 */
async function tiedUpPart(clientId: string, locationId: string | undefined, now: Date) {
  const here = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;
  const [orders, [dead]] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { clientId, status: { in: ['SENT', 'PARTIALLY_RECEIVED'] } },
      select: { locationId: true, items: { select: { orderedQty: true, receivedQty: true, unitPrice: true } } }
    }),
    prisma.$queryRaw<{ value: unknown; pieces: unknown; colours: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(s.qty * ${UNIT_COST}), 0) AS value, COALESCE(SUM(s.qty), 0) AS pieces, COUNT(*) AS colours
      FROM inventory_product_variants v
      JOIN inventory_products p ON p.id = v.product_id
      JOIN (SELECT variant_id, SUM(quantity) AS qty FROM inventory_stocks WHERE client_id = ${clientId} ${here} GROUP BY variant_id) s ON s.variant_id = v.id
      WHERE v.client_id = ${clientId} AND p.status::text <> 'TRASHED' AND s.qty > 0
        AND v.last_movement_at IS NOT NULL AND v.last_movement_at < ${new Date(now.getTime() - 90 * DAY)}`)
  ]);
  const left = (o: typeof orders[0]) => o.items.reduce((t, i) => t + Math.max(0, i.orderedQty - i.receivedQty) * n(i.unitPrice), 0);
  const coming = orders.map(o => ({ to: o.locationId, value: left(o) })).filter(o => o.value > 0);
  const mine = locationId ? coming.filter(o => o.to === locationId) : coming;
  return {
    toArrive: mine.reduce((t, o) => t + o.value, 0),
    toArriveOrders: mine.length,
    // The whole shop's, so a store with nothing coming can still see what is on its way elsewhere.
    toArriveAll: coming.reduce((t, o) => t + o.value, 0),
    toArriveAllOrders: coming.length,
    dead: n(dead?.value), deadPieces: n(dead?.pieces), deadColours: Number(dead?.colours ?? 0)
  };
}

/** Last 30 days against the 30 before, day by day for the last 30, and month by month. */
async function salesPart(real: Prisma.Sql, istDay: Prisma.Sql, online: Prisma.Sql, now: Date) {
  const from60 = new Date(now.getTime() - 60 * DAY), from30 = new Date(now.getTime() - 30 * DAY);
  const [[win], dayRows, monthRows] = await Promise.all([prisma.$queryRaw<{ last30: unknown; prev30: unknown; orders30: bigint }[]>(Prisma.sql`
    SELECT COALESCE(SUM(so.total) FILTER (WHERE so.created_at > ${from30}), 0) AS last30,
           COALESCE(SUM(so.total) FILTER (WHERE so.created_at <= ${from30}), 0) AS prev30,
           COUNT(*) FILTER (WHERE so.created_at > ${from30}) AS orders30
    FROM sales_orders so WHERE ${real} AND so.created_at > ${from60} AND so.created_at <= ${now}`),
  prisma.$queryRaw<{ d: Date; till: unknown; online: unknown }[]>(Prisma.sql`
    SELECT ${istDay} AS d, COALESCE(SUM(so.total) FILTER (WHERE NOT ${online}), 0) AS till, COALESCE(SUM(so.total) FILTER (WHERE ${online}), 0) AS online
    FROM sales_orders so WHERE ${real} AND so.created_at > ${new Date(now.getTime() - 31 * DAY)} GROUP BY 1`),
  prisma.$queryRaw<{ m: string; till: unknown; online: unknown; orders: bigint }[]>(Prisma.sql`
    SELECT to_char(${istDay}, 'YYYY-MM') AS m, COALESCE(SUM(so.total) FILTER (WHERE NOT ${online}), 0) AS till,
           COALESCE(SUM(so.total) FILTER (WHERE ${online}), 0) AS online, COUNT(*) AS orders
    FROM sales_orders so WHERE ${real} AND so.created_at > ${new Date(now.getTime() - (MONTHS * 31 + 1) * DAY)} GROUP BY 1`)]);

  // Every day and every month present, zeros included, so a chart's gaps are real quiet days.
  const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000);
  const key = (d: Date) => ist(d).toISOString().slice(0, 10);
  const byDay = new Map(dayRows.map(r => [new Date(r.d).toISOString().slice(0, 10), r]));
  const daily = Array.from({ length: 30 }, (_, i) => {
    const k = key(new Date(now.getTime() - (29 - i) * DAY)), r = byDay.get(k);
    return { day: k, till: n(r?.till), online: n(r?.online) };
  });
  const byMonth = new Map(monthRows.map(r => [r.m, r]));
  const t = ist(now);
  const monthly = Array.from({ length: MONTHS }, (_, i) => {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - (MONTHS - 1 - i), 1));
    const k = d.toISOString().slice(0, 7), r = byMonth.get(k);
    return { month: k, till: n(r?.till), online: n(r?.online), orders: Number(r?.orders ?? 0) };
  });
  return { last30: n(win?.last30), prev30: n(win?.prev30), orders30: Number(win?.orders30 ?? 0), daily, monthly };
}

/** Pieces on hand, colours (variants) plenty / low / sold out, and the lowest few. */
async function stockPart(clientId: string, locationId: string | undefined, money: boolean, now: Date) {
  const here = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;
  const qty = Prisma.sql`COALESCE(s.qty, 0)`;
  const base = Prisma.sql`
    FROM inventory_product_variants v
    JOIN inventory_products p ON p.id = v.product_id
    LEFT JOIN (SELECT variant_id, SUM(quantity) AS qty FROM inventory_stocks WHERE client_id = ${clientId} ${here} GROUP BY variant_id) s ON s.variant_id = v.id
    WHERE v.client_id = ${clientId} AND p.status::text <> 'TRASHED' AND p.is_service = false`;
  // Pieces count every product not binned -- the same stock the value below is worked out on (an
  // archived product's pieces are still on the shelf). The status says binned, as it does for the
  // value: a binned date alone (one old test product, archived) is not enough to drop its pieces
  // from one card while the other counts them. Services (an alteration, a fall-and-pico) hold no stock:
  // never a colour, never "sold out". Low and sold out only for what is on sale:
  // active or draft, as the low-stock count everywhere else in the app.
  const selling = Prisma.sql`p.status::text IN ('ACTIVE', 'DRAFT')`;
  const [[c], lowest, soldOut, value, nights] = await Promise.all([prisma.$queryRaw<{ units: unknown; colours: bigint; low: bigint; out: bigint; low_pieces: unknown }[]>(Prisma.sql`
    SELECT COALESCE(SUM(${qty}), 0) AS units, COUNT(*) AS colours,
           COUNT(*) FILTER (WHERE ${selling} AND ${lowStockSql(qty)}) AS low, COUNT(*) FILTER (WHERE ${selling} AND ${outOfStockSql(qty)}) AS out,
           COALESCE(SUM(${qty}) FILTER (WHERE ${selling} AND ${lowStockSql(qty)}), 0) AS low_pieces ${base}`),
  prisma.$queryRaw<{ product_id: string; title: string; colour: string | null; size: string | null; qty: unknown; level: number }[]>(Prisma.sql`
    SELECT p.id AS product_id, p.title, v.color_name AS colour, v.size, ${qty} AS qty, v.reorder_level AS level ${base} AND ${selling} AND ${lowStockSql(qty)}
    ORDER BY ${qty}::float / NULLIF(v.reorder_level, 0) ASC, p.title LIMIT ${NEED_LIST}`),
  // Published and sold out here: sales being lost right now, so first on the restocking list. Drafts
  // with nothing yet are not on sale and are left to the Products page.
  prisma.$queryRaw<{ product_id: string; title: string; colour: string | null; size: string | null; level: number }[]>(Prisma.sql`
    SELECT p.id AS product_id, p.title, v.color_name AS colour, v.size, v.reorder_level AS level ${base} AND p.status::text = 'ACTIVE' AND ${outOfStockSql(qty)}
    ORDER BY p.title, v.color_name LIMIT ${NEED_LIST}`),
  // What it is worth, the same figure as the Inventory value tile; only for somebody allowed money.
  money ? inventoryValueFor(clientId, locationId) : Promise.resolve(null),
  money ? nightlyValues(clientId, locationId, now) : Promise.resolve(null)]);
  const valueTrend = nights && value != null ? endingToday(nights, value, now) : null;
  return {
    units: n(c?.units), colours: Number(c?.colours ?? 0), low: Number(c?.low ?? 0), out: Number(c?.out ?? 0), lowPieces: n(c?.low_pieces),
    value,
    // What it was worth night by night over the last 30 days, this store's (or the whole shop's), ending today.
    valueTrend,
    lowest: lowest.slice(0, LOW_LIST).map(r => ({ productId: r.product_id, title: r.title, colour: r.colour, size: r.size, left: n(r.qty), level: r.level })),
    // The lower half's restocking list: sold out (published) first, then running low, lowest first.
    toRestock: [
      ...soldOut.map(r => ({ productId: r.product_id, title: r.title, colour: r.colour, size: r.size, left: 0, level: r.level, soldOut: true })),
      ...lowest.map(r => ({ productId: r.product_id, title: r.title, colour: r.colour, size: r.size, left: n(r.qty), level: r.level, soldOut: false }))
    ].slice(0, NEED_LIST),
    soldOutLive: soldOut.length
  };
}

/**
 * The stock value over the last 30 days: the nightly snapshot for this store (or for the whole shop with
 * no store chosen), and today's live figure as the last point so the line ends where the card's number is.
 */
const istDayKey = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
async function nightlyValues(clientId: string, locationId: string | undefined, now: Date) {
  const since = new Date(now.getTime() - 30 * DAY);
  const rows = locationId
    ? await prisma.dailyLocationSnapshot.findMany({ where: { clientId, locationId, snapshotDate: { gte: since } }, orderBy: { snapshotDate: 'asc' }, select: { snapshotDate: true, totalValue: true } })
    : await prisma.dailyInventorySnapshot.findMany({ where: { clientId, snapshotDate: { gte: since } }, orderBy: { snapshotDate: 'asc' }, select: { snapshotDate: true, totalValue: true } });
  return rows.map(r => ({ day: istDayKey(r.snapshotDate), value: n(r.totalValue) }));
}
function endingToday(nights: { day: string; value: number }[], today: number, now: Date) {
  const points = nights.map(p => ({ ...p }));
  const todayKey = istDayKey(now);
  if (points.length && points[points.length - 1].day === todayKey) points[points.length - 1].value = today;
  else points.push({ day: todayKey, value: today });
  return points;
}

/** The best sellers of the last 30 days, by value (or by pieces for somebody not allowed money), with a photo. */
async function topPart(real: Prisma.Sql, now: Date, money: boolean) {
  const rows = await prisma.$queryRaw<{ product_id: string; title: string; pieces: unknown; revenue: unknown }[]>(Prisma.sql`
    SELECT p.id AS product_id, p.title, SUM(i.quantity) AS pieces, SUM(i.total_price) AS revenue
    FROM sales_orders so
    JOIN sales_order_items i ON i.sales_order_id = so.id
    JOIN inventory_product_variants v ON v.id = i.variant_id
    JOIN inventory_products p ON p.id = v.product_id
    WHERE ${real} AND so.created_at > ${new Date(now.getTime() - 30 * DAY)} AND p.trashed_at IS NULL
    GROUP BY p.id, p.title
    ORDER BY ${money ? Prisma.sql`SUM(i.total_price)` : Prisma.sql`SUM(i.quantity)`} DESC, p.title LIMIT ${TOP}`);
  const photos = rows.length ? await prisma.productImage.findMany({
    where: { productId: { in: rows.map(r => r.product_id) } },
    orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }],
    select: { productId: true, url: true }
  }) : [];
  return rows.map(r => ({
    productId: r.product_id, title: r.title, pieces: n(r.pieces),
    revenue: money ? n(r.revenue) : null,
    photo: photos.find(p => p.productId === r.product_id)?.url ?? null
  }));
}

/** The newest orders, till and online. */
async function latestPart(clientId: string, locationId: string | undefined) {
  const orders = await prisma.salesOrder.findMany({
    where: { clientId, deletedAt: null, status: { not: 'DRAFT' }, ...(locationId ? { locationId } : {}) },
    orderBy: { createdAt: 'desc' }, take: LATEST,
    select: { id: true, orderNumber: true, total: true, channel: true, status: true, createdAt: true, customerName: true, customer: { select: { name: true } } }
  });
  return orders.map(o => ({
    id: o.id, orderNumber: o.orderNumber, channel: o.channel, status: o.status, at: o.createdAt,
    who: o.customer?.name || o.customerName || null,
    // The same as the Orders list shows anybody allowed to open orders.
    total: n(o.total)
  }));
}
