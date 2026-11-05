/**
 * "Ask an online customer for a review": CRM hears order.delivered once, and fetches the order's link (5 Nov, owner:
 * walk-ins get the Google link, online customers get the link to review what they bought).
 * Over the real routes on 4026: orders placed, parcels marked delivered, every way that should and should not fire.
 * LOCAL DATABASE ONLY. Its own products, numbers and subscription rows, put back at the end.
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) { console.error('Refusing: local database only.'); process.exit(2); }
import fs from 'node:fs';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { dispatchService } from '../services/dispatch.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 360)}` : ''}`); }
};
const C = 'verify-suites-tenant', SLUG = 'localshop', LOCATION = '0e3adb72-1143-4b80-b92b-bbbb2612fe19';
const STAMP = String(Date.now()).slice(-6);
const CODES = 'C:/Users/HP/AppData/Local/Temp/claude/D--villy-inventory/9bd5afd2-c77c-4f44-bec2-3d5913e47e09/scratchpad/codes.jsonl';
const P1 = `905${STAMP}1`, P2 = `905${STAMP}2`;
const privateKey = fs.readFileSync(process.env.CRM_KEY as string, 'utf8');
const raw = (path: string, method: string, body: unknown, headers: Record<string, string>) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  const d = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: 4026, path, method, headers: { ...headers, ...(d ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(d)) } : {}) } }, (res) => {
    let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let b = null; try { b = JSON.parse(t); } catch { /* */ } resolve({ status: res.statusCode ?? 0, body: b }); });
  });
  req.on('error', reject); if (d) req.write(d); req.end();
});
const call = (path: string, body?: unknown) => raw(`/_api/shop/${SLUG}${path}`, body === undefined ? 'GET' : 'POST', body, { host: 'shop.localhost:4006' });
const bearer = (scope = ['modules:crm']) => ({ Authorization: `Bearer ${jwt.sign({ sub: 'scaleezy-crm-test', scope }, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-crm-test', keyid: 'test-1', expiresIn: '5m' })}` });
const link = (id: string, headers: Record<string, string> = bearer(), client = C) => raw(`/api/v1/internal/modules/crm/shops/${client}/orders/${id}/review-link`, 'GET', undefined, { host: '127.0.0.1:4026', ...headers });
const eventsFor = (id: string) => prisma.moduleEvent.findMany({ where: { clientId: C, kind: 'order.delivered', rowId: id } });
const sent = (phone: string) => fs.readFileSync(CODES, 'utf8').trim().split('\n').filter(Boolean).filter(l => String(JSON.parse(l).to).endsWith(phone)).length;
const prove = async (phone: string) => {
  const before = sent(phone);
  await call('/verify/send', { phone, purpose: 'SIGNIN' });
  let code = '';
  for (let i = 0; i < 80 && !code; i++) {
    const rows = fs.readFileSync(CODES, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => String(l.to).endsWith(phone)).slice(before);
    code = /(\d{6}) is your code/.exec(rows.at(-1)?.text ?? '')?.[1] ?? '';
    if (!code) await new Promise(r => setTimeout(r, 200));
  }
  return (await call('/verify/check', { phone, code })).body.data.token as string;
};

