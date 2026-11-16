/**
 * Every kind of shop, end to end (16 Nov 2026). LOCAL database and LOCAL server only. Four throwaway shops, each set
 * up the way onboarding does, then a day through every module that touches it, with the answer each SHOULD give:
 *
 *   A  ACCESSORIES, GST registered, with CRM -- bangles (HSN 7117, 3%) and a handbag (4202, 18%), no clothing sizes.
 *      The clothing slab (5% to Rs 2,500, 18% above) must never touch them: a Rs 3,500 bag stays 18%, bangles stay 3%.
 *   B  ACCESSORIES, no GST, no CRM -- the same bag sells with no tax and nothing reaches CRM.
 *   C  FABRICS only -- cloth by the metre: the online shop sells 2.50 m, an updated till sells 1.50 m, an old till is
 *      refused in words.
 *   D  BOTH -- a saree and a fabric: an old till sells the saree and is refused the cloth; an updated till sells both.
 *
 * Add product and Store setup go through the real routes; the till through /pos/v1 with a real key and the real queue
 * worker; the shopper through the public /shop routes; CRM through a signed CRM pass. Everything is removed at the end.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 CRM_KEY_DIR=<dir> \
 *   npx tsx src/scripts/verify-shop-kinds.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { seedCatalogDefaultsForClient } from '../services/catalog-seed.service';
import { posConnectionService } from '../services/pos/pos-connection.service';
import { tick } from '../services/pos/pos-queue.service';
import { dayBookService } from '../services/daybook.service';
import { platformAdminService } from '../services/platform-admin.service';
import { storedPrice } from '../lib/units';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: not a local server.'); process.exit(2); }
const ORIGIN = BASE.replace(/\/api\/v1\/?$/, '');
const CRM_KEY = process.env.CRM_KEY_DIR ? fs.readFileSync(path.join(process.env.CRM_KEY_DIR, 'private.pem'), 'utf8') : null;
const STAMP = Date.now().toString(36);
const made: string[] = [];
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`); }
};
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.02;

type Sells = 'READY_MADE' | 'FABRICS' | 'BOTH';
async function openShop(id: string, opts: { sells: Sells; gst: boolean; name: string }) {
  made.push(id);
  const roles = await seedRolesForClient(id);
  await seedCatalogDefaultsForClient(id);
  await prisma.clientSettings.create({ data: { clientId: id, businessName: opts.name, ...(opts.gst ? { gstRegistration: 'REGULAR', gstNumber: '36AABCU9603R1ZX', gstStateCode: '36' } : {}) } as any });
  const store = await prisma.stockLocation.create({ data: { clientId: id, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE' as any, active: true } });
  const owner = await prisma.user.create({ data: { clientId: id, email: `${id}@example.com`, name: `${opts.name} owner`, password: 'unused', status: 'ACTIVE' as any } });
  await prisma.userRole.create({ data: { userId: owner.id, roleId: roles.SUPER_ADMIN } });
  const token = AuthService.generateToken({ userId: owner.id, clientId: id });
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'http://localhost:5183' }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await res.json().catch(() => ({}));
    return { status: res.status, data: j?.data, message: j?.message ?? '' };
  };
  const setup = await api('PUT', '/setup', { sells: opts.sells, finish: true });
  check(`${opts.name}: Store setup "${opts.sells}" saved`, setup.status === 200, setup);

  /** Add product as the screen does: the product, then its colours with opening stock at the Main Store. */
  const addProduct = async (body: Record<string, unknown>, variants: Record<string, unknown>[]) => {
    const p = await api('POST', '/products', { status: 'ACTIVE', ...body });
    const v = await api('POST', `/products/${p.data?.id}/variants/bulk`, { variants, locationId: store.id });
    const rows = await prisma.productVariant.findMany({ where: { clientId: id, productId: p.data?.id }, orderBy: { createdAt: 'asc' } });
    return { ok: p.status === 201 && v.status < 300 && rows.length === variants.length, product: p.data, variants: rows, why: [p.status, p.message, v.status, v.message, v.data?.errors] };
  };

  const { key } = await posConnectionService.create(id, { locationId: store.id, name: 'Counter 1' } as any) as any;
  const till = (units: boolean) => async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${BASE}/pos/v1${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Storefront-Key': key, ...(units ? { 'X-Pos-Units': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return (await res.json().catch(() => ({}))) as any;
  };
  const bill = async (units: boolean, n: string, lines: any[], customer?: any) => {
    const t = till(units);
    const invoiceNo = `INV/${id}/${n}`;
    const total = lines.reduce((a, l) => a + l.lineTotalPaise, 0);
    const first = await t('POST', '/events', { kind: 'sale.completed', invoiceNo, occurredAt: new Date().toISOString(), lines, totals: { roundOffPaise: 0 }, payments: [{ method: 'CASH', amountPaise: total }], ...(customer ? { customer } : {}) });
    if (first?.data?.answer !== 'ACCEPTED') return first?.data ?? first;
    for (const until = Date.now() + 120_000; Date.now() < until;) {
      const d = (await t('GET', `/events/status?invoiceNo=${encodeURIComponent(invoiceNo)}`))?.data;
      if (d && (d.status === 'APPLIED' || d.status === 'REJECTED')) return d;
      await tick([id]).catch(() => undefined);
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`${invoiceNo} never settled`);
  };

  const slug = `${id}`.slice(0, 40);
  await prisma.onlineShop.create({ data: { clientId: id, slug, isLive: true, acceptsOrders: true, payOnDelivery: true, locationIds: [store.id] } as any });
  const shopper = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${ORIGIN}/shop/${slug}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const order = async (lines: { variantCode: string; quantity: number }[], phone: string) => shopper('POST', '/orders', {
    name: 'Lakshmi Devi', phone, address: '3-6-218 Flat 402, Himayatnagar, Hyderabad, Telangana', pincode: '500029',
    payWay: 'ON_DELIVERY', placementKey: `${id}-${phone}-${Date.now()}-placement-key-xx`, lines
  });

  const crmOn = async () => {
    if (!CRM_KEY) return 0;
    const pass = jwt.sign({ sub: 'scaleezy-crm-test', scope: ['modules:crm'] }, CRM_KEY, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' });
    const res = await fetch(`${BASE}/internal/modules/crm/shops/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${pass}`, 'Content-Type': 'application/json' }, body: '{}' });
    return res.status;
  };
  const crmEvents = async () => (await prisma.moduleEvent.findMany({ where: { clientId: id }, select: { kind: true } })).map(e => e.kind);

  return { id, store, api, addProduct, till, bill, shopper, order, crmOn, crmEvents };
}

