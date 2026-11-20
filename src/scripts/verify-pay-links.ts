/**
 * Pay links (20 Nov 2026, CRM C7 online), against the REAL local server and database.
 *
 * CRM asks for a link to pay what is due on one order; the customer's page shows the shop, the order number, the first
 * name and the amounts (nothing private). Proved: who may (CRM's pass, a CRM shop), a shop without Razorpay refused,
 * a till bill refused (its balance is taken on the till), nothing due refused, another shop's order not found, the same
 * link again while waiting, the page's view as money is paid at the shop meanwhile (less due, then nothing due), an
 * expired link, a made-up token, and a confirm with nothing paid leaving everything as it was.
 * NOT proved here: Razorpay's checkout, capture and refund of an excess -- no Razorpay TEST keys on this machine.
 *
 * Throwaway shops (paylink-*), removed at the end (KEEP_FOR_UI=1 keeps one waiting link to open in a browser).
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 CRM_KEY_DIR=<dir> \
 *   npx tsx src/scripts/verify-pay-links.ts
 */
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { shopCheckout } from '../services/online-shop';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const ROOT = BASE.replace(/\/api\/v1\/?$/, '');
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const KEY = fs.readFileSync(`${process.env.CRM_KEY_DIR}/private.pem`, 'utf8');
const S = Date.now().toString(36);
const SHOP = `paylink-${S}`, OTHER = `paylink-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const pass = (clientId: string) => `Bearer ${jwt.sign({ sub: 'scaleezy-crm-test', scope: ['modules:crm'], clientId }, KEY, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}`;
async function crm(method: string, path: string, shop = SHOP) {
  const r = await fetch(`${BASE}/internal/modules/crm/shops/${shop}${path}`, { method, headers: { Authorization: pass(shop), 'Content-Type': 'application/json', 'Idempotency-Key': `pl-${S}-${Math.random()}` }, body: method === 'POST' ? '{}' : undefined });
  const b: any = await r.json().catch(() => null);
  return { status: r.status, data: b?.data, message: b?.message as string | undefined };
}
async function page(method: string, token: string, path = '') {
  const r = await fetch(`${ROOT}/shop/_pay/${encodeURIComponent(token)}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  const b: any = await r.json().catch(() => null);
  return { status: r.status, data: b?.data, message: b?.message as string | undefined };
}
const pay = (orderId: string, rupees: number, key: string) => prisma.salesOrderPayment.create({ data: { clientId: SHOP, salesOrderId: orderId, locationId: storeId, kind: 'PAYMENT', method: 'CASH', amount: rupees, onceKey: `PL-TEST-${key}-${S}` } as any });
let storeId = '';

