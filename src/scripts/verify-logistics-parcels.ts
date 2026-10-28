/**
 * Packing for ScaleEzy Logistics (28 Oct), over real HTTP against the local server (4016):
 * staff routes signed in by token cookie (never a password), Logistics' routes with a real signed
 * service token, and the outbox sender run here against a local receiver.
 *
 *   1. Box sizes: the three defaults, and every way a list can be wrong.
 *   2. Packing refused before anything moves: Logistics off, no weight, silly weight, unknown box, no
 *      box, no address, no permission -- stock and the order unchanged each time.
 *   3. Packing: the dispatch (stock leaves, order part/fully sent) and the parcel in one go; the
 *      parcel.ready event carries exactly what Logistics needs; cash only on the first parcel;
 *      a second press is refused.
 *   4. Logistics' updates: wrong ones refused; booked (courier, AWB, label on the dispatch); repeats
 *      harmless; delivered; an older update changes nothing; COD collected recorded once, never more
 *      than owed; another shop's parcel or token refused.
 *   5. The sender: the event reaches Logistics signed, and nothing goes to CRM from parcels.
 *
 * LOCAL DATABASE ONLY, shop verify-suites-tenant (switched on for Logistics for the run, off after).
 *   DATABASE_URL=… DIRECT_URL=… ROLE_TOKENS=<scratchpad>/local-tokens.json IDS=<scratchpad>/local-ids.json npx tsx src/scripts/verify-logistics-parcels.ts
 */
const LOCAL = 'localhost:55433';
if (!String(process.env.DATABASE_URL || '').includes(LOCAL) || !String(process.env.DIRECT_URL || '').includes(LOCAL)) {
  console.error(`Refusing to run: DATABASE_URL and DIRECT_URL must both point at the local copy (${LOCAL}).`);
  process.exit(2);
}
// The sender runs in THIS process: CRM's address blanked so none of the shop's CRM events are sent.
process.env.CRM_EVENTS_URL = '';
process.env.CRM_EVENTS_SECRET = '';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
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
const STAMP = Date.now();

const call = (who: string | null, method: string, path: string, body?: unknown, bearer?: string) =>
  fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json', origin: 'http://localhost:5183',
      ...(who ? { cookie: `token=${tokens[who]}` } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any }));
const svc = (claims: Record<string, unknown> = {}) => jwt.sign({ sub: 'logistics-test', scope: ['modules:logistics'], ...claims }, KEY, { algorithm: 'RS256', keyid: 'test-1', issuer: 'scaleezy-logistics-test', audience: 'inventory', expiresIn: 300 });
const internal = (method: string, path: string, body?: unknown, claims: Record<string, unknown> = {}) => call(null, method, `/internal/modules/logistics${path}`, body, svc(claims));