const lineFor = (v: any, qty: number, unitPaise: number) => ({ itemCode: v.variantCode, qty, unitPricePaise: unitPaise, lineTotalPaise: qty * unitPaise });
const orderOf = (clientId: string, externalOrderId: string) => prisma.salesOrder.findFirst({
  where: { clientId, externalOrderId }, select: { total: true, taxAmount: true, items: { select: { quantity: true, taxRateBps: true, hsnCode: true, totalPrice: true } } }
});

async function shopA() {
  console.log('\nA. ACCESSORIES SHOP, GST REGISTERED, WITH CRM');
  const s = await openShop(`kinds-acc-${STAMP}`, { sells: 'READY_MADE', gst: true, name: 'Glass Bangle House' });
  check('CRM switched on for the shop', (await s.crmOn()) === 200 || !CRM_KEY, CRM_KEY ? '' : 'no CRM_KEY_DIR');
  const bangles = await s.addProduct({ title: 'Glass bangles, set of 12', category: 'UNISEX', productType: 'READY_TO_WEAR', basePrice: 1200, hsnCode: '7117', taxRateBps: 300 },
    [{ sku: `BNG-${STAMP}-G`, colorName: 'Gold', sellingPrice: 1200, quantity: 20 }, { sku: `BNG-${STAMP}-S`, colorName: 'Silver', sellingPrice: 1200, quantity: 15 }]);
  const bag = await s.addProduct({ title: 'Leather handbag', category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 3500, hsnCode: '4202', taxRateBps: 1800 },
    [{ sku: `BAG-${STAMP}-T`, colorName: 'Tan', sellingPrice: 3500, quantity: 6 }]);
  check('bangles in two colours and a handbag, added with NO size (an accessory has none)', bangles.ok && bag.ok && [...bangles.variants, ...bag.variants].every(v => v.size == null), [bangles.why, bag.why]);
  check('...their stock is in: Gold 20, Silver 15, bag 6', (await prisma.inventoryStock.findMany({ where: { clientId: s.id } })).map(x => x.quantity).sort((a, b) => a - b).join() === '6,15,20');
  check('the clothing slab is off for both (taxSlabbed false by default)', bangles.product?.taxSlabbed === false && bag.product?.taxSlabbed === false, [bangles.product?.taxSlabbed, bag.product?.taxSlabbed]);

  const cat = (await s.till(false)('GET', '/catalogue?limit=50'))?.data;
  const vs = (cat?.products ?? []).flatMap((p: any) => p.variants.map((v: any) => [p.title, v.taxRateBps, v.hsn, v.taxSlabbed]));
  check('the till sees both, bangles 3% (7117) and the bag 18% (4202), no slab warning', JSON.stringify(vs.map((x: any) => x.slice(1)).sort()) === JSON.stringify([[1800, '4202', false], [300, '7117', false], [300, '7117', false]].sort()), vs);
  check('...and the shop is GST registered (REGULAR, state 36)', cat?.gst?.registration === 'REGULAR' && cat?.gst?.stateCode === '36', cat?.gst);

  const G = bangles.variants[0], T = bag.variants[0];
  const sale = await s.bill(false, '1', [lineFor(G, 2, 120000), lineFor(T, 1, 350000)], { name: 'Ravi', phone: '9876501234' });
  check('till bill: 2 sets of bangles (Rs 2,400) + the bag (Rs 3,500) = Rs 5,900, APPLIED', sale?.answer === 'APPLIED', sale);
  const o = await orderOf(s.id, `INV/${s.id}/1`);
  const rates = (o?.items ?? []).map(i => i.taxRateBps).sort((a, b) => Number(a) - Number(b));
  check('each line keeps its own rate: bangles 3%, bag 18% (the Rs 3,500 bag is NOT moved by the clothing slab)', JSON.stringify(rates) === '[300,1800]', o?.items);
  // Prices include tax: 2400 x 3/103 = 69.90 and 3500 x 18/118 = 533.90, total 603.80.
  check('tax on the bill: Rs 69.90 + Rs 533.90 = Rs 603.80', near(o?.taxAmount, 603.8) && near(o?.total, 5900), { tax: o?.taxAmount, total: o?.total });

  const list = await s.shopper('GET', '/products');
  const names = (list.body?.data?.products ?? list.body?.data ?? []).map((p: any) => p.title).sort();
  check('the online shop lists both accessories', JSON.stringify(names) === JSON.stringify(['Glass bangles, set of 12', 'Leather handbag']), list.body);
  const placed = await s.order([{ variantCode: T.variantCode, quantity: 1 }], '9989000111');
  check('a shopper orders the bag, cash on delivery: an SO number, Rs 3,500', placed.status === 200 && /^SO-/.test(placed.body?.data?.orderNumber ?? '') && near(placed.body?.data?.total, 3500), placed.body);
  const online = await prisma.salesOrder.findFirst({ where: { clientId: s.id, orderNumber: placed.body?.data?.orderNumber }, select: { items: { select: { taxRateBps: true } } } });
  check('...the online line is 18% too', online?.items?.[0]?.taxRateBps === 1800, online?.items);

  if (CRM_KEY) {
    for (let i = 0; i < 20 && !(await s.crmEvents()).includes('sale.created'); i++) await new Promise(r => setTimeout(r, 500));
    const ev = await s.crmEvents();
    check('CRM gets the sales and the customers (sale.created, customer.created)', ev.includes('sale.created') && ev.includes('customer.created'), [...new Set(ev)]);
  }
  const day: any = await dayBookService.getToday(s.id);
  check('Day Book: the till\'s Rs 5,900 (the online order counts once it is sent)', near(day?.sales?.revenue, 5900), day?.sales);
}