async function main() {
  for (const c of [SHOP, OTHER]) {
    await seedRolesForClient(c);
    await prisma.moduleSubscription.create({ data: { clientId: c, module: 'crm', enabledBy: 'verify-pay-links' } });
  }
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Swathy Reddy Test' } as any });
  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, code: 'MAIN', name: 'Main Store', type: 'STORE' } });
  storeId = store.id;
  const product = await prisma.product.create({ data: { clientId: SHOP, productCode: `PL-${S}`, slug: `pl-${S}`, title: 'Kanchi silk saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 6500, status: 'ACTIVE' as any, publishedAt: new Date(), sellInShop: true } as any });
  const v = await prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, variantCode: `PL-${S}-V`, sku: `PL-${S}-V`, colorName: 'Ruby', size: 'Free', sellingPrice: 6500 } as any });
  await prisma.inventoryStock.create({ data: { clientId: SHOP, variantId: v.id, locationId: store.id, quantity: 5 } as any });
  await prisma.onlineShop.create({ data: { clientId: SHOP, slug: `plshop-${S}`, isLive: true, acceptsOrders: true, payOnDelivery: true, locationIds: [store.id], deliverPincodes: [] } as any });
  await shopCheckout.place(SHOP, { placementKey: `paylink-test-${S}-placement-1`, lines: [{ variantCode: v.variantCode, quantity: 1 }], name: 'Asha Rao', phone: '9848012399', email: '', address: 'Flat 4, Road 3, Hyderabad', pincode: '500034', payWay: 'ON_DELIVERY' } as any);
  const order = (await prisma.salesOrder.findFirst({ where: { clientId: SHOP, sourceSystem: 'SCALEEZY_SHOP' } }))!;

  console.log('\nASKING FOR A LINK');
  const noRzp = await crm('POST', `/customers/dues/${order.id}/pay-link`);
  check('the shop has no Razorpay: 409 saying it does not take online payments yet', noRzp.status === 409 && /online payments/.test(noRzp.message ?? ''), noRzp);
  // A connected Razorpay account, as Settings -> Payments leaves it (never used here: nothing calls Razorpay).
  await prisma.shopPaymentAccount.create({ data: { clientId: SHOP, gateway: 'RAZORPAY', keyId: `rzp_live_PLTEST${S}`.slice(0, 30), keySecretEncrypted: 'x', webhookSecretEncrypted: 'x', webhookToken: `pl-${S}`, mode: 'LIVE', status: 'CONNECTED' } as any });
  const made = await crm('POST', `/customers/dues/${order.id}/pay-link`);
  const token = String(made.data?.url ?? '').split('/pay/')[1] ?? '';
  check('a link: the shop\'s address /pay/<token>, Rs 6,500 due, 7 days', made.status === 200 && /\/pay\/[A-Za-z0-9_-]{30,}$/.test(made.data?.url ?? '') && made.data?.amountPaise === 650000 && made.data?.orderNumber === order.orderNumber, made);
  const again = await crm('POST', `/customers/dues/${order.id}/pay-link`);
  check('asked again while it waits: the same link', again.data?.url === made.data?.url && again.data?.reused === true, again.data);
  check('another shop\'s order: 404', (await crm('POST', `/customers/dues/${order.id}/pay-link`, OTHER)).status === 404);
  check('an order that does not exist: 404', (await crm('POST', '/customers/dues/00000000-0000-0000-0000-000000000000/pay-link')).status === 404);

  // A till bill with money still owed: its balance is taken on the till, never online.
  const cred = generateCredential();
  await prisma.storefrontConnection.create({ data: { clientId: SHOP, name: 'Till', baseUrl: POS_BASE_URL, credentialHash: cred.hash, credentialPrefix: cred.prefix, status: 'ACTIVE', locationIds: [store.id] } as any });
  const inv = `INV/PL/${S}`;
  await fetch(`${BASE}/pos/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-storefront-key': cred.plaintext }, body: JSON.stringify({ kind: 'sale.completed', invoiceNo: inv, occurredAt: new Date().toISOString(), customer: { name: 'Till Latha', phone: '+919848012311' }, lines: [{ itemCode: v.variantCode, qty: 1, unitPricePaise: 650000, lineTotalPaise: 650000 }], totals: { roundOffPaise: 0 }, payments: [{ method: 'CASH', amountPaise: 100000 }] }) });
  let till = null as any;
  for (let i = 0; i < 60 && !till; i++) { till = await prisma.salesOrder.findFirst({ where: { clientId: SHOP, externalOrderId: inv } }); if (!till) await new Promise(r => setTimeout(r, 1000)); }
  const tillLink = await crm('POST', `/customers/dues/${till?.id}/pay-link`);
  check('a till bill with money owed: 409, taken on the till', !!till && tillLink.status === 409 && /till/i.test(tillLink.message ?? ''), tillLink);

  console.log('\nTHE CUSTOMER\'S PAGE');
  const v1 = await page('GET', token);
  check('waiting: the shop, the order, "Asha", bill Rs 6,500, paid 0, due Rs 6,500', v1.status === 200 && v1.data?.state === 'WAITING' && v1.data?.shop?.name === 'Swathy Reddy Test' && v1.data?.orderNumber === order.orderNumber && v1.data?.firstName === 'Asha' && v1.data?.bill === 6500 && v1.data?.paid === 0 && v1.data?.due === 6500, v1.data);
  const text = JSON.stringify(v1.data);
  check('nothing private on it: no phone, no address, no surname, no items', !/9848012399|Road 3|Rao|Kanchi|500034/.test(text), text);
  check('a made-up token: 404', (await page('GET', 'x'.repeat(32))).status === 404);
  const conf = await page('POST', token, '/confirm');
  check('confirm with nothing paid yet: still waiting, nothing recorded', conf.status === 200 && conf.data?.state === 'WAITING' && !(await prisma.salesOrderPayment.count({ where: { salesOrderId: order.id } })), conf);
  await pay(order.id, 2000, 'a');
  const v2 = await page('GET', token);
  check('Rs 2,000 paid at the shop meanwhile: the page asks for Rs 4,500', v2.data?.paid === 2000 && v2.data?.due === 4500 && v2.data?.state === 'WAITING', v2.data);
  const fresh = await crm('POST', `/customers/dues/${order.id}/pay-link`);
  check('CRM asks again now: a new link for Rs 4,500 (the old amount no longer matches)', fresh.data?.amountPaise === 450000 && fresh.data?.url !== made.data?.url, fresh.data);
  if (process.env.KEEP_FOR_UI === '1') { console.log(`\nKEPT FOR UI: http://localhost:5198/pay/${String(fresh.data?.url).split('/pay/')[1]}`); return; }
  await pay(order.id, 4500, 'b');
  const v3 = await page('GET', token);
  check('the rest paid at the shop: nothing to pay', v3.data?.state === 'NOTHING_DUE' && v3.data?.due === 0, v3.data);
  check('and CRM cannot make a link for it: 409 nothing due', (await crm('POST', `/customers/dues/${order.id}/pay-link`)).status === 409);
  check('pressing Pay on it: 409 in words', /Nothing is due/.test((await page('POST', token, '/checkout')).message ?? ''));
  await prisma.orderPayLink.updateMany({ where: { clientId: SHOP }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await prisma.salesOrderPayment.deleteMany({ where: { salesOrderId: order.id, onceKey: `PL-TEST-b-${S}` } });
  const v4 = await page('GET', token);
  check('a link past its 7 days: expired, ask the shop for a new one', v4.data?.state === 'EXPIRED', v4.data);
}

async function cleanup() {
  const ids = [SHOP, OTHER];
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: ids } } }).catch(() => undefined);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log('\ncleaned up');
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { if (process.env.KEEP_FOR_UI !== '1') await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
