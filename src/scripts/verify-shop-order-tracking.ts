/**
 * The online shop's order page as a customer sees it, through Logistics (29 Oct, online-shop/tracking).
 *
 * Over the real routes on the local server (4016): Inventory packs (POST /logistics/parcels as the
 * owner), Logistics sends its updates (signed service token, POST .../parcels/:id/updates), and the
 * customer's page is read back exactly as the shop serves it (GET /_api/shop/:slug/orders/:token on the
 * shop host). Checked at every stage:
 *   1. placed; packed but not booked -- NOT "on its way"; booked: the tracking number and page, never
 *      the courier's name; picked up; a missed attempt; out for delivery; delivered and cash collected;
 *   2. trouble: going back to the shop, lost, a booking cancelled and arranged again;
 *   3. two parcels: partly packed, partly on its way, one delivered and one not;
 *   4. a dispatch from before Logistics keeps its own tracking link;
 *   5. a cancelled order shows no parcels.
 *
 * LOCAL DATABASE ONLY, shop verify-suites-tenant (slug localshop). Puts back what it changed.
 *   DATABASE_URL=… DIRECT_URL=… ROLE_TOKENS=<old scratchpad>/local-tokens.json IDS=<old scratchpad>/local-ids.json npx tsx src/scripts/verify-shop-order-tracking.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`); }
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const API = 'http://localhost:4016/api/v1';
const SP = 'C:/Users/HP/AppData/Local/Temp/claude/D--villy-inventory/00d435a0-68b0-4933-9758-bcc19e3e6522/scratchpad';
const KEY = fs.readFileSync(`${SP}/test-logistics-keys/private.pem`);
const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
const ids = JSON.parse(fs.readFileSync(process.env.IDS!, 'utf8'));
const C: string = ids.clientId;
const SLUG = 'localshop';
const STAMP = Date.now();

const call = (method: string, path: string, body?: unknown, bearer?: string) =>
  fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5183', ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie: `token=${tokens.SUPER_ADMIN}` }) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));
const svc = () => jwt.sign({ sub: 'logistics-test', scope: ['modules:logistics'] }, KEY, { algorithm: 'RS256', keyid: 'test-1', issuer: 'scaleezy-logistics-test', audience: 'inventory', expiresIn: 300 });
const internal = (method: string, path: string, body?: unknown) => call(method, `/internal/modules/logistics${path}`, body, svc());
// The customer's page, at the shop's own address. node:http, because fetch will not set a Host header
// (it is a forbidden header there), and the backend only answers shop routes on the shop's host.
const shopCall = (method: string, path: string, body?: string) => new Promise<{ status: number; raw: string }>((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: 4016, path, method, headers: { host: 'shop.localhost:4006', 'content-type': 'application/json' } }, res => {
    let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});
const page = (token: string) => shopCall('GET', `/_api/shop/${SLUG}/orders/${token}`)
  .then(r => ({ ...r, o: (() => { try { const j = JSON.parse(r.raw); return j.data ?? j; } catch { return null; } })() }));

(async () => {
  const { prisma } = await import('../lib/prisma');
  const { salesOrderService } = await import('../services/sales-order.service');
  const { inventoryMutationService } = await import('../services/inventory-mutation.service');
  const { dispatchService } = await import('../services/dispatch.service');
  const started = new Date();
  const orders: string[] = [];
  const parcelIds: string[] = [];
  const store = await prisma.stockLocation.findUniqueOrThrow({ where: { id: ids.locationId }, select: { address: true, phone: true } });
  const hadLogistics = !!(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: C, module: 'logistics' } } }));

  const variant = await prisma.productVariant.findFirstOrThrow({ where: { clientId: C, product: { status: 'ACTIVE', trashedAt: null } }, orderBy: { sku: 'asc' }, select: { id: true } });
  const have = (await prisma.inventoryStock.findFirst({ where: { clientId: C, variantId: variant.id, locationId: ids.locationId } }))?.quantity ?? 0;
  if (have < 30) await inventoryMutationService.applyMovement({ clientId: C, variantId: variant.id, locationId: ids.locationId, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 60, unitCost: 1000, notes: 'verify-shop-order-tracking top-up', createdBy: 'verify-shop-order-tracking' } as any);

  /** A shop order paid on delivery, as the checkout writes it: the bill, and the customer's link to it. */
  const shopOrder = async (qty = 1) => {
    const o: any = await salesOrderService.createFullOrder(C, ids.locationId, {
      customer: { id: ids.customerId, shippingAddress: 'Flat 4, 12-3 Gandhi Road, Vijayawada 520001' },
      channel: 'ONLINE', sourceSystem: 'SCALEEZY_SHOP', externalOrderId: `VSOT-${STAMP}-${orders.length}`,
      items: [{ variantId: variant.id, quantity: qty }]
    }, 'ONLINE');
    await salesOrderService.confirmOrder(C, o.id);
    orders.push(o.id);
    const token = `vsot-${STAMP}-${orders.length}-${crypto.randomBytes(6).toString('hex')}`;
    await prisma.onlineShopOrder.create({ data: { clientId: C, salesOrderId: o.id, placementKey: token, token, payWay: 'ON_DELIVERY' as any } });
    return { id: o.id as string, number: o.orderNumber as string, itemId: o.items[0].id as string, total: Number(o.total), token };
  };
  const pack = async (o: { id: string; itemId: string }, qty = 1) => {
    const r = await call('POST', '/logistics/parcels', { salesOrderId: o.id, items: [{ salesOrderItemId: o.itemId, quantity: qty }], box: 'Medium', weightKg: 0.7 });
    if (r.status !== 200 && r.status !== 201) throw new Error(`packing refused: ${r.status} ${JSON.stringify(r.body)}`);
    parcelIds.push(r.body.data.id);
    return r.body.data.id as string;
  };
  let clock = Date.now() - 3 * 3600_000;   // updates happen in order, an hour apart, in the past
  const say = (parcelId: string, status: string, extra: any = {}) =>
    internal('POST', `/shops/${C}/parcels/${parcelId}/updates`, { status, at: new Date(clock += 60_000).toISOString(), ...extra });
  // A page that does not answer 200 with an order is a failure in itself, never an empty pass.
  const view = async (token: string) => {
    const r = await page(token);
    if (r.status !== 200 || !r.o?.orderNumber) throw new Error(`the order page answered ${r.status}: ${r.raw.slice(0, 200)}`);
    return r.o;
  };
  const stages = (o: any) => (o?.parcels ?? []).map((p: any) => p.stage);

  try {
    await prisma.stockLocation.update({ where: { id: ids.locationId }, data: { address: '22 Market Street, Vijayawada 520002', phone: '9000011111' } });
    const on = await internal('PUT', `/shops/${C}`);
    check('Logistics switched on for the test shop', on.status === 200, on);

    console.log('\n1. ONE PARCEL, ALL THE WAY');
    const a = await shopOrder();
    let o = await view(a.token);
    eq('placed: nothing packed yet, can still be cancelled, cash to have ready', [o?.state, o?.progress, o?.parcels?.length, o?.mayCancel, o?.paidOnDelivery], ['PLACED', { packed: false, moving: false, delivered: false }, 0, true, false]);
    const pa = await pack(a);
    o = await view(a.token);
    eq('packed, no courier yet: "packed" -- not "on its way"', [o?.state, o?.progress, stages(o), o?.parcels?.[0]?.trackingNumber, o?.parcels?.[0]?.trackingUrl, o?.mayCancel], ['PACKED', { packed: true, moving: false, delivered: false }, ['PACKED'], null, null, false]);
    await say(pa, 'BOOKED', { courier: 'Delhivery', awb: `AWB-A-${STAMP}`, tracking_url: 'https://track.example/a', label_url: 'https://labels.example/a.pdf' });
    let r = await page(a.token);
    o = r.o;
    check('the page answers 200 with the order', r.status === 200 && o?.orderNumber === a.number, r.raw.slice(0, 160));
    eq('booked: still packed, now with the tracking number and the tracking page', [o?.state, stages(o), o?.parcels?.[0]?.trackingNumber, o?.parcels?.[0]?.trackingUrl], ['PACKED', ['BOOKED'], `AWB-A-${STAMP}`, 'https://track.example/a']);
    check('the courier\'s name, the label and the shop\'s own ids are nowhere in what the customer gets', !/Delhivery|labels\.example|dispatchNumber|courierName/.test(r.raw) && !r.raw.includes(pa), r.raw.slice(0, 200));
    await say(pa, 'PICKED_UP');
    o = await view(a.token);
    eq('picked up: on its way', [o?.state, o?.progress?.moving, stages(o)], ['SENT', true, ['ON_ITS_WAY']]);
    await say(pa, 'FAILED_ATTEMPT', { note: 'Customer not at home' });
    o = await view(a.token);
    eq('a missed attempt: still on its way, the parcel says it was missed', [o?.state, stages(o)], ['SENT', ['MISSED']]);
    await say(pa, 'OUT_FOR_DELIVERY');
    o = await view(a.token);
    eq('out for delivery: "arrives today"', [o?.state, stages(o)], ['OUT_FOR_DELIVERY', ['OUT_FOR_DELIVERY']]);
    check('...still cash to have ready', o?.paidOnDelivery === false, o?.paidOnDelivery);
    await say(pa, 'DELIVERED', { cod_collected: a.total });
    o = await view(a.token);
    eq('delivered, with its date, and the cash recorded: nothing more to pay', [o?.state, o?.delivered, o?.progress, stages(o), !!o?.parcels?.[0]?.deliveredAt, o?.paidOnDelivery],
      ['DELIVERED', true, { packed: true, moving: true, delivered: true }, ['DELIVERED'], true, true]);

    console.log('\n2. TROUBLE');
    const b = await shopOrder();
    const pb = await pack(b);
    await say(pb, 'BOOKED', { courier: 'Delhivery', awb: `AWB-B-${STAMP}`, tracking_url: 'https://track.example/b' });
    await say(pb, 'CANCELLED', { note: 'Courier refused the pickup' });
    o = await view(b.token);
    eq('a booking cancelled: being arranged again, still "packed"', [o?.state, stages(o)], ['PACKED', ['REARRANGING']]);
    await say(pb, 'BOOKED', { courier: 'Xpressbees', awb: `AWB-B2-${STAMP}`, tracking_url: 'https://track.example/b2' });
    o = await view(b.token);
    eq('booked again: the new tracking number and page', [stages(o), o?.parcels?.[0]?.trackingNumber, o?.parcels?.[0]?.trackingUrl], [['BOOKED'], `AWB-B2-${STAMP}`, 'https://track.example/b2']);
    await say(pb, 'IN_TRANSIT');
    await say(pb, 'RTO_INITIATED', { note: 'Address not found' });
    o = await view(b.token);
    eq('going back to the shop: a problem, not "on its way"', [o?.state, stages(o), o?.delivered, o?.paidOnDelivery], ['TROUBLE', ['RETURNING'], false, false]);
    const b2 = await shopOrder();
    const pb2 = await pack(b2);
    await say(pb2, 'BOOKED', { awb: `AWB-L-${STAMP}` });
    await say(pb2, 'LOST');
    o = await view(b2.token);
    eq('lost: a problem with this parcel', [o?.state, stages(o)], ['TROUBLE', ['PROBLEM']]);

    console.log('\n3. TWO PARCELS');
    const c = await shopOrder(2);
    const pc1 = await pack(c, 1);
    o = await view(c.token);
    eq('one of two pieces packed: partly packed', [o?.state, stages(o)], ['PART_PACKED', ['PACKED']]);
    await say(pc1, 'BOOKED', { awb: `AWB-C1-${STAMP}`, tracking_url: 'https://track.example/c1' });
    await say(pc1, 'IN_TRANSIT');
    o = await view(c.token);
    eq('the first on its way: partly on its way', [o?.state, o?.progress?.moving], ['PART_SENT', true]);
    const pc2 = await pack(c, 1);
    o = await view(c.token);
    eq('both packed, one moving: on its way, each parcel its own stage', [o?.state, stages(o)], ['SENT', ['ON_ITS_WAY', 'PACKED']]);
    await say(pc1, 'DELIVERED');
    o = await view(c.token);
    eq('one delivered, one not: NOT delivered yet', [o?.state, o?.delivered, stages(o)], ['SENT', false, ['DELIVERED', 'PACKED']]);
    await say(pc2, 'BOOKED', { awb: `AWB-C2-${STAMP}`, tracking_url: 'https://track.example/c2' });
    await say(pc2, 'DELIVERED');
    o = await view(c.token);
    eq('both delivered: delivered', [o?.state, o?.delivered, stages(o), o?.parcels?.map((p: any) => p.trackingNumber)], ['DELIVERED', true, ['DELIVERED', 'DELIVERED'], [`AWB-C1-${STAMP}`, `AWB-C2-${STAMP}`]]);
    check('...and paid on delivery once delivered, though no cash was reported', o?.paidOnDelivery === true, o?.paidOnDelivery);

    console.log('\n4. A DISPATCH FROM BEFORE LOGISTICS');
    await prisma.moduleSubscription.deleteMany({ where: { clientId: C, module: 'logistics' } });
    const d = await shopOrder();
    const sent: any = await prisma.$transaction(tx => dispatchService.dispatchInTransaction(tx, C, d.id, [{ salesOrderItemId: d.itemId, quantity: 1 }], {}), { timeout: 30000, maxWait: 15000 });
    await prisma.dispatch.update({ where: { id: sent.id }, data: { courierName: 'DTDC', trackingNumber: `OLD-${STAMP}`, trackingUrl: 'https://old-courier.example/t/1' } });
    r = await page(d.token);
    o = r.o;
    check('the page answers 200 with the order', r.status === 200 && o?.orderNumber === d.number, r.raw.slice(0, 160));
    eq('no Logistics parcel: on its way by the dispatch, its own tracking link kept', [o?.state, stages(o), o?.parcels?.[0]?.trackingNumber, o?.parcels?.[0]?.trackingUrl], ['SENT', ['ON_ITS_WAY'], `OLD-${STAMP}`, 'https://old-courier.example/t/1']);
    check('...and no courier name there either', !r.raw.includes('DTDC'), r.raw.slice(0, 160));
    await prisma.dispatch.update({ where: { id: sent.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    o = await view(d.token);
    eq('marked delivered by the shop: delivered', [o?.state, stages(o)], ['DELIVERED', ['DELIVERED']]);

    console.log('\n5. CANCELLED');
    const e = await shopOrder();
    const cancel = (await shopCall('POST', `/_api/shop/${SLUG}/orders/${e.token}/cancel`, '{}')).status;
    o = await view(e.token);
    eq('the customer cancels it: cancelled, no parcels', [cancel, o?.state, o?.parcels?.length], [200, 'CANCELLED', 0]);
  } catch (err: any) {
    console.error(err);
    check(`the suite reached the end (stopped at: ${String(err?.message ?? err).split('\n')[0]})`, false);
  } finally {
    await prisma.stockLocation.update({ where: { id: ids.locationId }, data: { address: store.address, phone: store.phone } }).catch(x => console.log('left the store address', x.message));
    if (!hadLogistics) await prisma.moduleSubscription.deleteMany({ where: { clientId: C, module: 'logistics' } }).catch(() => null);
    await prisma.moduleEvent.deleteMany({ where: { clientId: C, module: 'logistics', createdAt: { gte: started } } }).catch(() => null);
    await prisma.logisticsParcel.deleteMany({ where: { id: { in: parcelIds } } }).catch(x => console.log('left parcels', x.message));
    await prisma.onlineShopOrder.deleteMany({ where: { salesOrderId: { in: orders } } }).catch(x => console.log('left shop orders', x.message));
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
