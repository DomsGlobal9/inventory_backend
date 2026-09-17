/**
 * A whole day in a boutique that uses shelves, every flow that moves stock, done by the people who do
 * it, through the API -- and after every step, three things that must agree:
 *
 *   rule      no shelf holds more than its location, none is below zero
 *   ledger    for every item at every location, the ledger adds up to the stock on hand
 *   shelves   for every shelf, its movement legs add up to what it holds now
 *
 * If shelves, sales, receipts, returns, transfers, counts, picking and the day book did not "speak to
 * each other", one of those would break. Then a storm of mixed operations by several people at once,
 * and the worst cases.
 *
 *   npx tsx src/scripts/verify-shelves-shop-day.ts      (high-limit config)
 */
import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { stockCountService } from '../services/stock-count.service';
import { returnService } from '../services/return.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `shelfday-${STAMP}`;
const OTHER = `shelfday-other-${STAMP}`;

let passed = 0;
const failures: string[] = [];
const serverErrors: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; if (!process.env.QUIET) console.log(`  ok   ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
};
const brief = (r: any) => `${r?.status} ${JSON.stringify(r?.data).slice(0, 220)}`;
const leaks = (r: any) => /prisma|Invalid `|P20\d\d|storage_spot_tree|shelf_stock_exceeds|spot_stock:|at [A-Za-z]+ \(/i.test(JSON.stringify(r?.data ?? ''));

function api(token: string, locationId?: string): AxiosInstance {
  const a = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}`, ...(locationId ? { 'x-location-id': locationId } : {}) }, validateStatus: () => true, timeout: 120_000 });
  a.interceptors.response.use(r => { if (r.status >= 500) serverErrors.push(`${r.config.method?.toUpperCase()} ${r.config.url} -> ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); return r; });
  return a;
}
async function person(clientId: string, name: string, roleId: string) {
  const u = await prisma.user.create({ data: { clientId, email: `day-${name.toLowerCase()}-${clientId}@example.com`, name, password: 'unused', status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, token: AuthService.generateToken({ userId: u.id, clientId }) };
}

/** The three cross-checks. Returns a description of anything that disagrees. */
async function agree(label: string) {
  const rule = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (
      SELECT ss.variant_id, ss.location_id, SUM(ss.quantity) AS shelved, MAX(s.quantity) AS official, MIN(ss.quantity) AS lowest
      FROM spot_stocks ss LEFT JOIN inventory_stocks s ON s.variant_id = ss.variant_id AND s.location_id = ss.location_id
      WHERE ss.client_id = ${SHOP} GROUP BY ss.variant_id, ss.location_id
      HAVING SUM(ss.quantity) > COALESCE(MAX(s.quantity), 0) OR MIN(ss.quantity) < 0) t`;
  const ledger = await prisma.$queryRaw<{ variant_id: string; location_id: string; ledger: bigint; stock: number }[]>`
    SELECT s.variant_id, s.location_id, COALESCE(SUM(t.quantity), 0) AS ledger, s.quantity AS stock
    FROM inventory_stocks s LEFT JOIN inventory_transactions t ON t.variant_id = s.variant_id AND t.location_id = s.location_id
    WHERE s.client_id = ${SHOP} GROUP BY s.variant_id, s.location_id, s.quantity
    HAVING COALESCE(SUM(t.quantity), 0) <> s.quantity`;
  const shelves = await prisma.$queryRaw<{ spot_id: string; variant_id: string; legs: bigint; held: bigint }[]>`
    SELECT COALESCE(l.spot_id, ss.spot_id) AS spot_id, COALESCE(l.variant_id, ss.variant_id) AS variant_id,
           COALESCE(l.legs, 0) AS legs, COALESCE(ss.quantity, 0) AS held
    FROM (SELECT spot_id, variant_id, SUM(quantity) AS legs FROM inventory_transaction_spots WHERE client_id = ${SHOP} AND spot_id IS NOT NULL GROUP BY spot_id, variant_id) l
    FULL OUTER JOIN (SELECT spot_id, variant_id, quantity FROM spot_stocks WHERE client_id = ${SHOP}) ss
      ON ss.spot_id = l.spot_id AND ss.variant_id = l.variant_id
    WHERE COALESCE(l.legs, 0) <> COALESCE(ss.quantity, 0)`;
  const problems = [
    Number(rule[0].n) ? `${rule[0].n} rule breaks` : '',
    ledger.length ? `ledger: ${ledger.map(l => `${l.ledger} vs ${l.stock}`).join(', ')}` : '',
    shelves.length ? `shelf legs: ${shelves.map(s => `${s.legs} vs ${s.held}`).join(', ')}` : ''
  ].filter(Boolean).join(' | ');
  check(`${label}: rule, ledger and shelf legs all agree`, !problems, problems);
}

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const rolesB = await seedRolesForClient(OTHER);
  await prisma.clientSettings.create({ data: { clientId: SHOP, businessName: 'Day Test Sarees' } });
  const ownerU = await person(SHOP, 'Owner', roles.SUPER_ADMIN);
  const managerU = await person(SHOP, 'Manager', roles.INVENTORY_MANAGER);
  const warehouseU = await person(SHOP, 'Warehouse', roles.WAREHOUSE);
  const sales1U = await person(SHOP, 'SalesOne', roles.SALES);
  const sales2U = await person(SHOP, 'SalesTwo', roles.SALES);
  const intruderU = await person(OTHER, 'Intruder', rolesB.SUPER_ADMIN);

  const store = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE', active: true } });
  const godown = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Godown', code: 'GODOWN', type: 'WAREHOUSE', active: true } });
  const owner = api(ownerU.token, store.id), manager = api(managerU.token, store.id), warehouse = api(warehouseU.token, store.id);
  const sales1 = api(sales1U.token, store.id), sales2 = api(sales2U.token, store.id), intruder = api(intruderU.token);
  const supplier = await prisma.supplier.create({ data: { clientId: SHOP, supplierCode: `SUP-DAY-${STAMP}`, name: 'Day Weavers' } as any });
  const product = await prisma.product.create({ data: { clientId: SHOP, title: 'Silk Saree', productCode: `DAY-${STAMP}`, slug: `day-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1000, status: 'ACTIVE' } });
  const mk = (c: string) => prisma.productVariant.create({ data: { clientId: SHOP, productId: product.id, sku: `DAY-${c}-${STAMP}`, variantCode: `V-DAY-${c}-${STAMP}`, colorName: c, size: 'Free', sellingPrice: 1000, costPrice: 600, averageCost: 600, barcode: `66${c}${STAMP}` } });
  const red = await mk('RED'), blue = await mk('BLUE'), gold = await mk('GOLD');
  const walkIn = await prisma.customer.create({ data: { clientId: SHOP, customerCode: `CUS-DAY-${STAMP}`, name: 'Walk In', phone: `+917${String(STAMP).slice(-9)}`, status: 'ACTIVE' } });

  const spot = (address: string, locationId = store.id) => prisma.storageSpot.findFirstOrThrow({ where: { clientId: SHOP, locationId, address } });
  const onShelf = async (address: string, variantId: string, locationId = store.id) => (await prisma.spotStock.findFirst({ where: { variantId, spot: { address, locationId } } }))?.quantity ?? 0;
  const official = async (variantId: string, locationId = store.id) => (await prisma.inventoryStock.findUnique({ where: { variantId_locationId: { variantId, locationId } } }))?.quantity ?? 0;
  const notShelved = async (variantId: string, locationId = store.id) => (await official(variantId, locationId)) - ((await prisma.spotStock.aggregate({ where: { variantId, locationId }, _sum: { quantity: true } }))._sum.quantity ?? 0);

  // ── 1. Morning: the layout ─────────────────────────────────────────────────────────────────
  console.log('\n1. SETTING UP THE SHOP');
  const imported = await manager.post(`/shelves/locations/${store.id}/spots/import`, { rows: [
    { address: 'FLOOR-C1-1', name: 'Silk', shopFloor: 'yes' }, { address: 'FLOOR-C1-2', shopFloor: 'yes' },
    { address: 'FLOOR-C2-1', shopFloor: 'yes' }, { address: 'STORE-R1-1', shopFloor: 'no' }, { address: 'STORE-R1-2', shopFloor: 'no' }
  ] });
  const godownBulk = await manager.post(`/shelves/locations/${godown.id}/spots/bulk`, { levels: [{ kind: 'AREA', range: { codes: ['GD'] } }, { kind: 'RACK', range: { from: 1, to: 2, prefix: 'R' } }, { kind: 'SHELF', range: { from: 1, to: 2 } }] });
  const labels = await manager.get(`/shelves/locations/${store.id}/labels`);
  check('the manager imports the store layout, quick-creates the godown, and gets labels', imported.status === 201 && imported.data.data.create === 10 && godownBulk.status === 201 && godownBulk.data.data.create === 7 && labels.status === 200 && labels.data.data.length === 10, `${brief(imported)} | ${brief(godownBulk)}`);
  const labelOf = (address: string) => labels.data.data.find((l: any) => l.address === address)?.qr;

  // ── 2. Goods arrive ─────────────────────────────────────────────────────────────────────────
  console.log('\n2. GOODS ARRIVE AND GO ON SHELVES');
  const po = await manager.post('/purchase-orders', { supplierId: supplier.id, items: [{ variantId: red.id, orderedQty: 20, unitPrice: 600 }, { variantId: blue.id, orderedQty: 10, unitPrice: 600 }, { variantId: gold.id, orderedQty: 6, unitPrice: 600 }] });
  await manager.put(`/purchase-orders/${po.data.data.id}/status`, { status: 'SENT' });
  const poItem = (v: string) => po.data.data.items.find((i: any) => i.variantId === v).id;
  const received = await warehouse.post(`/purchase-orders/${po.data.data.id}/receive`, { receipts: [{ poItemId: poItem(red.id), quantityReceived: 20 }, { poItemId: poItem(blue.id), quantityReceived: 10 }, { poItemId: poItem(gold.id), quantityReceived: 6 }], locationId: store.id, receivedByName: 'Warehouse', requestKey: crypto.randomUUID() });
  const waiting = await warehouse.get(`/shelves/locations/${store.id}/not-shelved`);
  check('the delivery is received, and all of it waits to be put away', received.status === 200 && waiting.data.data.items.map((i: any) => i.notShelved).sort((a: number, b: number) => a - b).join() === '6,10,20', `${brief(received)} | ${brief(waiting)}`);
  for (const [variantId, spotAddress, quantity] of [[red.id, 'FLOOR-C1-1', 8], [red.id, 'STORE-R1-1', 8], [blue.id, 'FLOOR-C2-1', 6], [gold.id, 'FLOOR-C1-2', 6]] as const) {
    const scanned = await warehouse.get('/shelves/spots/scan', { params: { code: labelOf(spotAddress) } });
    const put = await warehouse.post('/shelves/putaway', { locationId: store.id, variantId, spotId: scanned.data.data.spot.id, quantity });
    if (put.status !== 200) check(`put away ${quantity} on ${spotAddress}`, false, brief(put));
  }
  check('put away by scanning labels: red 8 floor + 8 back, blue 6, gold 6; red 4 and blue 4 still not shelved', await onShelf('FLOOR-C1-1', red.id) === 8 && await onShelf('STORE-R1-1', red.id) === 8 && await notShelved(red.id) === 4 && await notShelved(blue.id) === 4 && await notShelved(gold.id) === 0);
  const poPage = await manager.get(`/purchase-orders/${po.data.data.id}`);
  check('the purchase order still reads fully received, and nothing on it mentions shelves or broke', poPage.status === 200 && poPage.data.data.status === 'RECEIVED', brief(poPage));
  await agree('after receiving and putting away');

  // ── 3. Transfer to the godown ──────────────────────────────────────────────────────────────
  console.log('\n3. A TRANSFER TO THE GODOWN');
  const r11 = await spot('STORE-R1-1');
  const transfer = await manager.post('/inventory-transfers', { originLocationId: store.id, destinationLocationId: godown.id, items: [{ variantId: red.id, quantity: 5, fromSpots: [{ spotId: r11.id, quantity: 5 }] }] });
  const gd11 = await spot('GD-R1-1', godown.id);
  const gdPut = await api(warehouseU.token, godown.id).post('/shelves/putaway', { locationId: godown.id, variantId: red.id, spotId: gd11.id, quantity: 5 });
  check('5 red leave STORE-R1-1 for the godown and are put away on GD-R1-1', transfer.status < 300 && gdPut.status === 200 && await onShelf('STORE-R1-1', red.id) === 3 && await onShelf('GD-R1-1', red.id, godown.id) === 5 && await official(red.id, godown.id) === 5, `${brief(transfer)} | ${brief(gdPut)}`);
  await agree('after the transfer');

  // ── 4. The shop opens: counter sales, and a move at the same moment ─────────────────────────
  console.log('\n4. COUNTER SALES WHILE STOCK IS MOVED');
  const sell = async (who: AxiosInstance, variantId: string, quantity: number) => {
    const q = await who.post('/pricing/quote', { locationId: store.id, channel: 'POS', customerId: walkIn.id, lines: [{ variantId, quantity }] });
    return who.post('/counter-sales', { saleId: crypto.randomUUID(), locationId: store.id, quoteId: q.data?.data?.quoteId, customer: { id: walkIn.id }, items: [{ variantId, quantity }], payments: [{ method: 'CASH', amount: q.data?.data?.total }] });
  };
  const c21 = await spot('FLOOR-C2-1'), r12 = await spot('STORE-R1-2');
  const [saleRed, saleBlue, moveBlue] = await Promise.all([
    sell(api(sales1U.token, store.id), red.id, 3),
    sell(api(sales2U.token, store.id), blue.id, 2),
    warehouse.post('/shelves/move', { locationId: store.id, variantId: blue.id, fromSpotId: c21.id, toSpotId: r12.id, quantity: 2 })
  ]);
  check('two salespeople sell at once while the stock room moves blue: all three succeed or say why', saleRed.status === 201 && saleBlue.status === 201 && [200, 409].includes(moveBlue.status) && !leaks(moveBlue), `${brief(saleRed)} | ${brief(saleBlue)} | ${brief(moveBlue)}`);
  check('red sold from the shop floor (FLOOR-C1-1 8 -> 5), the back room untouched', await onShelf('FLOOR-C1-1', red.id) === 5 && await onShelf('STORE-R1-1', red.id) === 3);
  check('blue: sale took 2 off the floor, the move worked with what was left, and the total is right', await official(blue.id) === 8 && (await onShelf('FLOOR-C2-1', blue.id)) + (await onShelf('STORE-R1-2', blue.id)) + await notShelved(blue.id) === 8);
  const find = await sales1.get('/counter-sales/items', { params: { q: `66RED${STAMP}`, locationId: store.id } });
  check('the next customer asks for red: New sale search says FLOOR-C1-1 · 5 first', find.data?.data?.items?.[0]?.shelves?.[0]?.address === 'FLOOR-C1-1' && find.data.data.items[0].shelves[0].quantity === 5, brief(find));
  await agree('after counter sales and a concurrent move');

  // ── 5. An online order: pick and send ──────────────────────────────────────────────────────
  console.log('\n5. AN ONLINE ORDER IS PICKED AND SENT');
  const quote = await owner.post('/pricing/quote', { locationId: store.id, channel: 'POS', customerId: walkIn.id, lines: [{ variantId: red.id, quantity: 7 }, { variantId: gold.id, quantity: 2 }] });
  const order = await owner.post('/sales-orders/full', { locationId: store.id, quoteId: quote.data?.data?.quoteId, customer: { id: walkIn.id }, items: [{ variantId: red.id, quantity: 7 }, { variantId: gold.id, quantity: 2 }], status: 'CONFIRMED' });
  const orderId = order.data?.id ?? order.data?.data?.id;
  const pick = await warehouse.get('/shelves/pick/list', { params: { locationId: store.id, orderIds: orderId } });
  const stops = pick.data?.data?.stops ?? [];
  check('the pick list walks FLOOR-C1-1 (red 5), FLOOR-C1-2 (gold 2), STORE-R1-1 (red 2)', pick.status === 200 && stops.map((s: any) => `${s.address}:${s.picks.map((p: any) => p.quantity).join('+')}`).join() === 'FLOOR-C1-1:5,FLOOR-C1-2:2,STORE-R1-1:2' && pick.data.data.short.length === 0, String(JSON.stringify(pick.data)).slice(0, 400));
  const orderItems = await prisma.salesOrderItem.findMany({ where: { salesOrderId: orderId } });
  const itemFor = (v: string) => orderItems.find(i => i.variantId === v)!.id;
  const legsFor = (v: string) => stops.flatMap((s: any) => s.picks.filter((p: any) => p.item.variantId === v).map((p: any) => ({ spotId: s.spotId, quantity: p.quantity })));
  const sent = await warehouse.post('/dispatches', { salesOrderId: orderId, items: [{ salesOrderItemId: itemFor(red.id), quantity: 7, fromSpots: legsFor(red.id) }, { salesOrderItemId: itemFor(gold.id), quantity: 2, fromSpots: legsFor(gold.id) }] });
  check('sent out exactly as picked: FLOOR-C1-1 0, STORE-R1-1 1, gold 4 left; no back-room issue', sent.status === 201 && await onShelf('FLOOR-C1-1', red.id) === 0 && await onShelf('STORE-R1-1', red.id) === 1 && await onShelf('FLOOR-C1-2', gold.id) === 4 && (await prisma.shelfIssue.count({ where: { clientId: SHOP, kind: 'SOLD_FROM_BACK_ROOM' } })) === 0, brief(sent));
  const orderShelves = await owner.get('/shelves/movements', { params: { referenceType: 'ORDER', referenceIds: orderId } });
  check('the order page can show both items with their shelves', orderShelves.status === 200 && orderShelves.data.data.length === 2, brief(orderShelves));
  const orderPage = await owner.get(`/sales-orders/${orderId}`);
  const orderBody = orderPage.data?.data ?? orderPage.data;
  check('the order reads DISPATCHED with every line fulfilled', orderPage.status === 200 && orderBody?.status === 'DISPATCHED' && orderBody.items.every((i: any) => i.fulfilledQty === i.quantity), brief(orderPage));
  await agree('after picking and dispatching');

  // ── 6. A customer brings one back ─────────────────────────────────────────────────────────
  console.log('\n6. A RETURN');
  const dispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: orderId }, include: { items: true } });
  const redDispatchItem = dispatch.items.find(d => d.salesOrderItemId === itemFor(red.id))!;
  const ret: any = await returnService.createReturn(SHOP, orderId, [{ dispatchItemId: redDispatchItem.id, quantity: 1 }], 'Wrong colour');
  await returnService.receiveReturn(SHOP, ret.id);
  await returnService.inspectReturn(SHOP, ret.id, ret.items.map((i: any) => ({ salesReturnItemId: i.id, disposition: 'RESTOCK' as const })));
  await returnService.completeReturn(SHOP, ret.id);
  const back = await warehouse.get(`/shelves/locations/${store.id}/not-shelved`);
  // 4 never put away this morning, plus the 1 that came back.
  check('the returned red is back in stock and waiting to be put away (not on a shelf by magic)', back.data.data.items.some((i: any) => i.variantId === red.id && i.notShelved === 5), brief(back));
  const c11 = await spot('FLOOR-C1-1');
  const reshelve = await warehouse.post('/shelves/putaway', { locationId: store.id, variantId: red.id, spotId: c11.id, quantity: 2 });
  check('it goes back on FLOOR-C1-1', reshelve.status === 200 && await onShelf('FLOOR-C1-1', red.id) === 2, brief(reshelve));
  await agree('after the return');

  // ── 7. Damage, a count, a shelf count ──────────────────────────────────────────────────────
  console.log('\n7. DAMAGE, A STOCK COUNT, A SHELF COUNT');
  const c12 = await spot('FLOOR-C1-2');
  const damage = await manager.post('/inventory/stock-out', { variantId: gold.id, quantity: 1, reason: 'DAMAGE', locationId: store.id, fromSpots: [{ spotId: c12.id, quantity: 1 }] });
  check('one gold damaged, taken from the shelf the manager chose', damage.status < 300 && await onShelf('FLOOR-C1-2', gold.id) === 3, brief(damage));
  const count = await stockCountService.createCount(SHOP, `Godown ${STAMP}`, godown.id, undefined, managerU.id);
  await stockCountService.startCount(SHOP, count.id);
  for (const item of await prisma.stockCountItem.findMany({ where: { stockCountId: count.id } })) {
    await stockCountService.updateItemCount(SHOP, count.id, item.id, item.variantId === red.id ? 4 : item.expectedQty);
  }
  await stockCountService.completeCount(SHOP, count.id, managerU.id);
  check('the godown count finds 4 red where the shelf said 5: GD-R1-1 is 4 and it is raised', await onShelf('GD-R1-1', red.id, godown.id) === 4 && await official(red.id, godown.id) === 4 && (await prisma.shelfIssue.count({ where: { clientId: SHOP, kind: 'COUNT_BELOW_SHELVES', locationId: godown.id } })) === 1);
  const shelfCount = await warehouse.post(`/shelves/spots/${c12.id}/count`, { counts: [{ variantId: gold.id, counted: 2 }], complete: true });
  check('the stock room counts FLOOR-C1-2 and finds 2 gold of 3: shelf 2, 1 not shelved, raised', shelfCount.status === 200 && await onShelf('FLOOR-C1-2', gold.id) === 2 && await notShelved(gold.id) === 1 && shelfCount.data.data.issues === 1, brief(shelfCount));
  await agree('after damage and counts');

  // ── 8. End of day: the manager tidies up ───────────────────────────────────────────────────
  console.log('\n8. END OF DAY');
  const c1 = await spot('FLOOR-C1');
  const readdress = await manager.patch(`/shelves/spots/${c1.id}`, { code: 'C01', name: 'Silk wall' });
  const oldLabel = await warehouse.get('/shelves/spots/scan', { params: { code: labelOf('FLOOR-C1-1') } });
  check('cupboard C1 becomes C01; the label printed this morning still opens FLOOR-C01-1', readdress.status === 200 && oldLabel.data?.data?.spot?.address === 'FLOOR-C01-1', `${brief(readdress)} | ${brief(oldLabel)}`);
  const issues = await manager.get('/shelves/issues');
  check('the manager sees the day\'s open issues (godown count, shelf count)', issues.status === 200 && issues.data.data.open === 2, brief(issues));
  for (const issue of issues.data.data.issues) await manager.post(`/shelves/issues/${issue.id}/resolve`, { note: 'Checked at closing' });
  check('and resolves them with a note', (await prisma.shelfIssue.count({ where: { clientId: SHOP, status: 'OPEN' } })) === 0);
  const daybook = await owner.get('/daybook', { params: { date: new Date().toISOString().slice(0, 10), locationId: store.id } });
  const dayText = JSON.stringify(daybook.data);
  check('the day book opens and never mentions a shelf move', daybook.status === 200 && !/SHELF_MOVE|shelf move/i.test(dayText), brief(daybook));
  const ledgerPage = await manager.get('/inventory/transactions', { params: { variantId: red.id } });
  check('the stock ledger lists receipts, sales, transfers and returns but not shelf moves', ledgerPage.status === 200 && !JSON.stringify(ledgerPage.data).includes('SHELF_MOVE'), brief(ledgerPage));
  await agree('at the end of the day');

  // ── 9. A storm: everyone at once ───────────────────────────────────────────────────────────
  console.log('\n9. EVERYONE AT ONCE (80 mixed operations, 8 at a time)');
  const spots = await prisma.storageSpot.findMany({ where: { clientId: SHOP, locationId: store.id, children: { none: {} }, active: true } });
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const variants = [red, blue, gold];
  const ops: (() => Promise<any>)[] = [];
  for (let i = 0; i < 80; i++) {
    const v = variants[rnd(3)];
    const a = spots[rnd(spots.length)], b = spots[rnd(spots.length)];
    const kind = rnd(7);
    ops.push(async () => {
      switch (kind) {
        case 0: return warehouse.post('/shelves/putaway', { locationId: store.id, variantId: v.id, spotId: a.id, quantity: 1 + rnd(2) });
        case 1: return warehouse.post('/shelves/move', { locationId: store.id, variantId: v.id, fromSpotId: a.id, toSpotId: a.id === b.id ? undefined : b.id, quantity: 1 });
        case 2: return owner.post('/inventory/stock-in', { variantId: v.id, quantity: 1 + rnd(3), reason: 'PURCHASE', unitCost: 600, locationId: store.id });
        case 3: return manager.post('/inventory/stock-out', { variantId: v.id, quantity: 1, reason: 'DAMAGE', locationId: store.id });
        case 4: return sell(api(sales1U.token, store.id), v.id, 1);
        case 5: return warehouse.post(`/shelves/spots/${a.id}/count`, { counts: [{ variantId: v.id, counted: rnd(4) }] });
        default: return manager.post('/inventory/stock-out', { variantId: v.id, quantity: 1, reason: 'SAMPLE', locationId: store.id, fromSpots: [{ spotId: a.id, quantity: 1 }] });
      }
    });
  }
  const statuses: number[] = [];
  for (let i = 0; i < ops.length; i += 8) {
    const batch = await Promise.all(ops.slice(i, i + 8).map(op => op().catch((e: any) => ({ status: 0, data: { message: e?.message } }))));
    statuses.push(...batch.map((r: any) => r.status));
  }
  const refusedInWords = statuses.filter(s => s >= 400 && s < 500).length;
  check(`80 mixed operations by five people: no server error (${statuses.filter(s => s < 300).length} done, ${refusedInWords} refused in words)`, !statuses.some(s => s >= 500 || s === 0), statuses.join(','));
  await agree('after the storm');

  // ── 10. Worst cases ────────────────────────────────────────────────────────────────────────
  console.log('\n10. WORST CASES');
  // A dispatch naming another shop's shelf, or more than it picks: refused and atomic.
  const quote2 = await owner.post('/pricing/quote', { locationId: store.id, channel: 'POS', customerId: walkIn.id, lines: [{ variantId: blue.id, quantity: 1 }] });
  const order2 = await owner.post('/sales-orders/full', { locationId: store.id, quoteId: quote2.data?.data?.quoteId, customer: { id: walkIn.id }, items: [{ variantId: blue.id, quantity: 1 }], status: 'CONFIRMED' });
  const order2Id = order2.data?.id ?? order2.data?.data?.id;
  const item2 = (await prisma.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: order2Id } })).id;
  const otherShop = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Theirs', code: 'T', type: 'STORE', active: true } });
  const foreign = await prisma.storageSpot.create({ data: { clientId: OTHER, locationId: otherShop.id, kind: 'AREA', code: 'X', address: 'X', depth: 1, labelCode: `FRGN${String(STAMP).slice(-8)}` } });
  const godownShelf = await spot('GD-R1-2', godown.id);
  const beforeBlue = await official(blue.id);
  const bad = await Promise.all([
    warehouse.post('/dispatches', { salesOrderId: order2Id, items: [{ salesOrderItemId: item2, quantity: 1, fromSpots: [{ spotId: foreign.id, quantity: 1 }] }] }),
    warehouse.post('/dispatches', { salesOrderId: order2Id, items: [{ salesOrderItemId: item2, quantity: 1, fromSpots: [{ spotId: godownShelf.id, quantity: 1 }] }] }),
    warehouse.post('/dispatches', { salesOrderId: order2Id, items: [{ salesOrderItemId: item2, quantity: 1, fromSpots: [{ spotId: c21.id, quantity: 2 }] }] }),
    warehouse.post('/dispatches', { salesOrderId: order2Id, items: [{ salesOrderItemId: item2, quantity: 1, fromSpots: 'everywhere' }] })
  ]);
  const order2After = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order2Id }, include: { items: true } });
  check('a dispatch naming another shop\'s shelf, a godown shelf, too many pieces or nonsense: refused in words, and nothing was sent', bad.every(r => r.status >= 400 && r.status < 500 && !leaks(r)) && order2After.status === 'CONFIRMED' && order2After.items[0].fulfilledQty === 0 && await official(blue.id) === beforeBlue && (await prisma.dispatch.count({ where: { salesOrderId: order2Id } })) === 0, bad.map(brief).join(' | '));

  // Someone switched off mid-shift.
  await owner.patch(`/team/members/${warehouseU.id}/status`, { status: 'INACTIVE' });
  const fired = await warehouse.post('/shelves/putaway', { locationId: store.id, variantId: blue.id, spotId: c21.id, quantity: 1 });
  check('a stock room worker switched off mid-shift cannot put anything away (401)', fired.status === 401, brief(fired));
  await owner.patch(`/team/members/${warehouseU.id}/status`, { status: 'ACTIVE' });
  // Switching them off ended every sign-in they had; switching back on does not revive it. They sign in again.
  const stale = await warehouse.get('/shelves/find', { params: { q: 'silk' } });
  check('  ...and back on, the old sign-in stays dead until they sign in again', stale.status === 401, brief(stale));
  const warehouseNow = await prisma.user.findUniqueOrThrow({ where: { id: warehouseU.id } });
  const warehouseFresh = api(AuthService.generateToken({ userId: warehouseU.id, clientId: SHOP, sessionVersion: warehouseNow.sessionVersion }), store.id);

  // A salesperson and another shop.
  const salesTries = await Promise.all([
    sales1.post('/shelves/putaway', { locationId: store.id, variantId: blue.id, spotId: c21.id, quantity: 1 }),
    sales1.post(`/shelves/spots/${c21.id}/count`, { counts: [{ variantId: blue.id, counted: 99 }] }),
    sales1.get('/shelves/pick/orders', { params: { locationId: store.id } }),
    sales1.post(`/shelves/locations/${store.id}/spots/import`, { rows: [{ address: 'HACK-1' }] })
  ]);
  check('a salesperson cannot put away, count, pick or import (403 each), but can find', salesTries.every(r => r.status === 403) && (await sales1.get('/shelves/find', { params: { q: 'silk' } })).status === 200, salesTries.map(r => r.status).join());
  const theirTries = await Promise.all([
    intruder.post('/dispatches', { salesOrderId: order2Id, items: [{ salesOrderItemId: item2, quantity: 1 }] }),
    intruder.get(`/shelves/spots/${c21.id}`),
    intruder.get('/shelves/movements', { params: { referenceType: 'ORDER', referenceIds: orderId } }),
    intruder.post('/inventory/stock-out', { variantId: blue.id, quantity: 1, reason: 'DAMAGE', locationId: store.id, fromSpots: [{ spotId: c21.id, quantity: 1 }] })
  ]);
  check("another shop's owner cannot send this shop's order, read its shelves, or write off its stock", theirTries[0].status >= 400 && theirTries[1].status === 404 && theirTries[2].status === 200 && theirTries[2].data.data.length === 0 && theirTries[3].status >= 400 && await official(blue.id) === beforeBlue && !theirTries.some(leaks), theirTries.map(brief).join(' | '));

  // A product archived with pieces on a shelf.
  await prisma.product.update({ where: { id: product.id }, data: { status: 'ARCHIVED' } });
  const archivedFind = await warehouseFresh.get('/shelves/find', { params: { q: `66GOLD${STAMP}` } });
  check('an archived product with pieces on a shelf is still found, marked archived', archivedFind.status === 200 && archivedFind.data.data.items[0]?.archived === true && archivedFind.data.data.items[0].places[0].shelves.length > 0, brief(archivedFind));
  await prisma.product.update({ where: { id: product.id }, data: { status: 'ACTIVE' } });

  // Removing a shelf while someone puts stock on it.
  let raceProblems = '';
  for (let round = 0; round < 5; round++) {
    const temp = await manager.post(`/shelves/locations/${store.id}/spots`, { parentId: (await spot('FLOOR')).id, kind: 'DISPLAY', code: `T${round}` });
    const tempId = temp.data?.data?.id;
    const extra = await owner.post('/inventory/stock-in', { variantId: gold.id, quantity: 1, reason: 'PURCHASE', unitCost: 600, locationId: store.id });
    const [del, put] = await Promise.all([
      manager.delete(`/shelves/spots/${tempId}`),
      warehouseFresh.post('/shelves/putaway', { locationId: store.id, variantId: gold.id, spotId: tempId, quantity: 1 })
    ]);
    const exists = await prisma.storageSpot.findUnique({ where: { id: tempId } });
    const held = await prisma.spotStock.count({ where: { spotId: tempId } });
    const consistent = (del.status === 200 && !exists && put.status !== 200) || (put.status === 200 && exists && held === 1 && del.status === 409);
    if (!consistent || [del, put, extra].some(r => r.status >= 500)) raceProblems += ` round ${round}: delete ${del.status}, putaway ${put.status}, spot ${exists ? 'kept' : 'gone'}, held ${held};`;
  }
  check('removing a shelf while someone puts stock on it (5 rounds): one wins cleanly, never both', !raceProblems, raceProblems);
  await agree('after the worst cases');

  check('no request anywhere in the day produced a server error', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '));
}

async function cleanup() {
  for (const id of [SHOP, OTHER]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) console.log('cleanup', id, e?.message); });
  }
  const left = await prisma.storageSpot.count({ where: { clientId: { in: [SHOP, OTHER] } } }) + await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER] } } });
  check('both throwaway shops are gone', left === 0, String(left));
}

main()
  .catch(e => { failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => { failures.push(`cleanup crashed: ${e?.message}`); console.error(e); });
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