async function main() {
  const was = await prisma.onlineShop.findFirstOrThrow({ where: { clientId: C }, select: { id: true, acceptsOrders: true, payOnDelivery: true, reviews: true, accounts: true } });
  const hadSub = await prisma.moduleSubscription.findFirst({ where: { clientId: C, module: 'crm' } });
  await prisma.onlineShop.update({ where: { id: was.id }, data: { acceptsOrders: true, payOnDelivery: true, reviews: true, accounts: true } });
  if (!hadSub) await (prisma.moduleSubscription as any).create({ data: { clientId: C, module: 'crm' } });
  const made: string[] = []; const sinceAll = new Date();
  let n = 0;
  const product = async (tag: string) => {
    const p = await prisma.product.create({ data: { clientId: C, productCode: `DL${STAMP}-${tag}`, slug: `dl${STAMP}-${tag}`.toLowerCase(), title: `Delivered ${tag}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, dressType: 'Saree', basePrice: 1000, status: 'ACTIVE' as any, publishedAt: new Date() } as any });
    made.push(p.id);
    const v = await prisma.productVariant.create({ data: { productId: p.id, clientId: C, colorName: 'Red', size: 'M', variantCode: `DLV${STAMP}-${tag}`, sku: `DLS${STAMP}-${tag}`, sellingPrice: 1000, costPrice: 1, reorderLevel: 0 } as any });
    await prisma.inventoryStock.create({ data: { clientId: C, variantId: v.id, locationId: LOCATION, quantity: 40, reservedQty: 0 } });
    return { code: p.productCode, id: p.id, v };
  };
  const order = async (phone: string, items: any[]) => {
    const r = await call('/orders', { placementKey: `delivered-suite-${STAMP}-${++n}`, lines: items.map(i => ({ variantCode: i.v.variantCode, quantity: 2 })), name: 'Kavya Reddy', phone, email: '', address: 'Flat 4, 12-3 Gandhi Road, Vijayawada', pincode: '520001', payWay: 'ON_DELIVERY' });
    if (r.status !== 200) throw new Error(`order refused: ${JSON.stringify(r.body)}`);
    const token = r.body.data.token as string;
    const row = await prisma.onlineShopOrder.findUniqueOrThrow({ where: { token }, select: { salesOrderId: true, salesOrder: { select: { items: { select: { id: true, quantity: true } } } } } });
    return { token, id: row.salesOrderId, lines: row.salesOrder.items };
  };
  const send = (o: any, lines = o.lines) => prisma.$transaction(tx => dispatchService.dispatchInTransaction(tx, C, o.id, lines.map((i: any) => ({ salesOrderItemId: i.id, quantity: i.quantity })), {}), { timeout: 30000, maxWait: 15000 }) as Promise<any>;
  const mark = (id: string, status: string) => prisma.dispatch.update({ where: { id }, data: { status: status as any, ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}) } });

  try {
    const A = await product('A'), B = await product('B');

    console.log('\nWhen CRM hears');
    const o1 = await order(P1, [A]);
    check('placed: nothing yet', (await eventsFor(o1.id)).length === 0);
    const d1 = await send(o1);
    check('sent: nothing yet', (await eventsFor(o1.id)).length === 0);
    await mark(d1.id, 'DELIVERED');
    let ev = await eventsFor(o1.id);
    check('delivered: one order.delivered', ev.length === 1, ev.length);
    const pay: any = ev[0]?.payload ?? {};
    check('...with the order number, number and name', pay.order_number?.startsWith('SO-') && pay.phone?.endsWith(P1) && pay.customer_name === 'Kavya Reddy' && pay.sales_order_id === o1.id, pay);
    check('...and NOT the secret link', !JSON.stringify(pay).includes(o1.token));
    await mark(d1.id, 'SHIPPED'); await mark(d1.id, 'DELIVERED');
    check('set back and delivered again: still one', (await eventsFor(o1.id)).length === 1);

    const o2 = await order(P1, [A, B]);
    const d2a = await send(o2, [o2.lines[0]]);
    await prisma.salesOrder.update({ where: { id: o2.id }, data: { status: 'PARTIALLY_DISPATCHED' as any } }).catch(() => null);
    await mark(d2a.id, 'DELIVERED');
    check('part sent, that part delivered: nothing yet', (await eventsFor(o2.id)).length === 0);
    const d2b = await send(o2, [o2.lines[1]]);
    await prisma.salesOrder.update({ where: { id: o2.id }, data: { status: 'DISPATCHED' as any } }).catch(() => null);
    check('all sent, one still out: nothing yet', (await eventsFor(o2.id)).length === 0);
    await mark(d2b.id, 'DELIVERED');
    check('the last parcel arrives: one', (await eventsFor(o2.id)).length === 1);

    const o3 = await order(P1, [A, B]);
    const d3a = await send(o3, [o3.lines[0]]), d3b = await send(o3, [o3.lines[1]]);
    await prisma.salesOrder.update({ where: { id: o3.id }, data: { status: 'DISPATCHED' as any } }).catch(() => null);
    await mark(d3a.id, 'DELIVERED');
    await mark(d3b.id, 'CANCELLED');
    check('one delivered, the other cancelled: everything left has arrived, one', (await eventsFor(o3.id)).length === 1);

    const o4 = await order(P1, [A]); const d4 = await send(o4);
    await mark(d4.id, 'CANCELLED');
    check('its only parcel cancelled: nothing', (await eventsFor(o4.id)).length === 0);

    const o5 = await order(P1, [A]); const d5 = await send(o5);
    await prisma.salesOrder.update({ where: { id: o5.id }, data: { status: 'CANCELLED' as any } });
    await mark(d5.id, 'DELIVERED');
    check('the order cancelled: nothing', (await eventsFor(o5.id)).length === 0);

    await prisma.onlineShop.update({ where: { id: was.id }, data: { reviews: false } });
    const o6 = await order(P1, [A]); const d6 = await send(o6); await mark(d6.id, 'DELIVERED');
    check('reviews switched off: nothing', (await eventsFor(o6.id)).length === 0);
    await prisma.onlineShop.update({ where: { id: was.id }, data: { reviews: true, accounts: false } });
    const o7 = await order(P1, [A]); const d7 = await send(o7); await mark(d7.id, 'DELIVERED');
    check('accounts switched off: nothing', (await eventsFor(o7.id)).length === 0);
    await prisma.onlineShop.update({ where: { id: was.id }, data: { accounts: true } });

    const o8 = await order(P1, [A]); const d8 = await send(o8);
    await prisma.moduleSubscription.deleteMany({ where: { clientId: C, module: 'crm' } });
    await mark(d8.id, 'DELIVERED');
    check('CRM not switched on: nothing, and the parcel is still marked delivered', (await eventsFor(o8.id)).length === 0 && (await prisma.dispatch.findUniqueOrThrow({ where: { id: d8.id } })).status === 'DELIVERED');
    await (prisma.moduleSubscription as any).create({ data: { clientId: C, module: 'crm' } });

    // A till sale: an ordinary order with no online order behind it.
    const o9 = await order(P1, [A]); const d9 = await send(o9);
    await prisma.onlineShopOrder.delete({ where: { salesOrderId: o9.id } });
    await mark(d9.id, 'DELIVERED');
    check('a sale with no online order (the till): nothing, that one gets the Google link instead', (await eventsFor(o9.id)).length === 0);

    console.log('\nThe trigger can never stop a delivery');
    // Only this trigger breaks: it reads a column nothing else in this update touches.
    const oX = await order(P1, [A]); const dX = await send(oX);
    await prisma.$executeRawUnsafe(`ALTER TABLE online_shop_orders RENAME COLUMN customer_phone TO customer_phone_gone`);
    let survived = false;
    try {
      await mark(dX.id, 'DELIVERED');
      survived = (await prisma.dispatch.findUniqueOrThrow({ where: { id: dX.id } })).status === 'DELIVERED';
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE online_shop_orders RENAME COLUMN customer_phone_gone TO customer_phone`); }
    check('the trigger failing inside: the parcel still marks delivered, only no event', survived && (await eventsFor(oX.id)).length === 0);

    console.log('\nThe link');
    let r = await link(o1.id);
    const L = r.body?.data;
    check('CRM gets the order page\'s link, the number and the items', r.status === 200 && L?.path === `/${SLUG}/order/${o1.token}` && L?.orderNumber?.startsWith('SO-') && L?.phone?.endsWith(P1) && L?.items?.length === 1, r.body);
    check('...arrived, reviews on, nothing rated: ask now', L?.delivered === true && L?.reviewsOn === true && L?.askNow === true && L?.items?.[0]?.rating === null, L);
    const page = await call(`/orders/${o1.token}`);
    check('...and that link really opens the order, delivered', page.status === 200 && page.body?.data?.delivered === true, page.status);
    const two = (await link(o2.id)).body?.data;
    check('an order of two items lists both', two?.items?.length === 2, two?.items);
    const t1 = await prove(P1);
    await call(`/products/${A.code}/reviews`, { token: t1, rating: 5 });
    const after = (await link(o1.id)).body?.data;
    check('its only item reviewed: do not ask again', after?.askNow === false && after?.items?.[0]?.rating === 5, after);
    const part = (await link(o2.id)).body?.data;
    check('one of two reviewed: still worth asking, and it says which', part?.askNow === true && part?.items?.find((i: any) => i.productCode === A.code)?.rating === 5 && part?.items?.find((i: any) => i.productCode === B.code)?.rating === null, part?.items);
    const early = await order(P2, [B]);
    check('not delivered yet: the link exists, but do not ask', (await link(early.id)).body?.data?.askNow === false);
    await prisma.onlineShop.update({ where: { id: was.id }, data: { reviews: false } });
    check('reviews off: do not ask', (await link(o2.id)).body?.data?.askNow === false);
    await prisma.onlineShop.update({ where: { id: was.id }, data: { reviews: true } });

    console.log('\nWho may have it');
    r = await link(o1.id, {}); check('no token: 401', r.status === 401, r.status);
    r = await link(o1.id, bearer(['session:read'])); check('the wrong scope: 403', r.status === 403, r.status);
    r = await link('00000000-0000-0000-0000-000000000000'); check('an order that does not exist: 404', r.status === 404, r.status);
    r = await link(o9.id); check('a till sale: 404, in a sentence', r.status === 404 && typeof r.body?.message === 'string', r.body);
    r = await link(o1.id, bearer(), 'some-other-shop'); check('through another shop: refused', r.status === 404, r.status);
  } finally {
    await prisma.onlineShop.update({ where: { id: was.id }, data: { acceptsOrders: was.acceptsOrders, payOnDelivery: was.payOnDelivery, reviews: was.reviews, accounts: was.accounts } });
    await prisma.shopReview.deleteMany({ where: { productId: { in: made } } });
    await prisma.product.updateMany({ where: { id: { in: made } }, data: { status: 'ARCHIVED' as any } });
    await prisma.moduleEvent.deleteMany({ where: { clientId: C, createdAt: { gte: sinceAll } } }).catch(() => null);
    if (!hadSub) await prisma.moduleSubscription.deleteMany({ where: { clientId: C, module: 'crm' } }).catch(() => null);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log('FAILED:\n  ' + failures.join('\n  '));
}
main().catch((e) => { console.error(e); failed++; }).finally(async () => { await prisma.$disconnect(); process.exit(failed ? 1 : 0); });