async function shopB() {
  console.log('\nB. ACCESSORIES SHOP, NO GST, NO CRM');
  const s = await openShop(`kinds-acc2-${STAMP}`, { sells: 'READY_MADE', gst: false, name: 'Small Bag Shop' });
  const bag = await s.addProduct({ title: 'Cotton tote', category: 'UNISEX', productType: 'READY_TO_WEAR', basePrice: 499 }, [{ sku: `TOTE-${STAMP}`, colorName: 'Blue', sellingPrice: 499, quantity: 10 }]);
  check('a tote with no HSN and no rate is accepted (GST is off for this shop)', bag.ok, bag.why);
  const cat = (await s.till(false)('GET', '/catalogue?limit=50'))?.data;
  check('the till sees a shop that charges no GST', cat?.gst?.registration !== 'REGULAR', cat?.gst);
  const sale = await s.bill(false, '1', [lineFor(bag.variants[0], 3, 49900)]);
  const o = await orderOf(s.id, `INV/${s.id}/1`);
  check('3 totes = Rs 1,497 with no tax at all', sale?.answer === 'APPLIED' && near(o?.total, 1497) && near(o?.taxAmount ?? 0, 0), [sale, o]);
  check('no CRM, so nothing is written for CRM', (await s.crmEvents()).length === 0, await s.crmEvents());
}

