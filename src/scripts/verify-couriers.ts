/**
 * Couriers on dispatches (services/shipping) -- through the real API, on the LOCAL database only.
 *
 *   A  Settings → Couriers: the common couriers offered, one-tap add, the first is the default
 *   B  refusals in words: same name twice (any case), no name, an http or broken link, a long name
 *   C  change: rename, move the default (only ever one), a rename onto another courier refused
 *   D  remove: gone from the list, offered again, adding it again brings the same courier back
 *   E  Create Dispatch with a courier and number; with a courier and no number; without a courier
 *      (as before); a removed courier, another shop's courier and a bad number refused with NOTHING sent
 *   F  later on the order: add the number, change courier, take the courier off; bad input refused
 *   G  delivered and back; a parcel with no courier cannot be "delivered"
 *   H  who may: sales (no dispatch:create) gets 403; warehouse may
 *   I  Orders page: Courier and Delivery filters with counts, and the Excel rows carry both
 *   J  the customer's order page (online shop): courier, number, link; "Delivered" once it arrived
 *   K  renaming a courier later keeps the name the parcel went with; the link follows the courier
 *   L  a Shopify fulfilment's courier and number are read off its payload
 *
 *   DATABASE_URL=<local> ROLE_TOKENS=<local-tokens.json> IDS=<local-ids.json> npx tsx src/scripts/verify-couriers.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { salesOrderService } from '../services/sales-order.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { shippingFromShopify } from '../services/shipping';

if (!/localhost:55433|127\.0\.0\.1:55433/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing: this suite runs on the local database only (DATABASE_URL must be localhost:55433).');
  process.exit(1);
}
const API = process.env.TEST_API_URL || 'http://localhost:4016/api/v1';
const ROOT = API.replace(/\/api\/v1$/, '');
const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
const ids = JSON.parse(fs.readFileSync(process.env.IDS!, 'utf8'));
const C: string = ids.clientId;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const as = (role: string) => axios.create({ baseURL: API, headers: { Cookie: `token=${tokens[role]}` }, validateStatus: () => true });
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 240)}`;
const msg = (r: any) => String(r.data?.message ?? r.data?.error ?? '');

async function freshOrder(variantIndex: number) {
  const variants = await prisma.productVariant.findMany({ where: { clientId: C }, orderBy: { sku: 'asc' } });
  const o: any = await salesOrderService.createFullOrder(C, ids.locationId, {
    customer: { id: ids.customerId, shippingAddress: '12-3 Gandhi Road, Vijayawada 520001' },
    channel: 'ONLINE', sourceSystem: 'SCALEEZY_SHOP', externalOrderId: `VC-${Date.now()}-${variantIndex}`,
    items: [{ variantId: variants[variantIndex % variants.length].id, quantity: 2 }]
  }, 'ONLINE');
  await salesOrderService.confirmOrder(C, o.id);
  return { id: o.id as string, number: o.orderNumber as string, itemId: o.items[0].id as string, variantId: o.items[0].variantId as string };
}
const onHand = async (variantId: string) =>
  (await prisma.inventoryStock.findFirst({ where: { clientId: C, variantId, locationId: ids.locationId } }))?.quantity;
const parcelsOf = async (owner: any, orderId: string) => (await owner.get(`/sales-orders/${orderId}`)).data?.data?.parcels ?? (await owner.get(`/sales-orders/${orderId}`)).data?.parcels;

async function main() {
  console.log(`\nCouriers on dispatches, on the LOCAL database (${C})\n`);
  const owner = as('SUPER_ADMIN'), sales = as('SALES'), warehouse = as('WAREHOUSE');

  // Enough local stock for the run's orders (earlier runs used it up).
  for (const v of await prisma.productVariant.findMany({ where: { clientId: C }, select: { id: true } })) {
    const have = (await onHand(v.id)) ?? 0;
    if (have < 30) await inventoryMutationService.applyMovement({ clientId: C, variantId: v.id, locationId: ids.locationId, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 40 - have, unitCost: 2600, notes: 'verify-couriers local top-up', createdBy: 'verify-couriers' } as any);
  }

  // A clean slate of couriers for this local shop (parcels already sent keep their names).
  await prisma.dispatch.updateMany({ where: { clientId: C }, data: { courierId: null } });
  await prisma.shopCourier.deleteMany({ where: { clientId: C } });

  console.log('A. SETTINGS → COURIERS');
  const a0 = await owner.get('/shipping/couriers');
  check('empty list, six common couriers offered (DTDC first, Own delivery last)', a0.status === 200 && a0.data.data.couriers.length === 0 && a0.data.data.suggestions.length === 6 && a0.data.data.suggestions[0].name === 'DTDC' && a0.data.data.suggestions[5].name === 'Own delivery', brief(a0));
  const dtdcSug = a0.data.data.suggestions[0];
  const a1 = await owner.post('/shipping/couriers', dtdcSug);
  const dtdc = a1.data?.data;
  check('one tap adds DTDC with its tracking page, and the first courier is the default', a1.status === 200 && dtdc?.name === 'DTDC' && dtdc?.isDefault === true && /dtdc\.com/.test(dtdc?.trackingLink ?? ''), brief(a1));
  const blue = (await owner.post('/shipping/couriers', a0.data.data.suggestions.find((s: any) => s.name === 'Blue Dart'))).data?.data;
  const own = (await owner.post('/shipping/couriers', { name: 'Own delivery', needsNumber: false })).data?.data;
  const a2 = await owner.get('/shipping/couriers');
  check('three couriers, default first, DTDC/Blue Dart no longer offered', a2.data.data.couriers.length === 3 && a2.data.data.couriers[0].name === 'DTDC' && !a2.data.data.suggestions.some((s: any) => ['DTDC', 'Blue Dart'].includes(s.name)), brief(a2));
  check('only the first is the default', a2.data.data.couriers.filter((c: any) => c.isDefault).length === 1);
  check('own delivery asks for no number', own?.needsNumber === false, JSON.stringify(own));

  console.log('\nB. REFUSALS');
  const b1 = await owner.post('/shipping/couriers', { name: 'dtdc' });
  check('"dtdc" again (other case): 409 in words', b1.status === 409 && /already in your couriers/.test(msg(b1)), brief(b1));
  const b2 = await owner.post('/shipping/couriers', { name: '   ' });
  check('no name: 400 in words', b2.status === 400 && /name/.test(msg(b2)), brief(b2));
  const b3 = await owner.post('/shipping/couriers', { name: 'Trackon', trackingLink: 'http://trackon.in/{number}' });
  check('an http:// link: 400 (https only)', b3.status === 400 && /https:\/\//.test(msg(b3)), brief(b3));
  const b4 = await owner.post('/shipping/couriers', { name: 'Trackon', trackingLink: 'not a link' });
  check('a broken link: 400', b4.status === 400 && /https:\/\//.test(msg(b4)), brief(b4));
  const b5 = await owner.post('/shipping/couriers', { name: 'X'.repeat(41) });
  check('a 41-letter name: 400', b5.status === 400 && /40/.test(msg(b5)), brief(b5));
  check('  ...and none of those was saved', (await prisma.shopCourier.count({ where: { clientId: C } })) === 3);

  console.log('\nC. CHANGE');
  const c1 = await owner.patch(`/shipping/couriers/${blue.id}`, { isDefault: true });
  const c1l = (await owner.get('/shipping/couriers')).data.data.couriers;
  check('Blue Dart made default: it is the only default, listed first', c1.status === 200 && c1l.filter((c: any) => c.isDefault).map((c: any) => c.name).join() === 'Blue Dart' && c1l[0].name === 'Blue Dart', JSON.stringify(c1l));
  const c2 = await owner.patch(`/shipping/couriers/${own.id}`, { name: 'Ravi (bike)' });
  check('rename Own delivery → Ravi (bike)', c2.status === 200 && c2.data.data.name === 'Ravi (bike)', brief(c2));
  const c3 = await owner.patch(`/shipping/couriers/${own.id}`, { name: 'Blue dart' });
  check('rename onto Blue Dart: 409, name unchanged', c3.status === 409 && (await prisma.shopCourier.findUniqueOrThrow({ where: { id: own.id } })).name === 'Ravi (bike)', brief(c3));

  console.log('\nD. REMOVE');
  const d1 = await owner.delete(`/shipping/couriers/${dtdc.id}`);
  const d1l = (await owner.get('/shipping/couriers')).data.data;
  check('DTDC removed: not in the list, offered again', d1.status === 200 && !d1l.couriers.some((c: any) => c.name === 'DTDC') && d1l.suggestions.some((s: any) => s.name === 'DTDC'), JSON.stringify(d1l));
  const removedId = dtdc.id;

  console.log('\nE. CREATE DISPATCH');
  const o1 = await freshOrder(0), o2 = await freshOrder(1), o3 = await freshOrder(0), o4 = await freshOrder(1);
  const before = await onHand(o1.variantId);
  const e1 = await owner.post('/dispatches', { salesOrderId: o1.id, items: [{ salesOrderItemId: o1.itemId, quantity: 1 }], courier: { courierId: blue.id, trackingNumber: ' 7903 4111 122 ' } });
  const row1 = await prisma.dispatch.findFirst({ where: { salesOrderId: o1.id } });
  check('dispatch with Blue Dart + number: 201, stock 1 less (as before)', e1.status === 201 && await onHand(o1.variantId) === (before ?? 0) - 1, `${brief(e1)} stock ${before} -> ${await onHand(o1.variantId)}`);
  check('  ...the row says Blue Dart and the number (spaces tidied)', row1?.courierName === 'Blue Dart' && row1?.courierId === blue.id && row1?.trackingNumber === '7903 4111 122' && row1?.status === 'SHIPPED', JSON.stringify(row1));
  let p1 = (await parcelsOf(owner, o1.id))?.[0];
  check('  ...the order shows the parcel: Track opens Blue Dart ON the parcel (number in the link)', p1?.courierName === 'Blue Dart' && p1?.trackingUrl === 'https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo=7903%204111%20122' && p1?.copyNumber === false && p1?.pieces === 1, JSON.stringify(p1));

  // DTDC is back for the next tests.
  const dtdc2 = (await owner.post('/shipping/couriers', { name: 'DTDC', trackingLink: 'https://www.dtdc.com/track-your-shipment/' })).data?.data;
  check('adding DTDC again brings the same courier back', dtdc2?.id === removedId, JSON.stringify(dtdc2));

  const e2 = await owner.post('/dispatches', { salesOrderId: o2.id, items: [{ salesOrderItemId: o2.itemId, quantity: 2 }], courier: { courierId: dtdc2.id } });
  const p2 = (await parcelsOf(owner, o2.id))?.[0];
  check('dispatch with DTDC and no number yet: sent; Track opens DTDC\'s page, nothing to copy', e2.status === 201 && p2?.courierName === 'DTDC' && p2?.trackingNumber === null && p2?.trackingUrl === 'https://www.dtdc.com/track-your-shipment/' && p2?.copyNumber === false && p2?.needsNumber === true, `${brief(e2)} ${JSON.stringify(p2)}`);

  const nn = await owner.get('/sales-orders', { params: { facets: '1', delivery: 'NO_NUMBER', limit: 100 } });
  const nnIds = (nn.data?.orders ?? []).map((o: any) => o.id);
  check('  ...the Orders filter "Tracking number missing" finds o2 and not o1', nnIds.includes(o2.id) && !nnIds.includes(o1.id), JSON.stringify(nnIds));

  const o3Stock = await onHand(o3.variantId);
  const e3 = await owner.post('/dispatches', { salesOrderId: o3.id, items: [{ salesOrderItemId: o3.itemId, quantity: 1 }], courier: { courierId: own.id + 'x' } });
  check('an unknown courier: 404 in words', e3.status === 404 && /not in your list/.test(msg(e3)), brief(e3));
  await prisma.shopCourier.create({ data: { clientId: 'some-other-shop-vc', name: 'Theirs', key: `theirs-${Date.now()}` } }).then(async (t) => {
    const e4 = await owner.post('/dispatches', { salesOrderId: o3.id, items: [{ salesOrderItemId: o3.itemId, quantity: 1 }], courier: { courierId: t.id } });
    check('another shop\'s courier: 404', e4.status === 404, brief(e4));
    await prisma.shopCourier.delete({ where: { id: t.id } });
  });
  const e5 = await owner.post('/dispatches', { salesOrderId: o3.id, items: [{ salesOrderItemId: o3.itemId, quantity: 1 }], courier: { courierId: blue.id, trackingNumber: 'AB$12' } });
  check('a tracking number with $: 400 in words', e5.status === 400 && /letters, digits/.test(msg(e5)), brief(e5));
  const e6 = await owner.post('/dispatches', { salesOrderId: o3.id, items: [{ salesOrderItemId: o3.itemId, quantity: 1 }], courier: { courierId: blue.id, trackingNumber: '1'.repeat(41) } });
  check('a 41-digit number: 400', e6.status === 400, brief(e6));
  const o3After = await prisma.salesOrder.findUniqueOrThrow({ where: { id: o3.id } });
  check('  ...after all four refusals NOTHING was sent: no dispatch, same stock, still CONFIRMED',
    (await prisma.dispatch.count({ where: { salesOrderId: o3.id } })) === 0 && await onHand(o3.variantId) === o3Stock && o3After.status === 'CONFIRMED', `stock ${o3Stock} -> ${await onHand(o3.variantId)} status ${o3After.status}`);
  const e7 = await owner.post('/dispatches', { salesOrderId: o3.id, items: [{ salesOrderItemId: o3.itemId, quantity: 1 }] });
  const p3 = (await parcelsOf(owner, o3.id))?.[0];
  check('no courier at all: sent exactly as before, parcel has no courier', e7.status === 201 && p3?.courierName === null && p3?.trackingUrl === null, `${brief(e7)} ${JSON.stringify(p3)}`);

  console.log('\nF. LATER, ON THE ORDER');
  const f1 = await owner.put(`/shipping/dispatches/${p2.id}`, { trackingNumber: 'D12345678' });
  check('DTDC parcel gets its number: Track opens DTDC and copies the number', f1.status === 200 && f1.data.data.trackingNumber === 'D12345678' && f1.data.data.copyNumber === true && f1.data.data.courierName === 'DTDC', brief(f1));
  const f2 = await owner.put(`/shipping/dispatches/${p2.id}`, { courierId: blue.id });
  check('courier changed to Blue Dart: the number stays, link now opens on the parcel', f2.status === 200 && f2.data.data.courierName === 'Blue Dart' && f2.data.data.trackingNumber === 'D12345678' && /trackNo=D12345678$/.test(f2.data.data.trackingUrl), brief(f2));
  const f3 = await owner.put(`/shipping/dispatches/${p3.id}`, { trackingNumber: 'X1' });
  check('a number on a parcel with no courier: 400 "choose the courier first"', f3.status === 400 && /Choose the courier/.test(msg(f3)), brief(f3));
  const f4 = await owner.put(`/shipping/dispatches/${p3.id}`, { courierId: own.id });
  check('courier added later to the no-courier parcel', f4.status === 200 && f4.data.data.courierName === 'Ravi (bike)' && f4.data.data.needsNumber === false, brief(f4));
  const f5 = await owner.put(`/shipping/dispatches/${p3.id}`, { courierId: null });
  check('courier taken off again: back to no courier', f5.status === 200 && f5.data.data.courierName === null && f5.data.data.trackingNumber === null, brief(f5));
  const f6 = await owner.put(`/shipping/dispatches/${p2.id}`, { trackingNumber: 'bad#no' });
  check('a bad number later: 400, the old one kept', f6.status === 400 && (await prisma.dispatch.findUniqueOrThrow({ where: { id: p2.id } })).trackingNumber === 'D12345678', brief(f6));
  const f7 = await owner.put(`/shipping/dispatches/00000000-0000-0000-0000-000000000000`, { trackingNumber: 'A1' });
  check('a dispatch that is not ours: 404', f7.status === 404, brief(f7));

  console.log('\nG. DELIVERED');
  const g1 = await owner.post(`/shipping/dispatches/${p1.id}/delivered`, { delivered: true });
  const at = g1.data?.data?.deliveredAt;
  check('marked delivered: status DELIVERED, with the time', g1.status === 200 && g1.data.data.status === 'DELIVERED' && !!at, brief(g1));
  const g2 = await owner.post(`/shipping/dispatches/${p1.id}/delivered`, { delivered: true });
  check('pressed again: the first time is kept', g2.status === 200 && g2.data.data.deliveredAt === at, brief(g2));
  const g3 = await owner.post(`/shipping/dispatches/${p1.id}/delivered`, { delivered: false });
  check('undone: back to SHIPPED, no time', g3.status === 200 && g3.data.data.status === 'SHIPPED' && g3.data.data.deliveredAt === null, brief(g3));
  const g4 = await owner.post(`/shipping/dispatches/${p3.id}/delivered`, { delivered: true });
  check('a parcel with no courier: 400, not delivered', g4.status === 400 && (await prisma.dispatch.findUniqueOrThrow({ where: { id: p3.id } })).status === 'SHIPPED', brief(g4));
  await owner.post(`/shipping/dispatches/${p1.id}/delivered`, { delivered: true });

  console.log('\nH. WHO MAY');
  const h1 = await sales.get('/shipping/couriers');
  const h2 = await sales.put(`/shipping/dispatches/${p2.id}`, { trackingNumber: 'S1' });
  const h3 = await sales.post(`/shipping/dispatches/${p2.id}/delivered`, {});
  check('sales (no dispatch:create): 403 on the list, the number and delivered', h1.status === 403 && h2.status === 403 && h3.status === 403, `${h1.status} ${h2.status} ${h3.status}`);
  const h4 = await warehouse.patch(`/shipping/couriers/${dtdc2.id}`, { trackingLink: 'https://www.dtdc.com/track-your-shipment/' });
  check('warehouse may change a courier', h4.status === 200, brief(h4));

  console.log('\nI. ORDERS PAGE');
  const i1 = await owner.get('/sales-orders', { params: { facets: '1' } });
  const courierFacet = i1.data?.facets?.courier ?? [], deliveryFacet = i1.data?.facets?.delivery ?? [];
  check('a Courier filter listing Blue Dart (2 orders: o1 and o2)', courierFacet.find((f: any) => f.value === 'Blue Dart')?.count >= 2, JSON.stringify(courierFacet));
  check('a Delivery filter: Delivered and On the way', deliveryFacet.some((f: any) => f.value === 'DELIVERED') && deliveryFacet.some((f: any) => f.value === 'ON_THE_WAY'), JSON.stringify(deliveryFacet));
  const i2 = await owner.get('/sales-orders', { params: { facets: '1', delivery: 'DELIVERED', limit: 100 } });
  const delivered = (i2.data?.orders ?? []).map((o: any) => o.id);
  check('Delivered: o1 is in, o2 (on the way) and o3 (no courier) are not', delivered.includes(o1.id) && !delivered.includes(o2.id) && !delivered.includes(o3.id), JSON.stringify(delivered));
  const i3 = await owner.get('/sales-orders', { params: { facets: '1', delivery: 'ON_THE_WAY', limit: 100 } });
  const otw = (i3.data?.orders ?? []).map((o: any) => o.id);
  check('On the way: o2 (number added since) is in; o1 (delivered) is not', otw.includes(o2.id) && !otw.includes(o1.id), JSON.stringify(otw));
  const i4 = await owner.get('/sales-orders', { params: { facets: '1', export: '1' } });
  const x1 = (i4.data?.rows ?? []).find((r: any) => r.orderNumber === o1.number);
  check('the Excel rows carry courier, tracking number and delivered', x1?.courier === 'Blue Dart' && x1?.trackingNumber === '7903 4111 122' && !!x1?.deliveredAt, JSON.stringify(x1));

  console.log('\nJ. THE CUSTOMER\'S ORDER PAGE');
  // A fresh online-shop order each run, with its own link for the customer.
  const fresh = await freshOrder(0);
  const shopToken = `vc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.onlineShopOrder.create({ data: { clientId: C, salesOrderId: fresh.id, placementKey: shopToken, token: shopToken, customerPhone: '9876543210', payWay: 'ON_DELIVERY' } as any });
  const so = { id: fresh.id };
  await owner.post('/dispatches', { salesOrderId: fresh.id, items: [{ salesOrderItemId: fresh.itemId, quantity: 2 }], courier: { courierId: dtdc2.id, trackingNumber: 'D99887766' } });
  const j1 = await axios.get(`${ROOT}/shop/${ids.shopSlug}/orders/${shopToken}`, { validateStatus: () => true });
  const jp = j1.data?.data?.parcels?.[0];
  check('the customer sees DTDC, the number and the tracking page', j1.status === 200 && jp?.courier === 'DTDC' && jp?.trackingNumber === 'D99887766' && /dtdc\.com/.test(jp?.trackingUrl ?? ''), brief(j1));
  check('  ...and nothing of the shop\'s own (no ids, no dispatch numbers)', jp && !('id' in jp) && !('dispatchNumber' in jp) && !('courierId' in jp), JSON.stringify(jp));
  check('  ...state SENT, not delivered yet', j1.data?.data?.state === 'SENT' && j1.data?.data?.delivered === false, brief(j1));
  const sp = (await parcelsOf(owner, so.id))?.[0];
  await owner.post(`/shipping/dispatches/${sp.id}/delivered`, { delivered: true });
  const j2 = await axios.get(`${ROOT}/shop/${ids.shopSlug}/orders/${shopToken}`, { validateStatus: () => true });
  check('after Mark delivered: the customer\'s page says delivered', j2.data?.data?.delivered === true && !!j2.data?.data?.parcels?.[0]?.deliveredAt, brief(j2));

  console.log('\nK. A COURIER RENAMED LATER');
  await owner.patch(`/shipping/couriers/${blue.id}`, { name: 'BlueDart Express', trackingLink: 'https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo={number}&x=1' });
  p1 = (await parcelsOf(owner, o1.id))?.[0];
  check('the parcel keeps the name it went with (Blue Dart); the link follows the courier', p1?.courierName === 'Blue Dart' && /&x=1$/.test(p1?.trackingUrl ?? ''), JSON.stringify(p1));

  console.log('\nL. SHOPIFY');
  const l1 = shippingFromShopify([{ status: 'success', tracking_company: 'Delhivery', tracking_number: '1234567890123', tracking_url: 'https://www.delhivery.com/track/package/1234567890123' }]);
  check('Shopify\'s courier, number and link are taken as given', l1?.courierName === 'Delhivery' && l1?.trackingNumber === '1234567890123' && l1?.trackingUrl === 'https://www.delhivery.com/track/package/1234567890123', JSON.stringify(l1));
  const l2 = shippingFromShopify([{ status: 'cancelled', tracking_company: 'X', tracking_number: '1' }, { status: 'success' }]);
  check('a cancelled fulfilment and one with no courier give nothing', l2 === null, JSON.stringify(l2));
  const l3 = shippingFromShopify([{ status: 'success', tracking_company: 'DTDC', tracking_number: 'A1', tracking_url: 'javascript:alert(1)' }]);
  check('a link that is not https is dropped, the courier kept', l3?.courierName === 'DTDC' && l3?.trackingUrl === null, JSON.stringify(l3));

  console.log('\nM. MANY LABELS AT ONCE');
  const m1 = await freshOrder(1), m2 = await freshOrder(0), m3 = await freshOrder(1);
  await owner.post('/dispatches', { salesOrderId: m1.id, items: [{ salesOrderItemId: m1.itemId, quantity: 1 }], courier: { courierId: dtdc2.id, trackingNumber: 'M1-A' } });
  await owner.post('/dispatches', { salesOrderId: m1.id, items: [{ salesOrderItemId: m1.itemId, quantity: 1 }], courier: { courierId: dtdc2.id, trackingNumber: 'M1-B' } });
  await owner.post('/dispatches', { salesOrderId: m2.id, items: [{ salesOrderItemId: m2.itemId, quantity: 2 }], courier: { courierId: own.id } });
  const ml = await owner.post('/shipping/labels', { orderIds: [m2.id, m1.id, m3.id] });
  const L = ml.data?.data?.labels ?? [];
  check('three labels, in the order ticked: m2, then the two parcels of m1, oldest first', ml.status === 200 && L.map((l: any) => l.orderNumber).join() === [m2.number, m1.number, m1.number].join() && L[1].parcel.trackingNumber === 'M1-A' && L[2].parcel.trackingNumber === 'M1-B', brief(ml));
  check('the order not sent (m3) is named, not printed', JSON.stringify(ml.data?.data?.notSent) === JSON.stringify([m3.number]), JSON.stringify(ml.data?.data?.notSent));
  const due1 = L[1].cashToCollect;
  check('m1 sent in two parcels: cash only on the first, the second says "collected with" the first', due1 > 0 && L[2].cashToCollect === 0 && L[2].cashWithParcel === L[1].parcel.dispatchNumber, JSON.stringify([L[1].cashToCollect, L[2].cashToCollect, L[2].cashWithParcel]));
  const one = await owner.get(`/shipping/dispatches/${L[2].parcel.id}/label`);
  check('  ...and the one-label page says the same for that parcel', one.data?.data?.cashToCollect === 0 && one.data?.data?.cashWithParcel === L[1].parcel.dispatchNumber, brief(one));
  const mx = await owner.post('/shipping/labels', { orderIds: [] });
  const my = await owner.post('/shipping/labels', { orderIds: Array.from({ length: 101 }, (_, n) => `x${n}`) });
  check('none ticked: 400; 101 orders: 400', mx.status === 400 && my.status === 400 && /100/.test(msg(my)), `${brief(mx)} ${brief(my)}`);
  const mz = await as('WAREHOUSE').post('/shipping/labels', { orderIds: [m1.id] });
  check('warehouse may print labels', mz.status === 200 && mz.data.data.labels.length === 2, brief(mz));

  console.log('\nN. MARK MANY DELIVERED');
  const nn1 = await owner.post('/shipping/delivered', { orderIds: [m1.id, m2.id, m3.id, o3.id] });
  const r = nn1.data?.data;
  check('m1 (two parcels) + m2: 3 parcels marked delivered', nn1.status === 200 && r?.parcels === 3, brief(nn1));
  const sk = (r?.skipped ?? []).map((x: any) => `${x.orderNumber}:${x.why}`).sort();
  check('  ...m3 skipped "not sent yet", o3 skipped "no courier on its parcel"', JSON.stringify(sk) === JSON.stringify([`${m3.number}:not sent yet`, `${o3.number}:no courier on its parcel`].sort()), JSON.stringify(r?.skipped));
  const rows = await prisma.dispatch.findMany({ where: { salesOrderId: { in: [m1.id, m2.id] } } });
  check('  ...in the database every one of their parcels is DELIVERED with a time', rows.length === 3 && rows.every(d => d.status === 'DELIVERED' && d.deliveredAt), JSON.stringify(rows.map(d => [d.status, d.deliveredAt])));
  const firstAt = rows[0].deliveredAt!.toISOString();
  const nn2 = await owner.post('/shipping/delivered', { orderIds: [m1.id, m2.id] });
  check('again: nothing new, both counted as already delivered, dates kept', nn2.data?.data?.parcels === 0 && nn2.data?.data?.alreadyDelivered === 2 && (await prisma.dispatch.findUniqueOrThrow({ where: { id: rows[0].id } })).deliveredAt!.toISOString() === firstAt, brief(nn2));
  const nn3 = await sales.post('/shipping/delivered', { orderIds: [m1.id] });
  check('sales (no dispatch:create): 403', nn3.status === 403, brief(nn3));
}

main()
  .catch((e) => { failed++; console.error(e); })
  .finally(async () => {
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
