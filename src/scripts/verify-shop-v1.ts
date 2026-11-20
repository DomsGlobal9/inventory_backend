/**
 * Shop API v1 and the boutique's online orders (20 Nov 2026, PLAN-shop-api.md), against the REAL local server and DB.
 *
 * /shop/v1/<shop>/... runs our own shop's routes behind a partner app key: no key, a wrong key, a key switched off,
 * another boutique's shop, a look code (not one shop's) -- refused; the shop, its products and an order on delivery --
 * served, the order marked as the app's, our shopper messages skipped, the Boutique app told through the boutique
 * outbox. Our own /shop/<shop> is unchanged, and a shopper cannot fake the app mark there. Through the boutique API:
 * which shop, the orders, one order, cancel (orders:write; the stock goes back), pack (refused in words while the shop
 * has no Logistics). The address "v1" can never be a shop's.
 *
 * Throwaway accounts only (v1test-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-shop-v1.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import * as appKeys from '../services/shop-app-keys';
import { checkSlug } from '../services/online-shop';

const API = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const ROOT = API.replace(/\/api\/v1\/?$/, '');
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(API)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `v1test-${S}`, TEN2 = `v1test-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
const btq = async (method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[] } = {}) => {
  const r = await axios.request({ method, url: `${API}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can ?? ['products:write', 'stock:write', 'orders:write'])}`, ...(method !== 'GET' ? { 'Idempotency-Key': `v1-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
};
const shop = async (method: string, p: string, body?: unknown, key?: string | null) => {
  const r = await axios.request({ method, url: `${ROOT}${p}`, data: body, validateStatus: () => true, timeout: 90_000, headers: key ? { 'X-Shop-App-Key': key } : {} });
  return { status: r.status, data: r.data?.data ?? r.data, message: r.data?.message as string | undefined };
};

async function setUpShop(tenant: string, slug: string) {
  const link = await btq('POST', '/link', { shopName: `V1 ${slug}` }, { tenant });
  const clientId = link.data.clientId as string;
  const store = await prisma.stockLocation.findFirst({ where: { clientId, active: true } });
  await prisma.stockLocation.update({ where: { id: store!.id }, data: { address: '12 MG Road, Hyderabad 500001', phone: '9000000001' } });
  await prisma.onlineShop.create({ data: { clientId, slug, isLive: true, acceptsOrders: true, payOnDelivery: true, locationIds: [store!.id], deliverPincodes: [] } as any });
  await btq('PUT', `/items/${slug}-BL`, { name: 'Ready blouse', category: 'FINISHED', unit: 'PIECE', color: 'Maroon', size: '38', sellingPrice: 1499, sellInShop: true }, { tenant });
  await btq('POST', '/movements', { itemCode: `${slug}-BL`, kind: 'PURCHASE', quantity: 5 }, { tenant });
  return { clientId, store: store!.id };
}

async function main() {
  check('"v1" can never be a shop\'s address', (() => { try { checkSlug('v1'); return false; } catch { return true; } })());
  const SLUG = `v1shop-${S}`, SLUG2 = `v1other-${S}`;
  const A = await setUpShop(TEN, SLUG);
  const B = await setUpShop(TEN2, SLUG2);
  const made = await appKeys.make({ name: 'Boutique app (test)', tenant: TEN }, null);
  const KEY = made.key;
  check('an app key is made for one boutique account, shown once (sak_...)', /^sak_[a-z0-9]{10}_/.test(KEY) && made.tenant === TEN && !(await appKeys.list(TEN)).some((k: any) => 'key' in k), made.keyStartsWith);
  await appKeys.make({ name: 'x', tenant: 'nobody-here' }, null).then(() => check('a key for an account with no shop: refused', false), e => check('a key for an account with no shop: refused', /No shop is linked/.test(e.message), e.message));

  console.log('\nTHE DOOR');
  check('no key: 401 saying to send it', (await shop('GET', `/shop/v1/${SLUG}`)).status === 401);
  check('a made-up key: 401', (await shop('GET', `/shop/v1/${SLUG}`, undefined, `sak_abcdefghij_${'x'.repeat(40)}`)).status === 401);
  check('a key with the right start but a wrong secret: 401', (await shop('GET', `/shop/v1/${SLUG}`, undefined, `sak_${made.keyStartsWith.slice(4, 14)}_${'y'.repeat(40)}`)).status === 401);
  const other = await shop('GET', `/shop/v1/${SLUG2}`, undefined, KEY);
  check('another boutique\'s shop: 404, the same as no shop at all', other.status === 404 && (await shop('GET', `/shop/v1/no-such-shop-${S}`, undefined, KEY)).status === 404, other);
  check('a look code (not one shop\'s): not part of v1, 404', (await shop('GET', '/shop/v1/_look/ABC123', undefined, KEY)).status === 404);

  console.log('\nTHE SHOP THROUGH V1');
  const home = await shop('GET', `/shop/v1/${SLUG}`, undefined, KEY);
  check('the shop: 200, open, the same answer as our own shop', home.status === 200 && JSON.stringify(home.data) === JSON.stringify((await shop('GET', `/shop/${SLUG}`)).data), home.status);
  const products = await shop('GET', `/shop/v1/${SLUG}/products`, undefined, KEY);
  const bl = (products.data?.products ?? products.data?.items ?? []).find((p: any) => /blouse/i.test(p.title ?? ''));
  check('its products', products.status === 200 && !!bl, products.data);
  check('our own /shop/<shop> still works with no key', (await shop('GET', `/shop/${SLUG}`)).status === 200);

  console.log('\nAN ORDER IN THE APP');
  const order = { placementKey: `v1-${S}-place-1`, lines: [{ variantCode: `BV-${SLUG}-BL`, quantity: 1 }], name: 'Asha', phone: '9848012399', email: '', address: 'Flat 4, Road 3, Hyderabad', pincode: '500034', payWay: 'ON_DELIVERY' };
  const placed = await shop('POST', `/shop/v1/${SLUG}/orders`, order, KEY);
  const so = await prisma.salesOrder.findFirst({ where: { clientId: A.clientId, sourceSystem: 'SCALEEZY_SHOP' }, orderBy: { createdAt: 'desc' } });
  check('placed through v1: an order, marked as the app\'s', placed.status === 200 && so?.originApp === 'Boutique app (test)', [placed.status, placed.message, so?.originApp]);
  await new Promise(r => setTimeout(r, 1500));
  const told = await prisma.moduleEvent.findFirst({ where: { clientId: A.clientId, module: 'boutique', kind: 'order.placed', rowId: so?.id ?? '-' } });
  check('...the Boutique app is told (boutique outbox: tenant, order number, token)', (told?.payload as any)?.tenant === TEN && (told?.payload as any)?.orderNumber === so?.orderNumber && !!(told?.payload as any)?.orderToken, told?.payload);
  const fake = await shop('POST', `/shop/${SLUG}/orders`, { ...order, placementKey: `v1-${S}-place-2`, fromApp: 'Pretend app' });
  const so2 = await prisma.salesOrder.findFirst({ where: { clientId: A.clientId, sourceSystem: 'SCALEEZY_SHOP' }, orderBy: { createdAt: 'desc' } });
  check('our own shop: a "fromApp" in the body is ignored (no mark, no app message)', fake.status === 200 && so2?.id !== so?.id && so2?.originApp === null && !(await prisma.moduleEvent.count({ where: { clientId: A.clientId, module: 'boutique', rowId: so2!.id } })), [fake.status, so2?.originApp]);

  console.log('\nTHE ORDERS IN THE BOUTIQUE API');
  const which = await btq('GET', '/online-shop');
  check('which shop: its address, open, taking orders, the v1 path', which.data?.slug === SLUG && which.data?.open === true && which.data?.takingOrders === true && which.data?.apiPath === `/shop/v1/${SLUG}`, which.data);
  const fromApp = await btq('GET', '/orders', undefined, { can: [] });
  const appOnly = await btq('GET', '/orders?fromApp=1');
  check('orders: both listed; fromApp=1 only the app\'s', fromApp.data?.total === 2 && appOnly.data?.total === 1 && appOnly.data.orders[0].orderNumber === so?.orderNumber && appOnly.data.orders[0].fromApp === 'Boutique app (test)', [fromApp.data?.total, appOnly.data?.total]);
  const one = await btq('GET', `/orders/${so!.orderNumber}`);
  check('one order: customer, address, items by the boutique\'s code, ₹1,499 due on delivery', one.data?.customer?.name === 'Asha' && /Hyderabad/.test(one.data?.deliverTo ?? '') && one.data?.items?.[0]?.itemCode === `${SLUG}-BL` && one.data?.total === 1499 && one.data?.due === 1499, one.data);
  check('another boutique cannot see it (404)', (await btq('GET', `/orders/${so!.orderNumber}`, undefined, { tenant: TEN2 })).status === 404);
  const packNoLog = await btq('POST', `/orders/${so!.orderNumber}/pack`, { weightKg: 0.4, lengthCm: 30, breadthCm: 20, heightCm: 5 });
  check('pack while the shop has no Logistics: refused in words', packNoLog.status === 409 && /Logistics is not switched on/.test(packNoLog.message ?? ''), packNoLog);
  const noPerm = await btq('POST', `/orders/${so!.orderNumber}/cancel`, {}, { can: ['products:write'] });
  check('cancel without orders:write: 403', noPerm.status === 403, noPerm);
  const before = (await prisma.inventoryStock.findFirst({ where: { clientId: A.clientId } }))!;
  const cancelled = await btq('POST', `/orders/${so!.orderNumber}/cancel`, {});
  const after = (await prisma.inventoryStock.findFirst({ where: { id: before.id } }))!;
  check('cancel: CANCELLED, its held piece free again', cancelled.status === 200 && cancelled.data?.order?.status === 'CANCELLED' && after.reservedQty === before.reservedQty - 1, [cancelled.status, cancelled.message, before.reservedQty, after.reservedQty]);

  console.log('\nSWITCHED OFF');
  await appKeys.setActive(made.id, false);
  await new Promise(r => setTimeout(r, 31_000)); // the server keeps a key for at most 30 seconds
  const off = await shop('GET', `/shop/v1/${SLUG}`, undefined, KEY);
  check('a key switched off stops working (within 30 seconds)', off.status === 401 && /switched off/.test(off.message ?? ''), off);
  check('...our own shop is untouched by it', (await shop('GET', `/shop/${SLUG}`)).status === 200);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'v1test-' } }, select: { clientId: true } })).map(l => l.clientId);
  await prisma.shopAppKey.deleteMany({ where: { tenant: { startsWith: 'v1test-' } } });
  if (!ids.length) return;
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: ids } } });
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} clients`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