async function shopC() {
  console.log('\nC. FABRICS-ONLY SHOP');
  const s = await openShop(`kinds-fab-${STAMP}`, { sells: 'FABRICS', gst: true, name: 'Ikat Cloth Store' });
  const cloth = await s.addProduct({ title: 'Pochampally ikat cotton', category: 'WOMEN', productType: 'UNSTITCHED', soldBy: 'METRE', kind: 'FABRIC', widthCm: 112, basePrice: storedPrice(380, 'METRE'), hsnCode: '5208', taxRateBps: 500 },
    [{ sku: `IKT-${STAMP}`, colorName: 'Indigo', sellingPrice: storedPrice(380, 'METRE'), quantity: 4000 }]);
  check('cloth sold by the metre, 40 m in stock (4000 cm)', cloth.ok && cloth.product?.soldBy === 'METRE' && (await prisma.inventoryStock.findFirst({ where: { clientId: s.id } }))?.quantity === 4000, cloth.why);
  const V = cloth.variants[0];
  const placed = await s.order([{ variantCode: V.variantCode, quantity: 250 }], '9989000222');
  check('the online shop sells 2.50 m (Rs 950), cash on delivery', placed.status === 200 && near(placed.body?.data?.total, 950), placed.body);
  const old = await s.bill(false, '1', [lineFor(V, 150, 380)]);
  check('an old till is refused the cloth, in words', old?.answer === 'UNKNOWN_ITEM' && /Update the till/.test(old.detail), old);
  const neu = await s.bill(true, '2', [lineFor(V, 150, 380)]);
  check('an updated till sells 1.50 m (150 cm x 380 paise = Rs 570)', neu?.answer === 'APPLIED', neu);
  const o = await orderOf(s.id, `INV/${s.id}/2`);
  check('...5% GST inside Rs 570 = Rs 27.14', near(o?.taxAmount, 27.14) && o?.items?.[0]?.taxRateBps === 500, o);
  const free = (await prisma.inventoryStock.findFirst({ where: { clientId: s.id } })) as any;
  check('stock: 40 m - 1.50 m sold at the till = 38.50 m, 2.50 m held for the online order', free?.quantity === 3850 && free?.reservedQty === 250, { q: free?.quantity, held: free?.reservedQty });
}

async function shopD() {
  console.log('\nD. SHOP SELLING BOTH');
  const s = await openShop(`kinds-both-${STAMP}`, { sells: 'BOTH', gst: false, name: 'Saree and Silk' });
  const saree = await s.addProduct({ title: 'Kanchi pattu saree', category: 'WOMEN', productType: 'READY_TO_WEAR', dressType: 'Saree', basePrice: 8500 }, [{ sku: `KPS-${STAMP}`, colorName: 'Maroon', size: 'Free', sellingPrice: 8500, quantity: 3 }]);
  const silk = await s.addProduct({ title: 'Raw silk', category: 'WOMEN', productType: 'UNSTITCHED', soldBy: 'METRE', kind: 'FABRIC', basePrice: storedPrice(650, 'METRE') }, [{ sku: `RAW-${STAMP}`, colorName: 'Gold', sellingPrice: storedPrice(650, 'METRE'), quantity: 1500 }]);
  check('a saree and a metre fabric in one shop', saree.ok && silk.ok, [saree.why, silk.why]);
  const S = saree.variants[0], R = silk.variants[0];
  const oldCat = (await s.till(false)('GET', '/catalogue?limit=50'))?.data;
  check('an old till sees the saree only', JSON.stringify((oldCat?.products ?? []).map((p: any) => p.title)) === '["Kanchi pattu saree"]', oldCat?.products?.map((p: any) => p.title));
  const mixedOld = await s.bill(false, '1', [lineFor(S, 1, 850000), lineFor(R, 200, 650)]);
  check('an old till with saree + cloth on one bill: the whole bill is refused (nothing half-sold)', mixedOld?.answer === 'UNKNOWN_ITEM' && (await prisma.inventoryStock.findFirst({ where: { clientId: s.id, variantId: S.id } }))?.quantity === 3, mixedOld);
  const mixedNew = await s.bill(true, '2', [lineFor(S, 1, 850000), lineFor(R, 200, 650)]);
  check('an updated till sells both: saree Rs 8,500 + 2 m silk Rs 1,300', mixedNew?.answer === 'APPLIED', mixedNew);
  const o = await orderOf(s.id, `INV/${s.id}/2`);
  check('...one order, Rs 9,800, the cloth line 200 cm', near(o?.total, 9800) && o?.items?.some(i => i.quantity === 200), o);
  const day: any = await dayBookService.getToday(s.id);
  check('Day Book Rs 9,800', near(day?.sales?.revenue, 9800), day?.sales);
}

async function main() {
  for (const run of [shopA, shopB, shopC, shopD]) {
    try { await run(); } catch (e: any) { failed++; console.log(`  FAIL ${run.name} crashed -- ${e?.stack?.split('\n').slice(0, 3).join(' | ')}`); }
  }
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    for (const id of made) await platformAdminService.deleteClientCompletely(id, id).catch(e => console.error(`cleanup ${id}:`, e?.message));
    console.log(`\n${passed} passed, ${failed} problems`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
