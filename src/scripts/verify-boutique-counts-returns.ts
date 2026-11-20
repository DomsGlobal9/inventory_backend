/**
 * Stock count sessions and returns of online orders through the boutique API (20 Nov 2026), against the REAL local
 * server and database.
 *   Counts: a draft for one store, started, items counted by the boutique's code (cloth in metres), finished -- the stock
 *   becomes what was found; a second count cancelled; who may; another shop kept apart.
 *   Returns: a real online order placed and sent; a return asked for its piece (a piece never sent refused), received,
 *   inspected RESTOCK, completed -- the piece is back in stock; another return rejected; who may; another shop apart.
 *
 * Throwaway accounts only (crtest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-counts-returns.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { shopCheckout } from '../services/online-shop';
import { dispatchService } from '../services/dispatch.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `crtest-${S}`, TEN2 = `crtest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const ALL = ['products:write', 'stock:write', 'orders:write'];
const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[] } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can ?? ALL)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `cr-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const stockOf = async (clientId: string, code: string) => (await prisma.inventoryStock.findMany({ where: { clientId, variant: { boutiqueRef: code } } })).reduce((s, x) => s + x.quantity, 0);

async function main() {
  const link = await call('POST', '/link', { shopName: 'Counts and Returns' });
  const clientId = link.data.clientId as string;
  await call('POST', '/link', { shopName: 'Other' }, { tenant: TEN2 });
  const store = (await prisma.stockLocation.findFirst({ where: { clientId, active: true } }))!;
  const SILK = `${S}-SK`, BL = `${S}-BL`;
  await call('PUT', `/items/${SILK}`, { name: 'Kanchi silk', kind: 'FABRIC', unit: 'METER', sellingPrice: 450, sellInShop: true });
  await call('PUT', `/items/${BL}`, { name: 'Ready blouse', category: 'FINISHED', unit: 'PIECE', sellingPrice: 1499, sellInShop: true });
  await call('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 10 });
  await call('POST', '/movements', { itemCode: BL, kind: 'PURCHASE', quantity: 5 });

  console.log('\nSTOCK COUNT SESSIONS');
  check('without stock:write: 403', (await call('POST', '/stock-counts', { name: 'x', storeId: store.id }, { can: ['orders:write'] })).status === 403);
  check('no name: 400', (await call('POST', '/stock-counts', { storeId: store.id })).status === 400);
  const made = await call('POST', '/stock-counts', { name: 'November count', storeId: store.id });
  check('a count for the store: 201, a draft', made.status === 201 && made.data?.name === 'November count', made);
  const id = made.data?.id;
  const started = await call('POST', `/stock-counts/${id}/start`, {});
  const silkLine = started.data?.items?.find((i: any) => i.itemCode === SILK);
  check('started: each item with what the books expect (silk 10 m, in metres)', started.status === 200 && silkLine?.expected === 10 && silkLine?.unit === 'METRE', started.data);
  const c1 = await call('PUT', `/stock-counts/${id}/items`, { itemCode: SILK, counted: 9.5 });
  const c2 = await call('PUT', `/stock-counts/${id}/items`, { itemCode: BL, counted: 5 });
  check('counted by code: silk 9.5 m (0.5 m short), blouses 5', c1.status === 200 && c2.status === 200 && c2.data?.items?.find((i: any) => i.itemCode === SILK)?.difference === -0.5 && c2.data.counted === 2, c2.data);
  check('an item not in the count: 404 naming it', /NOPE-1/.test((await call('PUT', `/stock-counts/${id}/items`, { itemCode: 'NOPE-1', counted: 1 })).message ?? ''));
  check('a count below a centimetre: 400', (await call('PUT', `/stock-counts/${id}/items`, { itemCode: SILK, counted: 9.555 })).status === 400);
  check('another shop cannot see it (404)', (await call('GET', `/stock-counts/${id}`, undefined, { tenant: TEN2 })).status === 404);
  const done = await call('POST', `/stock-counts/${id}/complete`, {});
  check('finished: the silk is now 9.5 m (950 cm), as found', done.status === 200 && (await stockOf(clientId, SILK)) === 950, [done.status, done.message, await stockOf(clientId, SILK)]);
  const second = await call('POST', '/stock-counts', { name: 'Spare', storeId: store.id });
  const cancelled = await call('POST', `/stock-counts/${second.data?.id}/cancel`, {});
  check('a second count cancelled; listed with the first', cancelled.status === 200 && (await call('GET', '/stock-counts')).data?.length === 2, cancelled);

  console.log('\nRETURNS OF ONLINE ORDERS');
  await prisma.onlineShop.create({ data: { clientId, slug: `crshop-${S}`, isLive: true, acceptsOrders: true, payOnDelivery: true, locationIds: [store.id], deliverPincodes: [] } as any });
  const placed: any = await shopCheckout.place(clientId, { placementKey: `cr-${S}-place`, lines: [{ variantCode: `BV-${BL}`, quantity: 2 }], name: 'Asha', phone: '9848012399', email: '', address: 'Flat 4, Road 3, Hyderabad', pincode: '500034', payWay: 'ON_DELIVERY' } as any);
  const so = await prisma.salesOrder.findFirst({ where: { clientId, sourceSystem: 'SCALEEZY_SHOP' }, include: { items: true } });
  check('a real online order for 2 blouses', !!placed && !!so && so.items[0]?.quantity === 2, placed);
  check('a return before anything was sent: refused (nothing was sent)', (await call('POST', `/orders/${so!.orderNumber}/returns`, { lines: [{ itemCode: BL, quantity: 1 }] })).status === 409);
  await dispatchService.createDispatch(clientId, so!.id, [{ salesOrderItemId: so!.items[0].id, quantity: 2 }]);
  const afterSend = await stockOf(clientId, BL);
  check('sent: 2 blouses left the stock (5 -> 3)', afterSend === 3, afterSend);
  check('without orders:write: 403', (await call('POST', `/orders/${so!.orderNumber}/returns`, { lines: [{ itemCode: BL, quantity: 1 }] }, { can: ['stock:write'] })).status === 403);
  check('a piece never sent on this order: 409 in words', /not sent on this order/.test((await call('POST', `/orders/${so!.orderNumber}/returns`, { lines: [{ itemCode: SILK, quantity: 1 }] })).message ?? ''));
  check('more than was sent: 400', (await call('POST', `/orders/${so!.orderNumber}/returns`, { lines: [{ itemCode: BL, quantity: 3 }] })).status === 400);
  check('a reason that is not one: 400', (await call('POST', `/orders/${so!.orderNumber}/returns`, { lines: [{ itemCode: BL, quantity: 1 }], reason: 'BORED' })).status === 400);
  const asked = await call('POST', `/orders/${so!.orderNumber}/returns`, { lines: [{ itemCode: BL, quantity: 1 }], reason: 'SIZE_ISSUE', notes: 'Too tight' });
  check('a return for 1 blouse, size issue: 201, REQUESTED, by the boutique\'s code', asked.status === 201 && asked.data?.status === 'REQUESTED' && asked.data?.items?.[0]?.itemCode === BL && asked.data?.orderNumber === so!.orderNumber, asked);
  const rid = asked.data?.id;
  check('another shop cannot see it (404)', (await call('GET', `/returns/${rid}`, undefined, { tenant: TEN2 })).status === 404);
  const recv = await call('POST', `/returns/${rid}/receive`, {});
  const insp = await call('POST', `/returns/${rid}/inspect`, { lines: [{ itemCode: BL, disposition: 'RESTOCK' }] });
  check('received, then inspected: back on the shelf (RESTOCK)', recv.status === 200 && insp.status === 200 && insp.data?.items?.[0]?.disposition === 'RESTOCK', [recv.status, recv.message, insp.status, insp.message]);
  const comp = await call('POST', `/returns/${rid}/complete`, {});
  check('completed: the blouse is back in stock (3 -> 4)', comp.status === 200 && (await stockOf(clientId, BL)) === 4, [comp.status, comp.message, await stockOf(clientId, BL)]);
  const r2 = await call('POST', `/orders/${so!.orderNumber}/returns`, { lines: [{ itemCode: BL, quantity: 1 }], reason: 'CUSTOMER_REJECTED' });
  const rej = await call('POST', `/returns/${r2.data?.id}/reject`, {});
  check('another return rejected: nothing comes back (still 4)', rej.status === 200 && (await stockOf(clientId, BL)) === 4, [rej.status, rej.message]);
  check('the returns list has both', (await call('GET', '/returns')).data?.length === 2);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'crtest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  await prisma.moduleEvent.deleteMany({ where: { clientId: { in: ids } } }).catch(() => undefined);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM sales_return_items WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM stock_count_items WHERE stock_count_id IN (SELECT id FROM stock_counts WHERE client_id = ANY($1))`, ids).catch(() => undefined);
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
