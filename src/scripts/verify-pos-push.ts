/**
 * Inventory -> POS till at once (12 Nov 2026, PLAN-live.md step 3; services/pos-push).
 * Against a LOCAL server started with POS_EVENTS_URL=http://localhost:4187/api/v1/inventory/events and
 * POS_EVENTS_SECRET=local-pos-push-test-secret (launch.json backend-localdb-4036). This script plays the POS
 * service on 4187 and checks what arrives, signed, from the real server.
 *
 *   A  a till's shop: a price change -> one signed catalogue.changed (products) in under 4 s; signature checks out
 *   B  50 stock lines in one go -> one event; offers and settings changes -> their topics
 *   C  no till / a switched-off till / a disconnected till -> nothing; another shop's change never names mine
 *   D  an erasure -> customer.erased {phone} at once; a rolled-back erasure -> nothing
 *   E  POS down: the event waits and is retried; more changes meanwhile add no second one; POS back -> the SAME
 *      event (same id) arrives once
 *   F  the server's line to the database is cut and comes back -> every till shop is told to pull once
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-pos-push.ts
 */
import http from 'node:http';
import crypto from 'node:crypto';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const SECRET = 'local-pos-push-test-secret';
process.env.POS_EVENTS_URL = 'http://localhost:4187/api/v1/inventory/events';
process.env.POS_EVENTS_SECRET = SECRET;

import { prisma } from '../lib/prisma';
import { noteErasures } from '../services/customer-erasures';
import { ModuleOutboxDispatcher } from '../services/module-outbox';

const STAMP = Date.now();
const SHOP = `push-${STAMP}`;
const NO_TILL = `push-none-${STAMP}`;
const OFF_TILL = `push-off-${STAMP}`;
const GONE_TILL = `push-gone-${STAMP}`;
const SHOP2 = `push-two-${STAMP}`;
const ALL = [SHOP, NO_TILL, OFF_TILL, GONE_TILL, SHOP2];
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Got = { at: number; headers: http.IncomingHttpHeaders; raw: string; body: any; answered: number };
const got: Got[] = [];
let answer = 200;
const pos = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body: any = null;
    try { body = JSON.parse(raw); } catch { /* recorded raw */ }
    // Only this run's shops: other local tests' tills are not ours to count.
    if (body && ALL.includes(body.clientId)) got.push({ at: Date.now(), headers: req.headers, raw, body, answered: answer });
    res.statusCode = body && ALL.includes(body.clientId) ? answer : 200;
    res.end('{}');
  });
});
const events = (shop: string, from = 0, kind?: string) => got.slice(from)
  .filter(g => g.body.clientId === shop && g.answered < 300)
  .flatMap(g => g.body.events).filter((e: any) => !kind || e.kind === kind);