(async () => {
  const { prisma } = await import('../lib/prisma');
  const { salesOrderService } = await import('../services/sales-order.service');
  const { inventoryMutationService } = await import('../services/inventory-mutation.service');
  const { ModuleOutboxDispatcher } = await import('../services/module-outbox');
  const { sign } = await import('../utils/storefrontSignature');
  const parcelIds: string[] = [];
  const started = new Date();

  const variant = await prisma.productVariant.findFirstOrThrow({ where: { clientId: C, product: { status: 'ACTIVE', trashedAt: null } }, orderBy: { sku: 'asc' }, select: { id: true, sku: true } });
  const onHand = async () => (await prisma.inventoryStock.findFirst({ where: { clientId: C, variantId: variant.id, locationId: ids.locationId } }))?.quantity ?? 0;
  if ((await onHand()) < 50) await inventoryMutationService.applyMovement({ clientId: C, variantId: variant.id, locationId: ids.locationId, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 100, unitCost: 1000, notes: 'verify-logistics-parcels local top-up', createdBy: 'verify-logistics-parcels' } as any);
  const order = async (address: string | null) => {
    const o: any = await salesOrderService.createFullOrder(C, ids.locationId, {
      customer: { id: ids.customerId, ...(address ? { shippingAddress: address } : {}) },
      channel: 'ONLINE', sourceSystem: 'SCALEEZY_SHOP', externalOrderId: `VLP-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
      items: [{ variantId: variant.id, quantity: 2 }]
    }, 'ONLINE');
    await salesOrderService.confirmOrder(C, o.id);
    if (!address) await prisma.salesOrder.update({ where: { id: o.id }, data: { shippingAddress: null } });
    return { id: o.id as string, number: o.orderNumber as string, itemId: o.items[0].id as string };
  };
  const orderState = (id: string) => prisma.salesOrder.findUniqueOrThrow({ where: { id }, select: { status: true, total: true, roundOff: true, payments: { select: { kind: true, amount: true, method: true, reference: true } }, _count: { select: { dispatches: true } } } });

  try {
    console.log('\n1. BOX SIZES');
    await prisma.shippingBox.deleteMany({ where: { clientId: C } });
    await prisma.moduleSubscription.deleteMany({ where: { clientId: C, module: 'logistics' } });
    let r = await call('SUPER_ADMIN', 'GET', '/logistics');
    eq('a shop not on Logistics: off, with the three default boxes', [r.status, r.body?.data?.on, r.body?.data?.boxes?.map((b: any) => [b.name, b.lengthCm, b.breadthCm, b.heightCm])], [200, false, [['Small', 25, 20, 4], ['Medium', 35, 30, 6], ['Large', 45, 35, 10]]]);
    for (const [why, boxes, want] of [
      ['no boxes', [], 'Keep at least one box size.'],
      ['the same name twice', [{ name: 'A', lengthCm: 1, breadthCm: 1, heightCm: 1 }, { name: 'a', lengthCm: 2, breadthCm: 2, heightCm: 2 }], '"a" is there twice.'],
      ['a side of 0', [{ name: 'Flat', lengthCm: 30, breadthCm: 0, heightCm: 2 }], '"Flat": each side between 0.1 and 200 cm.'],
      ['no name', [{ name: '  ', lengthCm: 30, breadthCm: 20, heightCm: 2 }], 'Box 1 needs a name.'],
      ['nine boxes', Array.from({ length: 9 }, (_, i) => ({ name: `B${i}`, lengthCm: 10, breadthCm: 10, heightCm: 10 })), 'Up to 8 box sizes.']
    ] as [string, unknown[], string][]) {
      r = await call('SUPER_ADMIN', 'PUT', '/logistics/boxes', { boxes });
      eq(`boxes refused: ${why}`, [r.status, r.body?.message], [400, want]);
    }
    r = await call('SUPER_ADMIN', 'PUT', '/logistics/boxes', { boxes: [{ name: 'Small', lengthCm: 25, breadthCm: 20, heightCm: 4 }, { name: 'Medium', lengthCm: 35, breadthCm: 30, heightCm: 6 }, { name: 'Large', lengthCm: 45, breadthCm: 35, heightCm: 10 }, { name: 'Saree flat', lengthCm: 40.25, breadthCm: 30, heightCm: 3 }] });
    eq('a fourth box saved, sides to 0.1 cm', [r.status, r.body?.data?.[3]], [200, { id: r.body?.data?.[3]?.id, name: 'Saree flat', lengthCm: 40.3, breadthCm: 30, heightCm: 3 }]);

    console.log('\n2. PACKING REFUSED BEFORE ANYTHING MOVES');
    const o1 = await order('Flat 4, 12-3 Gandhi Road, Vijayawada 520001');
    const stock0 = await onHand();
    const packBody = (extra: any = {}) => ({ salesOrderId: o1.id, items: [{ salesOrderItemId: o1.itemId, quantity: 1 }], box: 'Medium', weightKg: 0.72, ...extra });
    r = await call('SUPER_ADMIN', 'POST', '/logistics/parcels', packBody());
    eq('Logistics off: 409 with what to do instead', [r.status, r.body?.message], [409, 'Logistics is not switched on for this shop. Send the order out as before.']);
    r = await internal('PUT', `/shops/${C}`);
    eq('Logistics switches the shop on', r.status, 200);
    r = await call('SUPER_ADMIN', 'GET', '/logistics');
    eq('the shop now says on', r.body?.data?.on, true);
    for (const [why, extra, want] of [
      ['no weight', { weightKg: undefined }, 'Weigh the parcel and enter its weight in kg.'],
      ['weight 0', { weightKg: 0 }, 'Weigh the parcel and enter its weight in kg.'],
      ['150 kg', { weightKg: 150 }, '150 kg is more than one parcel can be (100 kg). Check the weight.'],
      ['a box the shop does not have', { box: 'Huge' }, 'There is no box called "Huge". Choose one of your box sizes.'],
      ['no box and no sides', { box: undefined }, 'Choose a box, or enter its length, breadth and height in cm.'],
      ['nothing picked', { items: [] }, 'Choose at least one item to send out.']
    ] as [string, any, string][]) {
      r = await call('SUPER_ADMIN', 'POST', '/logistics/parcels', packBody(extra));
      eq(`refused: ${why}`, [r.status, r.body?.message], [400, want]);
    }
    const noAddr = await order(null);
    r = await call('SUPER_ADMIN', 'POST', '/logistics/parcels', { salesOrderId: noAddr.id, items: [{ salesOrderItemId: noAddr.itemId, quantity: 1 }], box: 'Small', weightKg: 0.5 });
    eq('refused: an order with no delivery address', [r.status, r.body?.message], [400, 'This order has no delivery address. Add it on the order, then pack it.']);
    r = await call('SALES', 'POST', '/logistics/parcels', packBody());
    eq('refused: someone who cannot send orders out', r.status, 403);
    eq('after all that: stock, order and dispatches unchanged', [await onHand(), (await orderState(o1.id)).status, (await orderState(o1.id))._count.dispatches, (await orderState(noAddr.id))._count.dispatches], [stock0, 'CONFIRMED', 0, 0]);

    console.log('\n3. PACKING');
    r = await call('SUPER_ADMIN', 'POST', '/logistics/parcels', packBody());
    const p1 = r.body?.data;
    eq('packed: 201, the parcel', [r.status, p1?.status, p1?.box, p1?.weightKg, [p1?.lengthCm, p1?.breadthCm, p1?.heightCm]], [201, 'READY', 'Medium', 0.72, [35, 30, 6]]);
    parcelIds.push(p1?.id);
    const s1 = await orderState(o1.id);
    eq('the dispatch: one piece left the shelf, order part sent', [await onHand(), s1.status, s1._count.dispatches], [stock0 - 1, 'PARTIALLY_DISPATCHED', 1]);
    const ev = await prisma.moduleEvent.findMany({ where: { clientId: C, module: 'logistics', createdAt: { gte: started } } });
    eq('one parcel.ready for Logistics, about this parcel', ev.map(e => [e.kind, e.sourceTable, e.rowId]), [['parcel.ready', 'logistics_parcels', p1?.id]]);
    const pay = ev[0]?.payload as any;
    const total = Number(s1.total) + Number(s1.roundOff ?? 0);
    eq('payload: who, where, how much to collect', [pay?.parcel_id, pay?.order_number, pay?.customer?.address, pay?.payment], [p1?.id, o1.number, { text: 'Flat 4, 12-3 Gandhi Road, Vijayawada 520001', pincode: '520001' }, { method: 'COD', cod_amount: total }]);
    eq('payload: the item in THIS parcel (1 of 2) and the package', [pay?.items?.map((i: any) => [i.sku, i.units]), [pay?.package?.box, pay?.package?.length_cm, pay?.package?.breadth_cm, pay?.package?.height_cm, pay?.package?.weight_kg], typeof pay?.packed_by, pay?.pickup?.location_id], [[[variant.sku, 1]], ['Medium', 35, 30, 6, 0.72], 'string', ids.locationId]);
    check('payload: a phone for the courier', typeof pay?.customer?.phone === 'string' && pay.customer.phone.length >= 10, pay?.customer);
    r = await call('SUPER_ADMIN', 'POST', '/logistics/parcels', { ...packBody(), box: undefined, lengthCm: 40, breadthCm: 30, heightCm: 3, weightKg: 0.65 });
    const p2 = r.body?.data;
    parcelIds.push(p2?.id);
    eq('the second piece, in a box sized by hand: order now fully sent', [r.status, p2?.box, (await orderState(o1.id)).status], [201, null, 'DISPATCHED']);
    const ev2 = await prisma.moduleEvent.findFirst({ where: { clientId: C, module: 'logistics', rowId: p2?.id } });
    eq('the second parcel carries no cash (collected with the first)', (ev2?.payload as any)?.payment, { method: 'PREPAID', cod_amount: 0 });
    r = await call('SUPER_ADMIN', 'POST', '/logistics/parcels', packBody());
    eq('packed again (a double press): refused, nothing more leaves', [r.status, await onHand()], [409, stock0 - 2]);

    console.log('\n4. WHAT LOGISTICS SENDS BACK');
    const up = (parcelId: string, body: any, claims = {}) => internal('POST', `/shops/${C}/parcels/${parcelId}/updates`, body, claims);
    r = await up(p1.id, { status: 'SHIPPED' });
    check('an unknown status: 400 with the list', r.status === 400 && /^status must be one of BOOKED/.test(r.body?.message), r.body);
    r = await up(p1.id, { status: 'BOOKED', label_url: 'http://insecure.example/l.pdf' });
    eq('a label that is not https: 400', [r.status, r.body?.message], [400, 'label_url must be an https address.']);
    r = await up(p1.id, { status: 'BOOKED', at: new Date(Date.now() + 3600_000).toISOString() });
    eq('a date in the future: 400', [r.status, r.body?.message], [400, 'at is in the future.']);
    r = await up(p1.id, { status: 'BOOKED', cod_collected: -5 });
    eq('a negative cash amount: 400', [r.status, r.body?.message], [400, 'cod_collected must be an amount in rupees.']);
    const t0 = new Date(Date.now() - 60_000).toISOString(), t1 = new Date(Date.now() - 30_000).toISOString(), tMid = new Date(Date.now() - 45_000).toISOString();
    r = await up(p1.id, { status: 'BOOKED', at: t0, courier: 'Delhivery', awb: `AWB${STAMP}`, tracking_url: 'https://track.example/1', label_url: 'https://labels.example/1.pdf' });
    eq('booked: applied', [r.status, r.body?.data?.applied, r.body?.data?.parcel?.status, r.body?.data?.parcel?.labelUrl], [200, true, 'BOOKED', 'https://labels.example/1.pdf']);
    let d1 = await prisma.dispatch.findUniqueOrThrow({ where: { id: p1.dispatchId } });
    eq('the dispatch now has the courier and number (the order page reads these)', [d1.courierName, d1.trackingNumber, d1.trackingUrl, d1.status], ['Delhivery', `AWB${STAMP}`, 'https://track.example/1', 'SHIPPED']);
    r = await call('SUPER_ADMIN', 'GET', `/logistics/parcels?orderIds=${o1.id}`);
    eq('the packing screen sees the label', r.body?.data?.map((x: any) => [x.id, x.labelUrl]), [[p1.id, 'https://labels.example/1.pdf'], [p2.id, null]]);
    r = await up(p1.id, { status: 'BOOKED', at: t0, courier: 'Delhivery', awb: `AWB${STAMP}` });
    eq('the same update again: not applied twice', r.body?.data?.applied, false);
    r = await up(p1.id, { status: 'DELIVERED', at: t1 });
    d1 = await prisma.dispatch.findUniqueOrThrow({ where: { id: p1.dispatchId } });
    eq('delivered: on the dispatch with its date', [r.body?.data?.parcel?.status, d1.status, d1.deliveredAt?.toISOString()], ['DELIVERED', 'DELIVERED', t1]);
    r = await up(p1.id, { status: 'IN_TRANSIT', at: tMid });
    d1 = await prisma.dispatch.findUniqueOrThrow({ where: { id: p1.dispatchId } });
    eq('an older update arriving late: kept in the history, changes nothing', [r.body?.data?.older, r.body?.data?.parcel?.status, d1.status], [true, 'DELIVERED', 'DELIVERED']);
    r = await up(p1.id, { status: 'DELIVERED', at: t1, cod_collected: total + 500 });
    // A new entry (same status and time but carrying the cash): applied, and the cash recorded.
    let s2 = await orderState(o1.id);
    const cod = s2.payments.filter(x => x.reference === `COD AWB${STAMP}`);
    eq('COD collected: one payment, capped at what was owed', [r.body?.data?.codRecorded, cod.length, Number(cod[0]?.amount), cod[0]?.method], [true, 1, total, 'BANK_TRANSFER']);
    r = await up(p1.id, { status: 'DELIVERED', at: new Date().toISOString(), cod_collected: total });
    s2 = await orderState(o1.id);
    eq('the cash reported again: still one payment', s2.payments.filter(x => x.reference === `COD AWB${STAMP}`).length, 1);
    const hist = (await prisma.logisticsParcel.findUniqueOrThrow({ where: { id: p1.id } })).history as any[];
    eq('the history keeps every update in arrival order', hist.map(h => h.status), ['BOOKED', 'DELIVERED', 'IN_TRANSIT', 'DELIVERED', 'DELIVERED']);
    r = await up('00000000-0000-0000-0000-000000000000', { status: 'BOOKED' });
    eq('a parcel that is not this shop\'s: 404', [r.status, r.body?.message], [404, 'No such parcel in this shop.']);
    r = await up(p1.id, { status: 'BOOKED' }, { clientId: 'some-other-shop' });
    eq('a token made for another shop: 403', r.status, 403);

    console.log('\n5. THE SENDER');
    const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const rx = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push({ headers: req.headers, body: b }); res.writeHead(200); res.end('{}'); }); });
    await new Promise<void>(ok => rx.listen(0, '127.0.0.1', () => ok()));
    process.env.LOGISTICS_EVENTS_URL = `http://127.0.0.1:${(rx.address() as AddressInfo).port}/inbox`;
    process.env.LOGISTICS_EVENTS_SECRET = 'local-logistics-secret';
    const before = await prisma.moduleEvent.count({ where: { clientId: C, module: 'crm', status: 'DELIVERED' } });
    await ModuleOutboxDispatcher.runOnce({ onlyClients: [C] });
    rx.close();
    const batch = got[0] ? JSON.parse(got[0].body) : null;
    eq('Logistics received one signed batch with both parcels, in order', [got.length, batch?.module, batch?.events?.map((e: any) => [e.kind, e.payload?.parcel_id])], [1, 'logistics', [['parcel.ready', p1.id], ['parcel.ready', p2.id]]]);
    eq('the signature is right', got[0]?.headers['x-inventory-signature'], got[0] ? sign('local-logistics-secret', Number(got[0].headers['x-inventory-timestamp']), got[0].body) : null);
    eq('nothing was sent to CRM (no address in this process), and no CRM event came from parcels', [await prisma.moduleEvent.count({ where: { clientId: C, module: 'crm', status: 'DELIVERED' } }) - before, await prisma.moduleEvent.count({ where: { clientId: C, sourceTable: 'logistics_parcels', module: { not: 'logistics' } } })], [0, 0]);
  } catch (e: any) {
    console.error(e);
    check(`the suite reached the end (stopped at: ${String(e?.message ?? e).trim().split('\n')[0]})`, false);
  } finally {
    await prisma.moduleEvent.deleteMany({ where: { clientId: C, module: 'logistics', createdAt: { gte: started } } }).catch(e => console.log('left events', e.message));
    await prisma.logisticsParcel.deleteMany({ where: { id: { in: parcelIds.filter(Boolean) } } }).catch(e => console.log('left parcels', e.message));
    await prisma.moduleSubscription.deleteMany({ where: { clientId: C, module: 'logistics' } }).catch(e => console.log('left subscription', e.message));
    await prisma.shippingBox.deleteMany({ where: { clientId: C } }).catch(e => console.log('left boxes', e.message));
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED: ' + failures.join(' | '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
})();
