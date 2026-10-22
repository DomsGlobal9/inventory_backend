/**
 * The Dashboard's top half (GET /dashboard/overview), on a throwaway shop built here and removed at the
 * end. Known orders and stock go in at known times; every figure must come out exactly as worked out
 * by hand below -- and every part only for a role allowed it.
 *
 *   npx tsx src/scripts/verify-dashboard-overview.ts
 */
import { prisma } from '../lib/prisma';
import { dashboardOverview } from '../services/dashboard-overview';
import { grants, holdsEverything } from '../config/permissions';

const STAMP = Date.now();
const C = `dash-${STAMP}`;
const EMPTY = `dash-empty-${STAMP}`;
const DAY = 86_400_000;
// A fixed "now": 22 Oct 2026, 12:00 UTC = 17:30 in India.
const NOW = new Date('2026-10-22T12:00:00Z');
const OWNER = { roles: ['SUPER_ADMIN'], permissions: ['*'] };
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 500)}` : ''}`); }
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const main = await prisma.stockLocation.create({ data: { clientId: C, name: 'Main', code: `M-${STAMP}`, type: 'STORE' as any, active: true } });
  const branch = await prisma.stockLocation.create({ data: { clientId: C, name: 'Branch', code: `B-${STAMP}`, type: 'STORE' as any, active: true } });
  let n = 0;
  const product = async (title: string, extra: any = {}) => prisma.product.create({ data: { clientId: C, productCode: `P${STAMP}-${++n}`, slug: `p${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any, ...extra } });
  const variant = async (productId: string, colorName: string, reorderLevel: number, costPrice = 100) => prisma.productVariant.create({ data: { productId, clientId: C, colorName, size: 'Free', variantCode: `V${STAMP}-${++n}`, sku: `S${STAMP}-${n}`, sellingPrice: 1000, costPrice, reorderLevel } as any });
  const stock = (variantId: string, quantity: number, locationId = main.id) => prisma.inventoryStock.create({ data: { clientId: C, variantId, locationId, quantity, reservedQty: 0 } });
  const shopper = await prisma.customer.create({ data: { clientId: C, customerCode: `C-${STAMP}`, name: 'Asha', phone: '+919000000201' } });

  // ── Catalogue and stock at Main ─────────────────────────────────────────────────────────────────
  const plenty = await product('Plenty Saree'), vPlenty = await variant(plenty.id, 'Red', 5);          await stock(vPlenty.id, 10);
  const low = await product('Low Saree'), vLow = await variant(low.id, 'Blue', 5);                      await stock(vLow.id, 3);   // 3 of 5: low
  const lower = await product('Lower Saree'), vLower = await variant(lower.id, 'Green', 10);            await stock(vLower.id, 2); // 2 of 10: lowest
  const out = await product('Gone Saree'), vOut = await variant(out.id, 'Pink', 5);                     await stock(vOut.id, 0);   // 0: sold out, not low
  const untracked = await product('Untracked Saree'), vUntr = await variant(untracked.id, 'Gold', 0);    await stock(vUntr.id, 1);  // level 0: not tracked, not low
  const archived = await product('Old Saree', { status: 'ARCHIVED' }), vArch = await variant(archived.id, 'Grey', 5); await stock(vArch.id, 1); // archived: not counted
  await stock(vPlenty.id, 7, branch.id);   // only in the whole-shop view
  await prisma.productImage.createMany({ data: [
    { productId: plenty.id, url: 'https://x.test/second.jpg', isPrimary: false, imageType: 'GALLERY' as any, orderIndex: 0 },
    { productId: plenty.id, url: 'https://x.test/primary.jpg', isPrimary: true, imageType: 'GALLERY' as any, orderIndex: 3 }
  ] as any });

  // ── Orders at known times ───────────────────────────────────────────────────────────────────────
  const order = async (at: Date, channel: string, lines: [any, number, number][], o: { status?: string; deleted?: boolean; loc?: string } = {}) => {
    const total = lines.reduce((t, [, q, p]) => t + q * p, 0);
    return prisma.salesOrder.create({ data: {
      clientId: C, orderNumber: `SO-${STAMP}-${++n}`, customerId: shopper.id, channel: channel as any, locationId: o.loc ?? main.id,
      status: (o.status ?? 'CONFIRMED') as any, subtotal: total, discountAmount: 0, taxAmount: 0, shippingAmount: 0, total,
      createdAt: at, deletedAt: o.deleted ? at : null,
      items: { create: lines.map(([v, q, p]) => ({ variantId: v.id, quantity: q, listUnitPrice: p, unitPrice: p, unitCost: 0, totalPrice: q * p })) }
    } as any });
  };
  const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3600_000);
  // Today in India (22 Oct): 00:30 IST is 21 Oct 19:00 UTC -- still today. 23:30 IST on 21 Oct is yesterday.
  await order(new Date('2026-10-21T19:00:00Z'), 'POS', [[vPlenty, 1, 700]]);            // today, till 700
  await order(new Date('2026-10-22T10:00:00Z'), 'ONLINE', [[vLow, 1, 1300]]);           // today, online 1300
  await order(new Date('2026-10-21T18:00:00Z'), 'POS', [[vPlenty, 1, 400]]);            // 21 Oct 23:30 IST: yesterday, till 400
  await order(ago(10), 'MANUAL', [[vLower, 2, 1000]]);                                    // 12 Oct, counter = till, 2000
  await order(ago(20), 'MARKETPLACE', [[vPlenty, 6, 100]]);                               // 2 Oct, marketplace = online, 600 (6 pieces)
  await order(ago(29, 10), 'ONLINE', [[vLow, 1, 5000]]);                                  // inside 30 days: online 5000
  await order(ago(40), 'POS', [[vPlenty, 1, 3000]]);                                      // 12 Sep: the 30 days before, 3000
  await order(ago(59), 'ONLINE', [[vPlenty, 1, 900]]);                                    // 24 Aug: the 30 days before, 900
  await order(ago(61), 'POS', [[vPlenty, 1, 111]]);                                       // 22 Aug: in neither window (month Aug only)
  await order(ago(2), 'POS', [[vPlenty, 1, 9999]], { status: 'CANCELLED' });            // never sales
  await order(ago(2), 'POS', [[vPlenty, 1, 8888]], { status: 'DRAFT' });                // never sales, never a latest order
  await order(ago(3), 'POS', [[vPlenty, 1, 7777]], { deleted: true });                  // never anything
  await order(ago(1), 'POS', [[vPlenty, 1, 50000]], { loc: branch.id });                // the other store only
  await order(ago(250), 'POS', [[vPlenty, 1, 222]]);                                      // Feb: before the 9 months shown? (Feb..Oct is 9) -> Feb

  console.log('\nA. TODAY, IN INDIA TIME, AT ONE STORE');
  const o: any = await dashboardOverview(C, OWNER, main.id, NOW);
  check('today: 2 orders (00:30 IST counts as today, 23:30 the night before does not), worth 2,000', eq(o.today, { orders: 2, total: 2000 }), o.today);

  console.log('\nB. THE LAST 30 DAYS AGAINST THE 30 BEFORE');
  // last 30: 700 + 1300 + 400 + 2000 + 600 + 5000 = 10,000 in 6 orders; before: 3000 + 900 = 3,900.
  check('last 30 days 10,000 in 6 orders; the 30 before 3,900 (cancelled, draft, deleted, the other store all left out)', o.sales.last30 === 10000 && o.sales.orders30 === 6 && o.sales.prev30 === 3900, { last30: o.sales.last30, orders30: o.sales.orders30, prev30: o.sales.prev30 });

  console.log('\nC. DAY BY DAY');
  const day = (k: string) => o.sales.daily.find((d: any) => d.day === k);
  check('30 days, 23 Sep to 22 Oct (India dates)', o.sales.daily.length === 30 && o.sales.daily[0].day === '2026-09-23' && o.sales.daily[29].day === '2026-10-22', [o.sales.daily[0]?.day, o.sales.daily[29]?.day]);
  check('22 Oct: till 700, online 1,300', eq(day('2026-10-22'), { day: '2026-10-22', till: 700, online: 1300 }), day('2026-10-22'));
  check('21 Oct: the 23:30 sale, till 400', eq(day('2026-10-21'), { day: '2026-10-21', till: 400, online: 0 }), day('2026-10-21'));
  check('12 Oct: the counter sale counts as till, 2,000', day('2026-10-12')?.till === 2000 && day('2026-10-12')?.online === 0, day('2026-10-12'));
  check('2 Oct: the marketplace sale counts as online, 600', day('2026-10-02')?.online === 600, day('2026-10-02'));
  check('a quiet day is there as 0, not missing', eq(day('2026-10-15'), { day: '2026-10-15', till: 0, online: 0 }));
  check('the days add up to the 30-day figure', o.sales.daily.reduce((t: number, d: any) => t + d.till + d.online, 0) === 10000);

  console.log('\nD. MONTH BY MONTH');
  const m = (k: string) => o.sales.monthly.find((x: any) => x.month === k);
  check('nine months, Feb to Oct 2026', o.sales.monthly.length === 9 && o.sales.monthly[0].month === '2026-02' && o.sales.monthly[8].month === '2026-10', o.sales.monthly.map((x: any) => x.month));
  check('Oct: till 3,100 (700+400+2000), online 1,900 (1300+600), 5 orders', eq(m('2026-10'), { month: '2026-10', till: 3100, online: 1900, orders: 5 }), m('2026-10'));
  check('Sep: till 3,000, online 5,000, 2 orders', eq(m('2026-09'), { month: '2026-09', till: 3000, online: 5000, orders: 2 }), m('2026-09'));
  check('Aug: till 111, online 900', m('2026-08')?.till === 111 && m('2026-08')?.online === 900, m('2026-08'));
  check('Feb: the old sale, 222', m('2026-02')?.till === 222, m('2026-02'));

  console.log('\nE. STOCK AND RUNNING LOW');
  // Main: plenty 10 + low 3 + lower 2 + out 0 + untracked 1 + archived 1 = 17 pieces in 6 colours. The archived
  // product's piece is still stock (and in the value), but it is not "running low": it is not on sale.
  check('17 pieces in 6 colours (archived stock counted, as in the value); 2 low (5 pieces), 1 sold out', o.stock.units === 17 && o.stock.colours === 6 && o.stock.low === 2 && o.stock.lowPieces === 5 && o.stock.out === 1, o.stock);
  check('the archived product is never in the running-low list (1 of 5 left, but not on sale)', !o.stock.lowest.some((l: any) => /Old Saree/.test(l.title)));
  check('sold out is not low, and a colour with no reorder level is never low', !o.stock.lowest.some((l: any) => /Gone|Untracked/.test(l.title)));
  check('lowest first: Lower (2 of 10) before Low (3 of 5)', eq(o.stock.lowest.map((l: any) => [l.title, l.left, l.level]), [['Lower Saree', 2, 10], ['Low Saree', 3, 5]]), o.stock.lowest);
  check('stock value for the owner, at cost, on the same pieces: 17 × ₹100 = 1,700', o.stock.value === 1700, o.stock.value);
  const all: any = await dashboardOverview(C, OWNER, undefined, NOW);
  check('the whole shop adds the other store: 24 pieces, and its sale: today and last-30 unchanged except the 50,000', all.stock.units === 24 && all.sales.last30 === 60000, { units: all.stock.units, last30: all.sales.last30 });

  console.log('\nF. TOP SELLERS');
  // Last 30 days at Main: Low 6300 (2 pcs), Lower 2000 (2 pcs), Plenty 1700 (8 pcs).
  check('by sales value: Low, Lower, Plenty', eq(o.topSellers.map((t: any) => [t.title, t.revenue, t.pieces]), [['Low Saree', 6300, 2], ['Lower Saree', 2000, 2], ['Plenty Saree', 1700, 8]]), o.topSellers);
  check('the primary photo, not the first in order', o.topSellers.find((t: any) => t.title === 'Plenty Saree')?.photo === 'https://x.test/primary.jpg');
  const pieces: any = await dashboardOverview(C, { permissions: ['dashboard:view', 'report:view'] }, main.id, NOW);
  check('without money: by pieces sold (Plenty first), and no revenue at all', pieces.topSellers[0].title === 'Plenty Saree' && pieces.topSellers.every((t: any) => t.revenue === null), pieces.topSellers);

  console.log('\nG. LATEST ORDERS');
  const nums = o.latestOrders.map((x: any) => x.total);
  // Newest at Main: 22 Oct online 1300, 22 Oct 00:30 IST 700, 21 Oct 23:30 IST 400, 20 Oct cancelled 9999, 12 Oct 2000.
  check('the 5 newest at this store: 1300, 700, 400, 9999 (cancelled), 2000 -- no draft, no deleted, not the other store', eq(nums, [1300, 700, 400, 9999, 2000]), nums);
  check('newest first by time', o.latestOrders.every((x: any, i: number, a: any[]) => !i || new Date(a[i - 1].at) >= new Date(x.at)));
  check('a cancelled order still shows (with its state), so the owner sees what happened', o.latestOrders.some((x: any) => x.status === 'CANCELLED' && x.total === 9999));

  console.log('\nH. WHO SEES WHAT (decided on the server)');
  const as = (permissions: string[]) => dashboardOverview(C, { permissions }, main.id, NOW) as Promise<any>;
  const none = await as(['dashboard:view']);
  check('dashboard only: today\'s count and nothing else -- no money, stock, sellers or orders', none.today.orders === 2 && none.today.total === null && none.sales === null && none.stock === null && none.topSellers === null && none.latestOrders === null, none);
  const fin = await as(['dashboard:view', 'report:financial']);
  check('money allowed: today\'s total, sales, top sellers by value; but no stock or orders', fin.today.total === 2000 && fin.sales && fin.topSellers?.[0]?.revenue != null && fin.stock === null && fin.latestOrders === null);
  const inv = await as(['dashboard:view', 'inventory:view']);
  check('stock allowed, money not: stock without its value; no sales', inv.stock && inv.stock.value === null && inv.stock.units === 17 && inv.sales === null && inv.today.total === null);
  const ord = await as(['dashboard:view', 'sales_order:view']);
  check('orders allowed: latest orders with totals; nothing else', ord.latestOrders?.length === 5 && ord.latestOrders[0].total != null && ord.sales === null && ord.stock === null && ord.topSellers === null);
  const json = JSON.stringify(none) + JSON.stringify(inv);
  check('no money figure anywhere in the answer for those without it (no 10000, 1700, 6300)', !/\b(10000|1700|6300)\b/.test(json) && !/"total":2000/.test(json));

  // The shop's real roles, as seeded: what each is sent.
  for (const role of ['ADMIN', 'INVENTORY_MANAGER', 'WAREHOUSE', 'SALES']) {
    const r = await prisma.role.findFirst({ where: { clientId: 'sphl', name: role }, select: { permissions: { select: { permission: { select: { key: true } } } } } } as any).catch(() => null) as any;
    const perms: string[] = r?.permissions?.map((p: any) => p.permission.key) ?? [];
    if (!perms.length) { check(`role ${role} found with permissions`, false, r); continue; }
    const got: any = await dashboardOverview(C, { permissions: perms, roles: [role] }, main.id, NOW);
    // The app's own rule, implied permissions included (one permission can carry others).
    const has = (k: string) => holdsEverything(perms, [role]) || grants(perms, k);
    check(`${role}: money parts only if it holds report:financial (${has('report:financial')}), stock only with inventory:view (${has('inventory:view')})`,
      (got.sales !== null) === has('report:financial') && (got.today.total !== null) === has('report:financial') && (got.stock !== null) === has('inventory:view')
      && (got.stock === null || (got.stock.value !== null) === has('report:financial')) && (got.latestOrders !== null) === has('sales_order:view'),
      { sales: !!got.sales, stock: !!got.stock, value: got.stock?.value, orders: !!got.latestOrders, perms: perms.filter(p => /report|inventory:view|sales_order:view/.test(p)) });
  }

  console.log('\nI. A BRAND-NEW SHOP');
  const e: any = await dashboardOverview(EMPTY, OWNER, undefined, NOW);
  check('nothing at all: zeros everywhere, 30 empty days, 9 empty months, empty lists -- no error', e.today.orders === 0 && e.sales.last30 === 0 && e.sales.daily.length === 30 && e.sales.daily.every((d: any) => d.till === 0 && d.online === 0) && e.sales.monthly.length === 9 && e.stock.units === 0 && e.stock.low === 0 && e.topSellers.length === 0 && e.latestOrders.length === 0, e);
}

main().catch(e => { failed++; console.error(e); }).finally(async () => {
  const w = { clientId: { in: [C, EMPTY] } };
  await prisma.salesOrderItem.deleteMany({ where: { salesOrder: w } }).catch(e => console.log('left items', e.message));
  await prisma.salesOrder.deleteMany({ where: w }).catch(e => console.log('left orders', e.message));
  await prisma.productImage.deleteMany({ where: { product: w } }).catch(e => console.log('left images', e.message));
  await prisma.inventoryStock.deleteMany({ where: w }).catch(e => console.log('left stock', e.message));
  await prisma.productVariant.deleteMany({ where: w }).catch(e => console.log('left variants', e.message));
  await prisma.product.deleteMany({ where: w }).catch(e => console.log('left products', e.message));
  await prisma.customer.deleteMany({ where: w }).catch(e => console.log('left customers', e.message));
  await prisma.stockLocation.deleteMany({ where: w }).catch(e => console.log('left locations', e.message));
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
});
