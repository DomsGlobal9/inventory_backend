/**
 * "The boutique app runs this whole shop" (24 Nov 2026, Swathy Reddy), against the REAL local server and database.
 *
 * A retail shop like Swathy's (products made in Inventory, stock in its Main Store, an own empty branch) and the
 * boutique app's empty test shop for the same owner. The Console enables the Boutique module with handOver, and then:
 *   - every product is the boutique app's: listed by its SKU as item code, priced by the boutique, editable, sellable,
 *     holdable, with the same stock -- no second copy of anything;
 *   - the boutique test shop's empty "Boutique" place is gone; the shop's own Main Store (with stock) and its own empty
 *     branch are both kept;
 *   - a SKU that is not a valid item code falls back to the variant code, or is reported, never guessed;
 *   - running it again changes nothing; enabling WITHOUT handOver leaves a shop's own products as they were.
 *
 * Throwaway shops only (hotest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-handover.ts
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');
const CONSOLE = execSync('npx tsx src/scripts/print-local-console-token.ts', { env: process.env, encoding: 'utf8' }).match(/eyJ[A-Za-z0-9._-]+/)![0];

const S = Date.now().toString(36);
const SHOP = `hotest-${S}`, OTHER = `hotest-${S}-b`;
const TEN = `hotest-${S}`, TEN2 = `hotest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const ALL = ['products:write', 'stock:write', 'stitching:issue', 'offers:write'];
const pass = (tenant: string) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Swathy', can: ALL } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function btq(method: string, p: string, tenant: string, body?: unknown) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(tenant)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `ho-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
async function consoleApi(method: string, path: string, body?: unknown) {
  const r = await axios.request({ method, url: `${BASE}/admin${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Cookie: `platform_admin_token=${CONSOLE}`, Origin: 'http://localhost:5183' } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}

/** A retail shop as Inventory makes one: a login, a Main Store with stock, an own empty branch, products by SKU. */
async function retailShop(clientId: string, skus: { sku: string; variantCode: string; title: string; price: number; qty: number }[]) {
  await prisma.user.create({ data: { clientId, name: 'Owner', email: `${clientId}@example.invalid`, password: 'x', status: 'ACTIVE' } as any });
  await prisma.clientSettings.create({ data: { clientId, businessName: 'Designer Studio' } as any });
  const main = await prisma.stockLocation.create({ data: { clientId, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true } });
  const branch = await prisma.stockLocation.create({ data: { clientId, code: 'BRANCH-2', name: 'New branch', type: 'STORE', active: true } });
  let i = 0;
  for (const s of skus) {
    i++;
    const p = await prisma.product.create({ data: { clientId, productCode: `PRD-${S}-${i}`, slug: `prd-${S}-${clientId}-${i}`, title: s.title, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: s.price, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true, taxRateBps: 500, taxSlabbed: false, priceIsExclusive: false } as any });
    const v = await prisma.productVariant.create({ data: { clientId, productId: p.id, variantCode: s.variantCode, sku: s.sku, colorName: 'Gold', size: 'Free size', sellingPrice: s.price } as any });
    if (s.qty) await prisma.inventoryStock.create({ data: { clientId, variantId: v.id, locationId: main.id, quantity: s.qty, reservedQty: 0 } as any });
  }
  return { main, branch };
}

