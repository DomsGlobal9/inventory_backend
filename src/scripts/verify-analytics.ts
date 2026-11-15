/**
 * The full pages behind the dashboard cards (services/analytics): Sales, Stock value, Stock on hand, Running low.
 *
 * Builds one throwaway shop whose every figure is worked out by hand below, then asks the service and checks each
 * answer against what it SHOULD be -- cancelled, draft and deleted orders left out, returns, the period before,
 * fabric in centimetres, an empty store, a switched-off store, binned and service products, held stock, a store
 * from another shop, and every way of choosing dates wrong. Then the routes: only the owner, until a role is given
 * the key. LOCAL database only; removes everything it made.
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-analytics.ts
 */
import axios from 'axios';
import fs from 'node:fs';
import { prisma } from '../lib/prisma';
import { salesPage, stockValuePage, stockOnHandPage, runningLowPage, periodOf } from '../services/analytics';
import { dashboardOverview } from '../services/dashboard-overview';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost|127\.0\.0\.1/.test(process.env[k] ?? '')) { console.error(`refusing: ${k} is not the local database`); process.exit(1); }
}
const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const S = Date.now().toString(36);
const C = `antest-${S}`;
const OTHER = `antest-other-${S}`;
const DAY = 86_400_000;
const now = new Date();
const ago = (d: number) => new Date(now.getTime() - d * DAY);
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => { ok ? good++ : bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
const refused = async (p: Promise<unknown>, status: number, words: RegExp) => p.then(() => 'answered', (e: any) => (e.statusCode === status && words.test(e.message) ? 'ok' : `${e.statusCode} ${e.message}`));

async function main() {
  console.log('A THROWAWAY SHOP, EVERY FIGURE KNOWN');
  const mk = (name: string, active = true) => prisma.stockLocation.create({ data: { clientId: C, name, code: `${name.slice(0, 3).toUpperCase()}-${S}`, type: 'STORE', active } as any });
  const A = await mk('Main'), B = await mk('Branch'), Cst = await mk('Empty store'), D = await mk('Old store', false);
  const otherStore = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Not yours', code: `NY-${S}`, type: 'STORE' } as any });
  const product = async (code: string, o: { title: string; soldBy?: string; kind?: string | null; dressType?: string | null; status?: string; isService?: boolean; price: number; cost?: number | null; level: number }) => {
    const p = await prisma.product.create({ data: { clientId: C, productCode: `${code}-${S}`, slug: `${code.toLowerCase()}-${S}`, title: o.title, category: 'WOMEN', productType: 'READY_TO_WEAR', status: o.status ?? 'ACTIVE', basePrice: o.price, soldBy: o.soldBy ?? 'PIECE', kind: o.kind ?? null, dressType: o.dressType ?? null, isService: o.isService ?? false } as any });
    const v = await prisma.productVariant.create({ data: { clientId: C, productId: p.id, sku: `${code}-${S}`, variantCode: `V${code}-${S}`, size: 'Free', colorName: 'Red', sellingPrice: o.price, ...(o.cost != null ? { costPrice: o.cost } : {}), reorderLevel: o.level } as any });
    return { p, v };
  };
  const stock = (v: { id: string }, loc: { id: string }, quantity: number, reservedQty = 0) => prisma.inventoryStock.create({ data: { clientId: C, variantId: v.id, locationId: loc.id, quantity, reservedQty } as any });
  const P1 = await product('P1', { title: 'Kanchi saree', dressType: 'Saree', price: 1000, cost: 600, level: 5 });
  const P2 = await product('P2', { title: 'Silk fabric', soldBy: 'METRE', kind: 'FABRIC', price: 4.5, cost: 3, level: 1000 });
  const P3 = await product('P3', { title: 'Bridal lehenga', dressType: 'Lehenga', price: 5000, cost: 2000, level: 2 });
  const P4 = await product('P4', { title: 'Cotton kurti', dressType: 'Kurti', price: 800, cost: 400, level: 3 });
  const P5 = await product('P5', { title: 'Draft dupatta', status: 'DRAFT', price: 300, cost: 100, level: 2 });
  const P6 = await product('P6', { title: 'Binned saree', status: 'TRASHED', price: 900, cost: 500, level: 1 });
  const P8 = await product('P8', { title: 'Old stock shawl', price: 100, cost: null, level: 0 });
  await product('P7', { title: 'Fall and pico', isService: true, price: 150, cost: null, level: 0 });
  await stock(P1.v, A, 3); await stock(P1.v, B, 20, 12);   // B holds 20 but 12 are held for orders: 3 spare above its level of 5
  await stock(P2.v, A, 2550); await stock(P2.v, B, 400);    // 25.5 m and 4 m
  await stock(P3.v, A, 1);
  await stock(P4.v, A, 0);
  await stock(P5.v, A, 0);
  await stock(P6.v, A, 100);
  await stock(P8.v, D, 1);                                  // only in the switched-off store, no cost recorded

  const cust = await prisma.customer.create({ data: { clientId: C, customerCode: `CU-${S}`, name: 'Robot buyer' } as any });
  let no = 0;
  const order = async (o: { at: Date; loc: { id: string }; channel?: string; status?: string; deleted?: boolean; total: number; lines: [{ id: string }, number, number][]; pay?: [string, number][] }) => {
    const so = await prisma.salesOrder.create({ data: {
      clientId: C, orderNumber: `AN-${S}-${++no}`, customerId: cust.id, locationId: o.loc.id, channel: o.channel ?? 'POS', status: o.status ?? 'CONFIRMED',
      total: o.total, createdAt: o.at, ...(o.deleted ? { deletedAt: o.at } : {})
    } as any });
    for (const [v, quantity, totalPrice] of o.lines) {
      await prisma.salesOrderItem.create({ data: { salesOrderId: so.id, variantId: v.id, quantity, listUnitPrice: totalPrice / quantity, unitPrice: totalPrice / quantity, unitCost: 0, totalPrice } as any });
    }
    for (const [method, amount] of o.pay ?? []) await prisma.salesOrderPayment.create({ data: { clientId: C, salesOrderId: so.id, locationId: o.loc.id, method, amount } as any });
    return so;
  };
  const O1 = await order({ at: ago(2), loc: A, total: 2000, lines: [[P1.v, 2, 2000]], pay: [['UPI', 2000]] });
  await order({ at: ago(3), loc: A, channel: 'ONLINE', total: 900, lines: [[P2.v, 200, 900]], pay: [['ONLINE', 900]] });
  await order({ at: ago(10), loc: B, total: 1000, lines: [[P1.v, 1, 1000]], pay: [['CASH', 1000]] });
  await order({ at: ago(1), loc: A, status: 'CANCELLED', total: 5000, lines: [[P3.v, 1, 5000]], pay: [['CARD', 5000]] });
  await order({ at: ago(1), loc: A, status: 'DRAFT', total: 7000, lines: [[P3.v, 1, 7000]] });
  await order({ at: ago(1), loc: A, deleted: true, total: 6000, lines: [[P3.v, 1, 6000]] });
  await order({ at: ago(40), loc: A, total: 3000, lines: [[P1.v, 3, 3000]], pay: [['CARD', 3000]] });
  await order({ at: ago(200), loc: A, total: 500, lines: [[P4.v, 1, 500]], pay: [['CASH', 500]] });
  await prisma.salesReturn.create({ data: { clientId: C, returnNumber: `RT-${S}-1`, salesOrderId: O1.id, status: 'COMPLETED', reason: 'SIZE_ISSUE', refundTotal: 400, completedAt: ago(1) } as any });
  await prisma.salesReturn.create({ data: { clientId: C, returnNumber: `RT-${S}-2`, salesOrderId: O1.id, status: 'REQUESTED', reason: 'SIZE_ISSUE', refundTotal: 999 } as any });

  console.log('\nSALES, 30 DAYS, ALL STORES');
  const s30 = await salesPage(C, { period: '30d' }, now);
  const t = s30.totals;
  check('sales are the three real orders: 2,000 + 900 + 1,000 = 3,900 (cancelled, draft, deleted and older ones left out)', t.sales === 3900, t);
  check('till 3,000 and online 900; 3 bills, 2 at the till and 1 online', t.till === 3000 && t.online === 900 && t.bills === 3 && t.tillBills === 2 && t.onlineBills === 1, t);
  check('the 30 days before held 3,000, so +30%', t.previous === 3000 && t.change === 30, { previous: t.previous, change: t.change });
  check('the average bill is 1,300', t.average === 1300, t.average);
  check('one finished return of 400 (a requested one is not counted), 10.3% of sales', t.returns === 400 && t.returnCount === 1 && t.returnShare === 10.3, t);
  check('day by day: 31 India days, adding up to the total', s30.series.length === 31 && near(s30.series.reduce((x, d) => x + d.till + d.online, 0), 3900), s30.series.length);
  check('each store: Main 2,900 (2 bills), Branch 1,000 (1)', JSON.stringify(s30.stores.map(s => [s.name, s.sales, s.bills])) === JSON.stringify([['Main', 2900, 2], ['Branch', 1000, 1]]), s30.stores);
  check('best sellers: the saree (3 pieces, 3,000) then the fabric (200 cm, 900) with its unit', s30.bestSellers.length === 2 && s30.bestSellers[0].productId === P1.p.id && s30.bestSellers[0].quantity === 3 && s30.bestSellers[0].sales === 3000
    && s30.bestSellers[1].soldBy === 'METRE' && s30.bestSellers[1].quantity === 200, s30.bestSellers);
  check('payments: UPI 2,000, Cash 1,000, Online 900 (the cancelled card payment left out)', JSON.stringify(s30.payments) === JSON.stringify([{ method: 'UPI', amount: 2000 }, { method: 'CASH', amount: 1000 }, { method: 'ONLINE', amount: 900 }]), s30.payments);
  check('what sold: Saree 3,000, Fabric 900 (the fabric by its kind)', JSON.stringify(s30.categories) === JSON.stringify([{ name: 'Saree', sales: 3000 }, { name: 'Fabric', sales: 900 }]), s30.categories);
  const dash = await dashboardOverview(C, { permissions: ['*'] }, undefined, now);
  check('the same 30 days as the dashboard card: 3,900 against 3,000 before, 3 orders', dash.sales?.last30 === 3900 && dash.sales?.prev30 === 3000 && dash.sales?.orders30 === 3, dash.sales && { last30: dash.sales.last30, prev30: dash.sales.prev30 });
  check('the card\'s till and online parts add up to its total: 3,000 + 900', dash.sales?.till30 === 3000 && dash.sales?.online30 === 900, dash.sales && { till30: dash.sales.till30, online30: dash.sales.online30 });

  // A till sale at 11:59 pm on the 30th India day back: inside the 30 days (by the clock) but before the daily chart's
  // first midnight. Found on sphl 15 Nov: SO-000064 was in the total and in neither part. (Only between 11:59 pm and
  // midnight is this sale outside the 30 days; the check still holds then.)
  const istToday = new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const edgeAt = new Date(Date.parse(`${istToday}T00:00:00Z`) - 5.5 * 3600_000 - 29 * DAY - 60_000);
  const inWindow = edgeAt.getTime() > now.getTime() - 30 * DAY;
  const edge = await order({ at: edgeAt, loc: A, total: 777, lines: [[P4.v, 1, 777]] });
  const dashEdge = await dashboardOverview(C, { permissions: ['*'] }, undefined, now);
  const e = dashEdge.sales!;
  check('a till sale just before day 30\'s midnight: in the total, and in the till part, so the parts still add up',
    e.last30 === (inWindow ? 4677 : 3900) && e.till30 === (inWindow ? 3777 : 3000) && e.online30 === 900 && near(e.till30 + e.online30, e.last30),
    { last30: e.last30, till30: e.till30, online30: e.online30, inWindow });
  check('...while the daily chart, which starts at midnight, leaves it out (the case the split had missed)',
    near(e.daily.reduce((x, d) => x + d.till, 0), 3000), e.daily.reduce((x, d) => x + d.till, 0));

  // Every other kind of sale at the same edge, and the ones that must stay out (15 Nov, "test all cases").
  const extra = [
    await order({ at: edgeAt, loc: A, channel: 'ONLINE', total: 50, lines: [[P4.v, 1, 50]] }),         // online part
    await order({ at: edgeAt, loc: B, channel: 'MARKETPLACE', total: 20, lines: [[P4.v, 1, 20]] }),    // online part (Shopify comes in as these)
    await order({ at: edgeAt, loc: B, channel: 'MANUAL', total: 3, lines: [[P4.v, 1, 3]] }),           // till part
    await order({ at: edgeAt, loc: A, status: 'CANCELLED', total: 1000, lines: [[P4.v, 1, 1000]] }),   // out
    await order({ at: edgeAt, loc: A, status: 'DRAFT', total: 2000, lines: [[P4.v, 1, 2000]] }),       // out
    await order({ at: edgeAt, loc: A, deleted: true, total: 4000, lines: [[P4.v, 1, 4000]] }),         // out
    await order({ at: new Date(now.getTime() - 30 * DAY), loc: A, total: 8000, lines: [[P4.v, 1, 8000]] }) // exactly 30 days: the 30 before
  ];
  const w = inWindow ? 1 : 0;
  const all = (await dashboardOverview(C, { permissions: ['*'] }, undefined, now)).sales!;
  check('every channel at the edge: till 3,000 + 777 + 3 (manual), online 900 + 50 + 20 (marketplace); cancelled, draft and deleted left out',
    all.till30 === 3000 + w * 780 && all.online30 === 900 + w * 70 && all.last30 === 3900 + w * 850 && near(all.till30 + all.online30, all.last30),
    { till30: all.till30, online30: all.online30, last30: all.last30, inWindow });
  check('a sale exactly 30 days ago belongs to the 30 days before, in the total and the split alike', all.prev30 === 3000 + 8000 + (inWindow ? 0 : 850), { prev30: all.prev30 });
  const atMain = (await dashboardOverview(C, { permissions: ['*'] }, A.id, now)).sales!;
  check('one store chosen (Main): its own split, adding up to its own total',
    atMain.till30 === 2000 + w * 777 && atMain.online30 === 900 + w * 50 && near(atMain.till30 + atMain.online30, atMain.last30), { till30: atMain.till30, online30: atMain.online30, last30: atMain.last30 });
  const atEmpty = (await dashboardOverview(C, { permissions: ['*'] }, Cst.id, now)).sales!;
  check('a store with no sales: 0 and 0, total 0', atEmpty.till30 === 0 && atEmpty.online30 === 0 && atEmpty.last30 === 0, atEmpty);
  const viewer = (await dashboardOverview(C, { permissions: ['analytics:sales'] }, undefined, now)).sales;
  check('someone given only the Sales page gets the same split on the card', viewer?.till30 === all.till30 && viewer?.online30 === all.online30, viewer && { till30: viewer.till30 });
  const noSales = (await dashboardOverview(C, { permissions: ['inventory:view'] }, undefined, now)).sales;
  check('someone without sales rights gets no sales figures at all (no split either)', noSales == null, noSales);
  const page30 = await salesPage(C, { period: '30d' }, now);
  check('the Sales page it opens shows the same till and online as the card', page30.totals.till === all.till30 && page30.totals.online === all.online30, { page: [page30.totals.till, page30.totals.online], card: [all.till30, all.online30] });
  for (const so of [edge, ...extra]) { await prisma.salesOrderItem.deleteMany({ where: { salesOrderId: so.id } }); await prisma.salesOrder.delete({ where: { id: so.id } }); }

  console.log('\nSALES, OTHER PERIODS AND ONE STORE');
  const main = await salesPage(C, { period: '30d', locationId: A.id }, now);
  check('Main only: 2,900 from 2 bills, against 3,000 before (-3.3%)', main.totals.sales === 2900 && main.totals.bills === 2 && main.totals.change === -3.3 && main.store?.name === 'Main', main.totals);
  const dashA = await dashboardOverview(C, { permissions: ['*'] }, A.id, now);
  check('...matching the dashboard card with Main chosen', dashA.sales?.last30 === 2900, dashA.sales?.last30);
  check('7 days: 2,900 (the two newest)', (await salesPage(C, { period: '7d' }, now)).totals.sales === 2900);
  const yr = await salesPage(C, { period: 'year' }, now);
  check('a year: 7,400, month by month (13 months listed)', yr.totals.sales === 7400 && yr.period.by === 'month' && yr.series.length === 13 && near(yr.series.reduce((x, d) => x + d.till + d.online, 0), 7400), { s: yr.totals.sales, n: yr.series.length });
  const day10 = new Date(ago(10).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const one = await salesPage(C, { period: 'custom', from: day10, to: day10 }, now);
  check('two dates, one day: just the Branch bill (1,000), one day listed', one.totals.sales === 1000 && one.series.length === 1, one.totals);
  const empty = await salesPage(C, { period: 'custom', from: '2024-01-01', to: '2024-01-31' }, now);
  check('a month with no sales: all zero, the change unknown, no store listed', empty.totals.sales === 0 && empty.totals.change === null && empty.totals.average === null && empty.stores.length === 0, empty.totals);
  check('the empty store is asked for: zero, not an error', (await salesPage(C, { period: '30d', locationId: Cst.id }, now)).totals.sales === 0);

  console.log('\nSALES: CHOOSING WRONG');
  check('dates without both days are refused', await refused(salesPage(C, { period: 'custom', from: '2026-01-01' }, now), 400, /start date and an end date/) === 'ok');
  check('a start after the end is refused', await refused(salesPage(C, { period: 'custom', from: '2026-03-02', to: '2026-03-01' }, now), 400, /on or before the end date/) === 'ok');
  check('a start in the future is refused', await refused(salesPage(C, { period: 'custom', from: '2099-01-01', to: '2099-01-02' }, now), 400, /future/) === 'ok');
  check('more than a year is refused', await refused(salesPage(C, { period: 'custom', from: '2024-01-01', to: '2025-06-01' }, now), 400, /one year/) === 'ok');
  check('before 2020 is refused', await refused(salesPage(C, { period: 'custom', from: '2019-01-01', to: '2019-02-01' }, now), 400, /2020/) === 'ok');
  check('a made-up date (31 Feb) is refused', await refused(salesPage(C, { period: 'custom', from: '2026-02-31', to: '2026-03-01' }, now), 400, /start date and an end date/) === 'ok');
  check('an unknown period is refused', await refused(salesPage(C, { period: 'forever' }, now), 400, /custom range/) === 'ok');
  check('another shop\'s store is "not found", never its figures', await refused(salesPage(C, { period: '30d', locationId: otherStore.id }, now), 404, /could not be found/) === 'ok');
  check('a store id that is not one at all is "not found"', await refused(salesPage(C, { period: '30d', locationId: "x' OR 1=1 --" }, now), 404, /could not be found/) === 'ok');
  const toEnd = periodOf({ period: 'custom', from: '2026-01-01', to: '2099-12-31' }, now);
  check('an end date in the future stops at today', toEnd.toDay <= new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10), toEnd.toDay);

  console.log('\nSTOCK VALUE');
  const v = await stockValuePage(C, now);
  const row = (name: string) => v.stores.find(s => s.name === name);
  check('Main at cost 11,450: 3 sarees x 600 + 2,550 cm x 3 + 1 lehenga x 2,000 (binned saree left out)', near(row('Main')!.atCost, 11450), row('Main'));
  check('Main at selling price 19,475', near(row('Main')!.atPrice, 19475), row('Main')?.atPrice);
  check('Branch at cost 13,200 and 21,800 at price (held stock is still stock)', near(row('Branch')!.atCost, 13200) && near(row('Branch')!.atPrice, 21800), row('Branch'));
  check('the switched-off store still shows what it holds, marked switched off (100 at its price, no cost)', near(row('Old store')!.atCost, 100) && row('Old store')!.active === false, row('Old store'));
  check('all stores together 24,750, the same as the dashboard\'s whole-shop value', near(v.totals.atCost, 24750) && near(dash.stock?.value ?? -1, 24750), { page: v.totals.atCost, card: dash.stock?.value });
  check('pieces 25 and fabric 2,950 cm across the stores', v.totals.pieces === 25 && v.totals.fabricCm === 2950, v.totals);
  check('stores sorted by value: Branch, Main, Old store; the empty store folded away', v.stores.map(s => s.name).join() === 'Branch,Main,Old store' && v.emptyStores.map(s => s.name).join() === 'Empty store', { stores: v.stores.map(s => s.name), empty: v.emptyStores });
  check('1 piece is counted at its selling price for want of a cost', v.totals.pricedNotCosted === 1, v.totals.pricedNotCosted);
  check('by kind of goods: Saree 13,800, Fabric 8,850, Lehenga 2,000, Other 100', JSON.stringify(v.categories.map(c => [c.name, Math.round(c.atCost)])) === JSON.stringify([['Saree', 13800], ['Fabric', 8850], ['Lehenga', 2000], ['Other', 100]]), v.categories);
  check('the six-month line ends on today\'s value', v.trend.length >= 1 && near(v.trend[v.trend.length - 1].value, 24750), v.trend);

  console.log('\nSTOCK ON HAND');
  const h = await stockOnHandPage(C);
  const hs = (name: string) => h.stores.find(s => s.name === name)!;
  check('Main carries 5 colours: 2 low (saree 3, lehenga 1), 1 sold out (kurti; the draft is not "sold out"), 2 plenty', hs('Main').colours === 5 && hs('Main').low === 2 && hs('Main').out === 1 && hs('Main').plenty === 2, hs('Main'));
  check('Branch: 2 colours, the fabric low (4 m under 10 m), the saree plenty; never-stocked items are not "sold out" there', hs('Branch').colours === 2 && hs('Branch').low === 1 && hs('Branch').out === 0, hs('Branch'));
  check('the whole shop, the dashboard\'s way: 6 colours, 1 low, 2 out', h.totals.colours === 6 && h.totals.low === 1 && h.totals.out === 2, h.totals);
  check('...the same as the card', dash.stock?.colours === 6 && dash.stock?.low === 1 && dash.stock?.out === 2, dash.stock && { c: dash.stock.colours, l: dash.stock.low, o: dash.stock.out });
  check('the empty store is folded away, not a row of zeros', h.emptyStores.some(s => s.name === 'Empty store') && !h.stores.some(s => s.name === 'Empty store'));
  const fab = await stockOnHandPage(C, { group: 'Fabric' });
  check('just fabric: 2,950 cm in 2 stores, no pieces', fab.totals.fabricCm === 2950 && fab.totals.pieces === 0 && fab.stores.length === 2, fab.totals);
  const other = await stockOnHandPage(C, { group: 'Other' });
  check('"Other" (no kind, no garment type): the draft dupatta and the shawl', other.stores.length >= 1 && other.totals.pieces === 1, other.totals);
  check('an unknown kind of goods is an empty answer, not an error', (await stockOnHandPage(C, { group: 'Spaceships' })).stores.length === 0);

  console.log('\nRUNNING LOW');
  const r = await runningLowPage(C, {}, now);
  const lr = (sku: string, store: string) => r.rows.find(x => x.sku === `${sku}-${S}` && x.store === store);
  check('3 low and 1 sold out, store by store (the draft and the binned left out)', r.counts.low === 3 && r.counts.out === 1 && r.rows.length === 4, r.counts);
  const sareeMain = lr('P1', 'Main');
  check('the saree at Main: 3 left, sells 0.5 a week, lasts 42 days', sareeMain?.left === 3 && sareeMain.perWeek === 0.5 && sareeMain.daysLeft === 42, sareeMain);
  check('...next step: move 3 from Branch (Branch holds 20, 12 held for orders, keeps its 5)', sareeMain?.next.kind === 'MOVE' && (sareeMain.next as any).fromName === 'Branch' && (sareeMain.next as any).quantity === 3, sareeMain?.next);
  const fabB = lr('P2', 'Branch');
  check('the fabric at Branch: 400 cm left; move 1,550 cm from Main (25.5 m less its 10 m level)', fabB?.left === 400 && fabB.next.kind === 'MOVE' && (fabB.next as any).quantity === 1550 && (fabB.next as any).fromName === 'Main', fabB);
  check('the lehenga: nothing sold in 60 days, so "check the reorder level"', lr('P3', 'Main')?.next.kind === 'SLOW', lr('P3', 'Main')?.next);
  check('the kurti, sold out with no spare anywhere: a purchase order for 6 (twice its level)', lr('P4', 'Main')?.soldOut === true && lr('P4', 'Main')?.next.kind === 'ORDER' && (lr('P4', 'Main')?.next as any).quantity === 6, lr('P4', 'Main'));
  check('soonest first: sold out (0 days) at the top', r.rows[0].sku === `P4-${S}`, r.rows.map(x => x.sku));
  const onlyOut = await runningLowPage(C, { state: 'out' }, now);
  check('just sold out: the kurti, with both counts still given for the tabs', onlyOut.rows.length === 1 && onlyOut.counts.low === 3 && onlyOut.counts.out === 1, onlyOut.counts);
  check('just Branch: the fabric only', (await runningLowPage(C, { locationId: B.id }, now)).rows.map(x => x.sku).join() === `P2-${S}`);
  check('by name: Bridal lehenga first', (await runningLowPage(C, { sort: 'name' }, now)).rows[0].title === 'Bridal lehenga');
  check('a wrong tab or sort is refused in words', await refused(runningLowPage(C, { state: 'some' }, now), 400, /low stock, out of stock/) === 'ok' && await refused(runningLowPage(C, { sort: 'colour' }, now), 400, /Sort by/) === 'ok');
  check('another shop\'s store is "not found"', await refused(runningLowPage(C, { locationId: otherStore.id }, now), 404, /could not be found/) === 'ok');
  await prisma.inventoryStock.updateMany({ where: { variantId: P1.v.id, locationId: B.id }, data: { reservedQty: 20 } });
  check('with everything at Branch held for orders, the saree is ordered, not moved', (await runningLowPage(C, { locationId: A.id }, now)).rows.find(x => x.sku === `P1-${S}`)?.next.kind === 'ORDER');
  await prisma.inventoryStock.updateMany({ where: { variantId: P8.v.id }, data: { quantity: 50 } });
  await prisma.productVariant.update({ where: { id: P8.v.id }, data: { reorderLevel: 3 } });
  await stock(P8.v, A, 1);
  const fromOld = (await runningLowPage(C, { locationId: A.id }, now)).rows.find(x => x.sku === `P8-${S}`);
  check('a switched-off store is never suggested to move from', !!fromOld && fromOld.next.kind !== 'MOVE', fromOld?.next);

  console.log('\nWHO MAY ASK (the routes)');
  const demo = JSON.parse(fs.readFileSync(new URL('../../../PLAN-help/robot/demo-localcopy.json', import.meta.url), 'utf8'));
  const as = (who: string, path: string) => axios.get(`${BASE}/analytics/${path}`, { headers: { Authorization: `Bearer ${demo.people[who].token}`, Origin: 'http://localhost:5183' }, validateStatus: () => true, timeout: 90_000 });
  for (const path of ['sales', 'stock-value', 'stock-on-hand', 'running-low']) {
    const [owner, sales, warehouse] = await Promise.all([as('owner', path), as('sales', path), as('warehouse', path)]);
    check(`${path}: the owner gets it, a salesperson and a warehouse hand do not (403)`, owner.status === 200 && sales.status === 403 && warehouse.status === 403, [owner.status, sales.status, warehouse.status]);
  }
  const badDates = await as('owner', 'sales?period=custom&from=2026-05-02&to=2026-05-01');
  check('a wrong date over the wire is a 400 in words', badDates.status === 400 && /on or before the end date/.test(badDates.data?.message ?? ''), badDates.data);
  const otherOver = await as('owner', `running-low?locationId=${otherStore.id}`);
  check('another shop\'s store over the wire is a 404', otherOver.status === 404, otherOver.status);
}

async function cleanup() {
  const ids = [C, OTHER];
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM sales_order_items WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 6; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up (${await prisma.product.count({ where: { clientId: { in: ids } } })} products left)`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