const waitFor = async (pred: () => boolean, ms: number) => { const until = Date.now() + ms; while (Date.now() < until && !pred()) await sleep(50); return pred(); };
const signatureOk = (g: Got) => {
  const ts = String(g.headers['x-inventory-timestamp']);
  const want = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${g.raw}`, 'utf8').digest('hex');
  return g.headers['x-inventory-signature'] === want && Math.abs(Date.now() / 1000 - Number(ts)) < 60 && !!g.headers['x-inventory-delivery-id'];
};

async function till(clientId: string, status: 'ACTIVE' | 'DISABLED' | 'REVOKED') {
  return prisma.storefrontConnection.create({ data: {
    clientId, name: 'Counter', status: status as any, baseUrl: 'pos://counter',
    credentialHash: crypto.randomBytes(16).toString('hex'), credentialPrefix: `sk_t${crypto.randomBytes(3).toString('hex')}`, locationIds: []
  } });
}
async function product(clientId: string, n: number) {
  const p = await prisma.product.create({ data: { clientId, productCode: `PP-${clientId}`, slug: `pp-${clientId}`, title: 'Push saree', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any } });
  const store = await prisma.stockLocation.create({ data: { clientId, name: 'Main', code: `PL-${clientId}`.slice(0, 40), type: 'STORE' as any, active: true } });
  const vs = [];
  for (let i = 0; i < n; i++) vs.push(await prisma.productVariant.create({ data: { productId: p.id, clientId, colorName: `C${i}`, size: 'Free', variantCode: `PV-${clientId}-${i}`, sku: `PS-${clientId}-${i}`, sellingPrice: 1000 } }));
  await prisma.inventoryStock.createMany({ data: vs.map(v => ({ clientId, variantId: v.id, locationId: store.id, quantity: 1 })) });
  return { p, vs };
}

async function main() {
  await new Promise<void>(r => pos.listen(4187, r));
  await till(SHOP, 'ACTIVE');
  await till(SHOP2, 'ACTIVE');
  await till(OFF_TILL, 'DISABLED');
  await till(GONE_TILL, 'REVOKED');
  const mine = await product(SHOP, 50);
  const two = await product(SHOP2, 1);
  const none = await product(NO_TILL, 1);
  const off = await product(OFF_TILL, 1);
  const gone = await product(GONE_TILL, 1);
  // Let the set-up's own signals pass, then start counting from a clean slate.
  await sleep(2500);
  await ModuleOutboxDispatcher.runOnce({ onlyClients: ALL });
  await prisma.moduleEvent.updateMany({ where: { clientId: { in: ALL }, module: 'pos', status: { in: ['PENDING', 'RETRYING'] } }, data: { status: 'CANCELLED' as any } });
  got.length = 0;

  console.log('A. A PRICE CHANGE IN A SHOP WITH A TILL');
  let mark = got.length;
  const t0 = Date.now();
  await prisma.productVariant.update({ where: { id: mine.vs[0].id }, data: { sellingPrice: 1200 } });
  let ok = await waitFor(() => events(SHOP, mark, 'catalogue.changed').length > 0, 4000);
  const first = got.slice(mark).find(g => g.body.clientId === SHOP);
  check('the till is told within 4 s', ok, `${Date.now() - t0} ms, ${got.length - mark} posts`);
  check('...as catalogue.changed naming products, with a from/to window', ok && events(SHOP, mark)[0].payload.topics.includes('products') && !!events(SHOP, mark)[0].payload.from && !!events(SHOP, mark)[0].payload.to, JSON.stringify(events(SHOP, mark)));
  check('...signed with the shared secret over "timestamp.body", with a delivery id', !!first && signatureOk(first), JSON.stringify(first?.headers ?? {}));
  check('...addressed to that shop, from inventory, carrying no product data', !!first && first.body.source === 'inventory' && first.body.module === 'pos' && !JSON.stringify(first.body).includes('1200'), first?.raw ?? '');

  console.log('\nB. BURSTS AND OTHER KINDS');
  await sleep(2000);
  mark = got.length;
  await prisma.$transaction(mine.vs.map(v => prisma.inventoryStock.updateMany({ where: { variantId: v.id }, data: { quantity: 5 } })));
  await waitFor(() => events(SHOP, mark).length > 0, 4000);
  await sleep(2500);
  const burst = events(SHOP, mark);
  check('50 stock lines in one go: one event, saying stock', burst.length === 1 && burst[0].payload.topics.includes('stock'), JSON.stringify(burst.map((e: any) => e.payload.topics)));
  mark = got.length;
  const offer = await prisma.offer.create({ data: { clientId: SHOP, offerCode: `PO-${STAMP}`, name: 'Push offer', valueType: 'PERCENTAGE' as any, value: 10, startsAt: new Date() } as any });
  ok = await waitFor(() => events(SHOP, mark).some((e: any) => e.payload.topics.includes('offers')), 4000);
  check('a new offer: the till is told (offers)', ok, JSON.stringify(events(SHOP, mark)));
  await sleep(2000);
  mark = got.length;
  await prisma.clientSettings.upsert({ where: { clientId: SHOP }, create: { clientId: SHOP, manualDiscountMaxPercent: 15 } as any, update: { manualDiscountMaxPercent: 15 } as any });
  ok = await waitFor(() => events(SHOP, mark).some((e: any) => e.payload.topics.includes('settings')), 4000);
  check('the manual-discount limit or GST changed: the till is told (settings)', ok, JSON.stringify(events(SHOP, mark)));

  console.log('\nC. SHOPS THAT MUST HEAR NOTHING');
  await sleep(2000);
  mark = got.length;
  await prisma.productVariant.update({ where: { id: none.vs[0].id }, data: { sellingPrice: 900 } });
  await prisma.productVariant.update({ where: { id: off.vs[0].id }, data: { sellingPrice: 900 } });
  await prisma.productVariant.update({ where: { id: gone.vs[0].id }, data: { sellingPrice: 900 } });
  await sleep(3500);
  check('no till, a switched-off till, a disconnected till: nothing is sent', [NO_TILL, OFF_TILL, GONE_TILL].every(s => events(s, mark).length === 0) && await prisma.moduleEvent.count({ where: { clientId: { in: [NO_TILL, OFF_TILL, GONE_TILL] }, module: 'pos' } }) === 0,
    JSON.stringify(got.slice(mark).map(g => g.body.clientId)));
  mark = got.length;
  await prisma.productVariant.update({ where: { id: two.vs[0].id }, data: { sellingPrice: 990 } });
  await waitFor(() => events(SHOP2, mark).length > 0, 4000);
  await sleep(1000);
  check("another shop's change goes to that shop only, never named as mine", events(SHOP2, mark).length === 1 && events(SHOP, mark).length === 0, JSON.stringify(got.slice(mark).map(g => g.body.clientId)));

  console.log('\nD. ERASURES');
  mark = got.length;
  const phone = `+91900009${String(STAMP).slice(-4)}`;
  await prisma.$transaction(async tx => { await noteErasures(tx, SHOP, [phone]); });
  ok = await waitFor(() => events(SHOP, mark, 'customer.erased').length > 0, 3000);
  const er = events(SHOP, mark, 'customer.erased');
  check('an erasure: customer.erased with the phone reaches the till within 3 s', ok && er.length === 1 && er[0].payload.phone === phone && !!er[0].payload.erasedAt, JSON.stringify(er));
  mark = got.length;
  await prisma.$transaction(async tx => { await noteErasures(tx, SHOP, ['+919000000001']); throw new Error('rolled back on purpose'); }).catch(() => undefined);
  await sleep(2000);
  await ModuleOutboxDispatcher.runOnce({ onlyClients: [SHOP] });
  check('an erasure that was rolled back: nothing reaches the till', events(SHOP, mark, 'customer.erased').length === 0 && await prisma.moduleEvent.count({ where: { clientId: SHOP, kind: 'customer.erased', rowId: '+919000000001' } }) === 0, JSON.stringify(events(SHOP, mark)));
  mark = got.length;
  await prisma.$transaction(async tx => { await noteErasures(tx, NO_TILL, ['+919000000002']); });
  await sleep(1500);
  check('an erasure in a shop with no till: nothing written, nothing sent', events(NO_TILL, mark).length === 0 && await prisma.moduleEvent.count({ where: { clientId: NO_TILL, module: 'pos' } }) === 0);

  console.log('\nE. POS IS DOWN');
  await sleep(1500);
  answer = 503;
  mark = got.length;
  await prisma.productVariant.update({ where: { id: mine.vs[1].id }, data: { sellingPrice: 1300 } });
  await waitFor(() => got.slice(mark).some(g => g.body.clientId === SHOP), 4000);
  await sleep(500);
  const waiting = await prisma.moduleEvent.findMany({ where: { clientId: SHOP, module: 'pos', kind: 'catalogue.changed', status: { in: ['PENDING', 'RETRYING'] } } });
  check('POS answered 503: the event waits to be tried again', waiting.length === 1 && waiting[0].status === 'RETRYING' && !!waiting[0].nextAttemptAt, JSON.stringify(waiting.map(w => [w.status, w.attempts])));
  await prisma.productVariant.update({ where: { id: mine.vs[2].id }, data: { sellingPrice: 1400 } });
  await prisma.inventoryStock.updateMany({ where: { variantId: mine.vs[3].id }, data: { quantity: 9 } });
  await sleep(2500);
  const still = await prisma.moduleEvent.count({ where: { clientId: SHOP, module: 'pos', kind: 'catalogue.changed', status: { in: ['PENDING', 'RETRYING'] } } });
  check('more changes while POS is down add no second waiting event (the till pulls all since its last sync)', still === 1, String(still));
  answer = 200;
  mark = got.length;
  await prisma.moduleEvent.updateMany({ where: { id: waiting[0].id }, data: { nextAttemptAt: new Date() } }); // its retry time has come
  await ModuleOutboxDispatcher.runOnce({ onlyClients: [SHOP] });
  const back = events(SHOP, mark, 'catalogue.changed');
  const after = await prisma.moduleEvent.findUnique({ where: { id: waiting[0].id } });
  check('POS back: the same event (same id) arrives once and is marked delivered', back.length === 1 && back[0].id === waiting[0].id && after?.status === 'DELIVERED', JSON.stringify(back.map((e: any) => e.id)) + ' ' + after?.status);

  console.log('\nF. THE SERVER LOSES ITS LINE TO THE DATABASE');
  await sleep(2000);
  mark = got.length;
  const cut = await prisma.$queryRawUnsafe<any[]>(`SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE query ILIKE 'LISTEN inventory_live%' AND pid <> pg_backend_pid()`);
  check('the listening connection is cut', cut.length >= 1, JSON.stringify(cut));
  ok = await waitFor(() => events(SHOP, mark, 'catalogue.changed').length > 0 && events(SHOP2, mark, 'catalogue.changed').length > 0, 10_000);
  check('back again: every shop with a till is told to pull once (changes while down were not heard)', ok, JSON.stringify(got.slice(mark).map(g => g.body.clientId)));
  check('...but not the shops without a working till', [NO_TILL, OFF_TILL, GONE_TILL].every(s => events(s, mark).length === 0));
  void offer;
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    await prisma.moduleEvent.deleteMany({ where: { clientId: { in: ALL } } });
    await prisma.customerErasure.deleteMany({ where: { clientId: { in: ALL } } });
    await prisma.offer.deleteMany({ where: { clientId: { in: ALL } } });
    await prisma.clientSettings.deleteMany({ where: { clientId: { in: ALL } } });
    await prisma.inventoryStock.deleteMany({ where: { clientId: { in: ALL } } });
    await prisma.productVariant.deleteMany({ where: { clientId: { in: ALL } } });
    await prisma.product.deleteMany({ where: { clientId: { in: ALL } } });
    await prisma.stockLocation.deleteMany({ where: { clientId: { in: ALL } } });
    await prisma.storefrontConnection.deleteMany({ where: { clientId: { in: ALL } } });
    const left = await prisma.moduleEvent.count({ where: { clientId: { in: ALL } } }) + await prisma.storefrontConnection.count({ where: { clientId: { in: ALL } } }) + await prisma.product.count({ where: { clientId: { in: ALL } } });
    check('nothing left behind', left === 0, String(left));
    console.log(`\n${passed} passed, ${failed} failed`);
    pos.close();
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