async function main() {
  console.log('A RETAIL SHOP LIKE SWATHY\'S, AND THE BOUTIQUE APP\'S EMPTY TEST SHOP');
  const goodSku = `PRD-${S}-GOL-FREESIZE`.toUpperCase();
  const spaced = `BAD SKU ${S}`, spaced2 = `ALSO BAD ${S}`;
  const { main: mainStore, branch } = await retailShop(SHOP, [
    { sku: goodSku, variantCode: `VC-${S}-1`, title: 'Gold kanchi saree', price: 12000, qty: 3 },
    { sku: spaced, variantCode: `VC-${S}-2`, title: 'Blouse, maroon', price: 2500, qty: 5 },
    { sku: spaced2, variantCode: `V C ${S} 3`, title: 'Dupatta', price: 900, qty: 0 }
  ]);
  const before = { products: await prisma.product.count({ where: { clientId: SHOP } }), variants: await prisma.productVariant.count({ where: { clientId: SHOP } }) };
  const linked = await btq('POST', '/link', TEN, { shopName: 'Label Designer (boutique)' });
  check('the boutique app\'s own test shop exists, empty, with one place "Boutique"', linked.status === 201
    && (await prisma.stockLocation.count({ where: { clientId: linked.data?.clientId } })) === 1, linked);
  const boutiqueOnly = linked.data?.clientId as string;
  const boutiqueStore = (await prisma.stockLocation.findFirst({ where: { clientId: boutiqueOnly } }))!.id;

  console.log('\nTHE CONSOLE: ENABLE, AND THE BOUTIQUE APP RUNS THE WHOLE SHOP');
  const on = await consoleApi('PUT', `/clients/${SHOP}/boutique`, { tenant: TEN, handOver: true });
  check('enabled: 200, linked', on.status === 200 && on.data?.linked === true, on);
  check('...2 items handed over by code, 1 reported (neither its SKU nor its variant code is a valid item code)',
    on.data?.handedOver?.itemsCoded === 2 && on.data?.handedOver?.skipped?.length === 1 && on.data.handedOver.skipped[0] === spaced2, on.data?.handedOver);
  check('...the empty "Boutique" place that came along is removed', (on.data?.storesRemoved ?? []).includes('Boutique') && !(await prisma.stockLocation.findUnique({ where: { id: boutiqueStore } })), on.data?.storesRemoved);
  const storesNow = await prisma.stockLocation.findMany({ where: { clientId: SHOP }, select: { id: true, code: true } });
  check('...the shop keeps its own Main Store (with the stock) AND its own empty new branch', storesNow.length === 2
    && storesNow.some(s => s.id === mainStore.id && s.code === 'MAIN-STORE') && storesNow.some(s => s.id === branch.id), storesNow);
  check('...nothing was copied: the same products and colours, not one more',
    (await prisma.product.count({ where: { clientId: SHOP } })) === before.products && (await prisma.productVariant.count({ where: { clientId: SHOP } })) === before.variants);

  console.log('\nTHE BOUTIQUE APP NOW WORKS ON THOSE PRODUCTS');
  const items = await btq('GET', '/items?limit=50', TEN);
  const codes = (items.data?.items ?? []).map((i: any) => i.itemCode);
  check('its item list has the handed-over products, by their SKU (or variant code)', items.status === 200 && codes.includes(goodSku) && codes.includes(`VC-${S}-2`), codes);
  const saree = (items.data?.items ?? []).find((i: any) => i.itemCode === goodSku);
  check('...with the same price and stock (12,000; 3 pieces in Main Store), ready to wear', saree?.sellingPrice === 12000 && saree?.stock === 3 && saree?.category === 'FINISHED', saree);
  const price = await btq('PUT', `/items/${goodSku}`, TEN, { name: 'Gold kanchi saree', sellingPrice: 11500 });
  const v = await prisma.productVariant.findFirst({ where: { clientId: SHOP, sku: goodSku } });
  check('the app changes its price: the SAME item changes (11,500), no second one is made', price.status < 300 && Number(v?.sellingPrice) === 11500
    && (await prisma.productVariant.count({ where: { clientId: SHOP } })) === before.variants, price);
  const prod = await prisma.product.findFirst({ where: { id: v!.productId }, select: { priceOwner: true } });
  check('...prices are the boutique app\'s now', prod?.priceOwner === 'BOUTIQUE', prod);
  const sale = await btq('POST', '/movements', TEN, { itemCode: goodSku, kind: 'SALE', quantity: 1 });
  check('the app sells one: 2 left in the same stock', sale.status < 300 && (await prisma.inventoryStock.findFirst({ where: { variantId: v!.id, locationId: mainStore.id } }))?.quantity === 2, sale);
  const hold = await btq('POST', '/holds', TEN, { itemCode: `VC-${S}-2`, quantity: 2, orderRef: 'ST-9' });
  check('the app holds 2 blouses for a stitching order', hold.status < 300 && hold.data?.held === 2, hold);
  const nextCode = await btq('GET', '/items/next-code?prefix=PRD', TEN);
  check('a new item code never repeats a handed-over one', nextCode.status === 200 && !codes.includes(nextCode.data?.itemCode ?? nextCode.data?.code), nextCode.data);

  console.log('\nAGAIN, AND THE OTHER WAY');
  const again = await consoleApi('POST', `/clients/${SHOP}/boutique/hand-over`);
  check('handing over again changes nothing (0 coded, the same 1 reported)', again.status === 200 && again.data?.itemsCoded === 0 && again.data?.skipped?.length === 1, again);
  await retailShop(OTHER, [{ sku: `OTH-${S}-1`, variantCode: `OVC-${S}-1`, title: 'Other saree', price: 5000, qty: 2 }]);
  await btq('POST', '/link', TEN2, { shopName: 'Other boutique' });
  const plain = await consoleApi('PUT', `/clients/${OTHER}/boutique`, { tenant: TEN2 });
  const otherItems = await btq('GET', '/items', TEN2);
  check('enabling WITHOUT hand-over: the shop\'s own products stay the shop\'s (not in the app\'s list, prices unchanged)', plain.status === 200 && !plain.data?.handedOver
    && (otherItems.data?.items ?? []).length === 0 && (await prisma.product.count({ where: { clientId: OTHER, priceOwner: 'BOUTIQUE' } })) === 0, { plain, otherItems: otherItems.data });
  check('...and still loses only the boutique\'s empty place, never its own branch', (await prisma.stockLocation.count({ where: { clientId: OTHER } })) === 2);
  const notOn = await consoleApi('POST', `/clients/${SHOP}-nope/boutique/hand-over`);
  check('hand-over for a shop that is not ours: 404', notOn.status === 404, notOn);
}

async function cleanup() {
  const ids = [SHOP, OTHER, ...(await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: `hotest-${S}` } }, select: { clientId: true } })).map(l => l.clientId)];
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} shops`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
