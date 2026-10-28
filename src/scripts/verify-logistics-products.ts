/**
 * SKU lookup for ScaleEzy Logistics (28 Oct), over real HTTP against the local server (4016) with a
 * real signed service token (issuer scaleezy-logistics-test, trusted in launch config backend-localdb).
 *
 *   1. Who may ask: no token, the wrong scope, a shop that has not switched Logistics on, a token made
 *      for another shop -- each refused with its own answer.
 *   2. One SKU: every field exactly -- the FINAL price (GST added for a price entered without it, never
 *      for a shop that charges no GST), MRP the same way, the shop's own rate and HSN, null (not 0)
 *      for weight/size and for a rate a registered shop has not set, stock on hand less held, per store
 *      and for one store, active or not.
 *   3. Matching: exact; another letter case only when exactly one SKU fits; never another shop's SKU.
 *   4. Many: order kept, duplicates once, not_found, the 50 cap. Search: by title/SKU/colour, active
 *      only, short or wildcard queries harmless.
 *   5. The change feed: a shop on Logistics sends Logistics NOTHING of its general changes, while CRM
 *      still gets them (migration 20261028230000).
 *
 * LOCAL DATABASE ONLY. Removes everything it made.
 *   DATABASE_URL=postgresql://postgres:localpw@localhost:55433/inventory DIRECT_URL=<same> npx tsx src/scripts/verify-logistics-products.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const API = 'http://localhost:4016/api/v1/internal';
const KEY = fs.readFileSync('C:/Users/HP/AppData/Local/Temp/claude/D--villy-inventory/00d435a0-68b0-4933-9758-bcc19e3e6522/scratchpad/test-logistics-keys/private.pem');
const STAMP = Date.now();
const C = `logi-a-${STAMP}`;   // registered for GST, Logistics switched on
const D = `logi-b-${STAMP}`;   // charges no GST

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const token = (claims: Record<string, unknown> = {}, scope = ['modules:logistics']) =>
  jwt.sign({ sub: 'logistics-test', scope, ...claims }, KEY, { algorithm: 'RS256', keyid: 'test-1', issuer: 'scaleezy-logistics-test', audience: 'inventory', expiresIn: 300 });
const ask = (path: string, opts: { tok?: string | null; method?: string } = {}) =>
  fetch(`${API}${path}`, { method: opts.method ?? 'GET', headers: opts.tok === null ? {} : { authorization: `Bearer ${opts.tok ?? token()}` } })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));

(async () => {
  let n = 0;
  try {
    // ── the shops and their products ──
    for (const [clientId, gst] of [[C, true], [D, false]] as const) {
      await prisma.clientSettings.upsert({ where: { clientId }, create: { clientId, ...(gst ? { gstRegistration: 'REGULAR', gstNumber: '36ABCDE1234F1Z5' } : {}) } as any, update: {} });
    }
    const store = (clientId: string, name: string) => prisma.stockLocation.create({ data: { clientId, name, code: `L${++n}${STAMP}`, type: 'STORE', active: true } as any });
    const product = (clientId: string, title: string, extra: any = {}) => prisma.product.create({ data: { clientId, productCode: `LP${STAMP}-${++n}`, slug: `lp${STAMP}-${n}`, title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any, ...extra } });
    const variant = (clientId: string, productId: string, sku: string, extra: any = {}) => prisma.productVariant.create({ data: { productId, clientId, sku, variantCode: `LV${STAMP}-${++n}`, ...extra } });
    const stock = (variantId: string, locationId: string, quantity: number, reservedQty = 0) => prisma.inventoryStock.create({ data: { clientId: C, variantId, locationId, quantity, reservedQty } as any });

    const main = await store(C, 'Main Store'), godown = await store(C, 'Godown');
    const saree = await product(C, 'Silk Saree', { hsnCode: '5007', taxRateBps: 500, description: 'Pure silk, zari border' });
    const sar = await variant(C, saree.id, `SAR-MAR-${STAMP}`, { colorName: 'Maroon', size: 'Free', sellingPrice: 2499, compareAtPrice: 2999 });
    await prisma.productImage.create({ data: { productId: saree.id, variantId: sar.id, url: 'https://cdn.example/sar-mar.jpg', isPrimary: true, imageType: 'GALLERY' as any } as any });
    await stock(sar.id, main.id, 5, 2);
    await stock(sar.id, godown.id, 4);
    const kurti = await product(C, 'Stitched Kurti', { dressType: 'Kurti', priceIsExclusive: true, taxRateBps: 1200, hsnCode: '6204' });
    const kur = await variant(C, kurti.id, `KUR-IND-M-${STAMP}`, { colorName: 'Indigo', size: 'M' });   // no own price: the product's ₹1,000 + 12%
    const noRate = await product(C, 'Cotton Dupatta', { dressType: 'Dupatta' });
    const dup = await variant(C, noRate.id, `DUP-${STAMP}`, { sellingPrice: 500 });
    const old = await product(C, 'Old Lehenga', { status: 'ARCHIVED' });
    const oldV = await variant(C, old.id, `OLD-${STAMP}`, { sellingPrice: 9000 });
    const caseA = await variant(C, noRate.id, `ab-${STAMP}`);
    const caseB = await variant(C, noRate.id, `AB-${STAMP}`);
    const dKurti = await product(D, 'Stitched Kurti', { priceIsExclusive: true, taxRateBps: 1200 });
    const dKur = await variant(D, dKurti.id, `KUR-IND-M-${STAMP}`, { sellingPrice: 1000 });   // same SKU, other shop
    void caseA; void caseB; void oldV; void dup; void dKur;

    console.log('\n1. WHO MAY ASK');
    let r = await ask(`/modules/logistics/shops/${C}/products/${sar.sku}`, { tok: null });
    eq('no token: 401', r.status, 401);
    r = await ask(`/modules/logistics/shops/${C}/products/${sar.sku}`, { tok: token({}, ['modules:crm']) });
    eq('a token without modules:logistics: 403', r.status, 403);
    r = await ask(`/modules/logistics/shops/${C}/products/${sar.sku}`);
    eq('a shop that has not switched Logistics on: 404 with the reason', [r.status, r.body?.message], [404, 'This shop has not switched Logistics on.']);
    r = await ask(`/modules/logistics/shops/${C}`, { method: 'PUT' });
    eq('Logistics switches the shop on (the same route CRM uses): 200', r.status, 200);
    r = await ask(`/modules/logistics/shops/${C}/products/${sar.sku}`, { tok: token({ clientId: D }) });
    eq('a token made for another shop: 403', [r.status, r.body?.message], [403, 'This token is for another shop.']);

    console.log('\n2. ONE SKU, EVERY FIELD');
    r = await ask(`/modules/logistics/shops/${C}/products/${sar.sku}`);
    const p = r.body?.data;
    eq('200', r.status, 200);
    eq('identity and price (entered with GST: as it is)', [p?.sku, p?.name, p?.selling_price, p?.mrp, p?.discount], [sar.sku, 'Silk Saree - Maroon', 2499, 2999, 0]);
    eq('the shop\'s own GST rate and HSN', [p?.tax_rate, p?.hsn_code], [5, '5007']);
    eq('weight and size: null, never 0', [p?.weight_kg, p?.length_cm, p?.breadth_cm, p?.height_cm], [null, null, null, null]);
    eq('stock: on hand less held, all stores (5-2 + 4)', p?.stock_quantity, 7);
    eq('stock per store', (p?.stock_by_location ?? []).map((s: any) => [s.name, s.available]).sort(), [['Godown', 4], ['Main Store', 3]]);
    eq('the rest', [p?.is_active, p?.variant, p?.image_url, p?.category, p?.description, p?.cod_allowed, typeof p?.updated_at], [true, { size: 'Free', color: 'Maroon' }, 'https://cdn.example/sar-mar.jpg', 'Saree', 'Pure silk, zari border', null, 'string']);
    r = await ask(`/modules/logistics/shops/${C}/products/${sar.sku}?location_id=${main.id}`);
    eq('?location_id: that store only', r.body?.data?.stock_quantity, 3);
    r = await ask(`/modules/logistics/shops/${C}/products/${kur.sku}`);
    eq('entered WITHOUT GST: ₹1,000 + 12% = ₹1,120, named with colour and size', [r.body?.data?.selling_price, r.body?.data?.tax_rate, r.body?.data?.name, r.body?.data?.stock_quantity], [1120, 12, 'Stitched Kurti - Indigo / M', 0]);
    r = await ask(`/modules/logistics/shops/${C}/products/${dup.sku}`);
    eq('a registered shop with no rate set: tax_rate null, HSN null', [r.body?.data?.tax_rate, r.body?.data?.hsn_code], [null, null]);
    r = await ask(`/modules/logistics/shops/${C}/products/${oldV.sku}`);
    eq('an archived product: found, is_active false', [r.status, r.body?.data?.is_active], [200, false]);
    r = await ask(`/modules/logistics/shops/${C}/products/NOPE-${STAMP}`);
    eq('no such SKU: 404 with the sku', [r.status, r.body?.message, r.body?.sku], [404, 'Product not found', `NOPE-${STAMP}`]);

    console.log('\n3. MATCHING');
    r = await ask(`/modules/logistics/shops/${C}/products/${sar.sku.toLowerCase()}`);
    eq('another letter case, one SKU fits: found', [r.status, r.body?.data?.sku], [200, sar.sku]);
    r = await ask(`/modules/logistics/shops/${C}/products/Ab-${STAMP}`);
    eq('another letter case, two SKUs fit: 404, never a guess', r.status, 404);
    r = await ask(`/modules/logistics/shops/${C}/products/ab-${STAMP}`);
    eq('...but the exact one is found', [r.status, r.body?.data?.sku], [200, `ab-${STAMP}`]);
    await ask(`/modules/logistics/shops/${D}`, { method: 'PUT' });
    r = await ask(`/modules/logistics/shops/${D}/products/${kur.sku}`);
    eq('the same SKU in a shop that charges no GST: its own product, price as entered, rate 0', [r.status, r.body?.data?.selling_price, r.body?.data?.tax_rate, r.body?.data?.name], [200, 1000, 0, 'Stitched Kurti']);
    r = await ask(`/modules/logistics/shops/${D}/products/${sar.sku}`);
    eq('another shop\'s SKU is never visible', r.status, 404);

    console.log('\n4. MANY, AND SEARCH');
    r = await ask(`/modules/logistics/shops/${C}/products?skus=${encodeURIComponent(`${kur.sku}, NOPE-${STAMP},${sar.sku},${kur.sku}`)}`);
    eq('order kept, each once, not_found listed', [r.status, r.body?.data?.products?.map((x: any) => x.sku), r.body?.data?.not_found], [200, [kur.sku, sar.sku], [`NOPE-${STAMP}`]]);
    r = await ask(`/modules/logistics/shops/${C}/products?skus=${Array.from({ length: 60 }, (_, i) => `X${i}`).join(',')}`);
    eq('60 asked: the first 50 answered', r.body?.data?.not_found?.length, 50);
    r = await ask(`/modules/logistics/shops/${C}/products`);
    eq('no skus: 400 with how to ask', [r.status, r.body?.message], [400, 'Say which SKUs: ?skus=A,B,C (up to 50).']);
    r = await ask(`/modules/logistics/shops/${C}/products/search?q=silk`);
    eq('search "silk": the saree, short shape', r.body?.data, [{ sku: sar.sku, name: 'Silk Saree - Maroon', selling_price: 2499, image_url: 'https://cdn.example/sar-mar.jpg', variant: { size: 'Free', color: 'Maroon' } }]);
    r = await ask(`/modules/logistics/shops/${C}/products/search?q=indigo`);
    eq('search by colour', r.body?.data?.map((x: any) => x.sku), [kur.sku]);
    r = await ask(`/modules/logistics/shops/${C}/products/search?q=lehenga`);
    eq('search leaves out archived products', r.body?.data, []);
    r = await ask(`/modules/logistics/shops/${C}/products/search?q=s`);
    eq('one letter: nothing (too broad)', r.body?.data, []);
    r = await ask(`/modules/logistics/shops/${C}/products/search?q=${encodeURIComponent('%_')}`);
    eq('"%_" is matched as text, not as "anything"', [r.status, r.body?.data], [200, []]);
    r = await ask(`/modules/logistics/shops/${C}/products/search?q=a&limit=999`);
    check('a huge limit is harmless', r.status === 200, r.status);

    console.log('\n5. THE CHANGE FEED');
    await prisma.moduleSubscription.create({ data: { clientId: C, module: 'crm', enabledBy: 'verify-logistics-products' } });
    const cust = await prisma.customer.create({ data: { clientId: C, customerCode: `LC-${STAMP}`, name: 'Feed Test', phone: null } as any });
    const ev = await prisma.moduleEvent.groupBy({ by: ['module'], where: { clientId: C, rowId: cust.id }, _count: true });
    eq('a new customer in a shop on CRM and Logistics: CRM gets it, Logistics does not', ev.map(e => [e.module, e._count]).sort(), [['crm', 1]]);
  } catch (e: any) {
    console.error(e);
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).trim().split('\n')[0]})`, false);
  } finally {
    for (const clientId of [C, D]) {
      const w = { clientId };
      for (const [what, run] of [
        ['events', () => prisma.moduleEvent.deleteMany({ where: w })],
        ['subscriptions', () => prisma.moduleSubscription.deleteMany({ where: w })],
        ['customers', () => prisma.customer.deleteMany({ where: w })],
        ['stock', () => prisma.inventoryStock.deleteMany({ where: { location: w } })],
        ['images', () => prisma.productImage.deleteMany({ where: { product: w } })],
        ['variants', () => prisma.productVariant.deleteMany({ where: w })],
        ['products', () => prisma.product.deleteMany({ where: w })],
        ['stores', () => prisma.stockLocation.deleteMany({ where: w })],
        ['settings', () => prisma.clientSettings.deleteMany({ where: w })]
      ] as [string, () => Promise<unknown>][]) await run().catch(e => console.log(`left ${what}`, e.message));
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
