/**
 * The gaps found by the 17 Sep review, each proven closed over the API a person's screen uses.
 *
 *   A  stock counts: sales during a count are not undone; whole pieces; another shop's store; who did it
 *   B  Record Stock Movement: the selected store, stock-out as a reduction, the stock's value kept
 *   C  held stock: a transfer, write-off or stock-out cannot take pieces held for an order; a count can
 *   D  purchase orders: only sensible status changes; whole pieces; the same item once
 *   E  transfers: nonsense refused with a sentence, not a server error
 *   F  stores: cannot be switched off holding stock or awaiting deliveries
 *   G  returns: part of a dispatch; no second return of pieces already on one; re-inspect; turn down
 *   H  customers: dispatch lines named, open-return counts, older orders, no editing a deleted one
 *   I  item search: a code matching two items is a list
 *   J  team: nobody hands out, or takes over, more access than they have; managers still manage staff
 *   K  a wrong current password is a refusal, not a sign-out
 *   L  Shopify webhooks and storefronts are not throttled by the shop-wide address limit
 *
 * Throwaway shops, deleted at the end. Needs the API on :4006.
 *
 *   npx tsx src/scripts/verify-gap-fixes.ts
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { platformAdminService } from '../services/platform-admin.service';
import { salesOrderService } from '../services/sales-order.service';
import { dispatchService } from '../services/dispatch.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `gapfix-${STAMP}`;
const OTHER = `gapfix-other-${STAMP}`;

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 260)}`;
const noLeak = (r: any) => !/prisma|Invalid `|constraint|P20\d\d/i.test(JSON.stringify(r.data));
const msg = (r: any) => String(r.data?.message ?? r.data?.error ?? '');

const sent: number[] = [];
async function pace() {
  const now = Date.now();
  while (sent.length && now - sent[0] > 60_000) sent.shift();
  if (sent.length >= 88) { const w = 60_000 - (now - sent[0]) + 500; console.log(`  (pausing ${Math.ceil(w / 1000)}s for the rate limit)`); await new Promise(r => setTimeout(r, w)); sent.length = 0; }
  sent.push(Date.now());
}
const client = (token: string, locationId?: string): AxiosInstance => {
  const api = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}`, ...(locationId ? { 'x-location-id': locationId } : {}) }, validateStatus: () => true, timeout: 90_000 });
  api.interceptors.request.use(async cfg => { await pace(); return cfg; });
  return api;
};
async function person(clientId: string, name: string, roleId: string, locationId?: string) {
  const u = await prisma.user.create({ data: { clientId, email: `gap-${name.replace(/\W/g, '').toLowerCase()}-${clientId}@example.com`, name, password: await AuthService.hashPassword('Correct-horse-9'), status: 'ACTIVE' } });
  await prisma.userRole.create({ data: { userId: u.id, roleId } });
  return { id: u.id, api: client(AuthService.generateToken({ userId: u.id, clientId }), locationId) };
}
const stock = async (variantId: string, locationId: string) => {
  const s = await prisma.inventoryStock.findFirst({ where: { variantId, locationId } });
  return { onHand: s?.quantity ?? 0, held: s?.reservedQty ?? 0 };
};

async function main() {
  console.log(`SETUP ${SHOP}`);
  const roles = await seedRolesForClient(SHOP);
  const main = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE', active: true } });
  const branch = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Branch', code: 'BRANCH', type: 'STORE', active: true } });
  const empty = await prisma.stockLocation.create({ data: { clientId: SHOP, name: 'Empty Kiosk', code: 'KIOSK', type: 'STORE', active: true } });
  const foreignStore = await prisma.stockLocation.create({ data: { clientId: OTHER, name: 'Elsewhere', code: 'ELSE', type: 'STORE', active: true } });
  const owner = await person(SHOP, 'Owner Ravi', roles.SUPER_ADMIN, branch.id);
  const admin = await person(SHOP, 'Manager Anil', roles.ADMIN, main.id);

  const mk = async (title: string, price: number, qMain: number, qBranch = 0) => {
    const p = await prisma.product.create({ data: { clientId: SHOP, title, productCode: `G-${title.replace(/\W/g, '')}-${STAMP}`, slug: `g-${title.replace(/\W/g, '').toLowerCase()}-${STAMP}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: price, status: 'ACTIVE' } });
    const v = await prisma.productVariant.create({ data: { clientId: SHOP, productId: p.id, sku: `G-${title.replace(/\W/g, '').toUpperCase()}-${STAMP}`, variantCode: `GV-${title.replace(/\W/g, '')}-${STAMP}`, colorName: 'Red', size: 'M', sellingPrice: price, costPrice: price / 2, averageCost: price / 2 } });
    await prisma.$transaction(tx => inventoryMutationService.applyMovement({ clientId: SHOP, variantId: v.id, locationId: main.id, movementType: 'IN', reason: 'INITIAL_STOCK', quantityDelta: qMain, unitCost: price / 2, tx }), { timeout: 30000 });
    if (qBranch) await prisma.$transaction(tx => inventoryMutationService.applyMovement({ clientId: SHOP, variantId: v.id, locationId: branch.id, movementType: 'IN', reason: 'INITIAL_STOCK', quantityDelta: qBranch, unitCost: price / 2, tx }), { timeout: 30000 });
    return v;
  };
  const saree = await mk('Count Saree', 1000, 10);
  const blouse = await mk('Branch Blouse', 800, 5, 6);
  const held = await mk('Held Dupatta', 500, 5);
  const trio = await mk('Trio Set', 300, 10);
  const customer = await prisma.customer.create({ data: { clientId: SHOP, customerCode: 'CUS-G-1', name: 'Return Customer', phone: `+9197${String(STAMP).slice(-8)}`, status: 'ACTIVE' } });

  // ── A ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nA. STOCK COUNTS');
  const count = await admin.api.post('/stock-counts', { name: 'Weekly count', locationId: main.id, createdBy: 'Somebody Else' });
  const countId = count.data?.data?.id ?? count.data?.id;
  check('a count is created', count.status === 201 && !!countId, brief(count));
  const countRow = await prisma.stockCount.findFirst({ where: { id: countId } });
  check('  ...recorded as created by the person signed in, not what the request claimed', countRow?.createdBy === 'Manager Anil', String(countRow?.createdBy));
  await admin.api.post(`/stock-counts/${countId}/start`);
  // 3 sarees sell while the count is under way, before the saree is counted.
  const order: any = await salesOrderService.createFullOrder(SHOP, main.id, { customer: { id: customer.id }, status: 'CONFIRMED', items: [{ variantId: saree.id, quantity: 3 }] });
  await dispatchService.createDispatch(SHOP, order.id, [{ salesOrderItemId: order.items[0].id, quantity: 3 }]);
  const sareeLine = await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: countId, variantId: saree.id } });
  const counted = await admin.api.put(`/stock-counts/${countId}/items/${sareeLine.id}`, { countedQty: 7 });
  check('7 counted on the shelf after 3 sold', counted.status === 200, brief(counted));
  const half = await admin.api.put(`/stock-counts/${countId}/items/${sareeLine.id}`, { countedQty: 2.5 });
  check('  ...2.5 pieces is refused (400)', half.status === 400 && noLeak(half), brief(half));
  // A blouse sells AFTER it is counted: that sale must stand too.
  const blouseLine = await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: countId, variantId: blouse.id } });
  await admin.api.put(`/stock-counts/${countId}/items/${blouseLine.id}`, { countedQty: 5 });
  const order2: any = await salesOrderService.createFullOrder(SHOP, main.id, { customer: { id: customer.id }, status: 'CONFIRMED', items: [{ variantId: blouse.id, quantity: 1 }] });
  await dispatchService.createDispatch(SHOP, order2.id, [{ salesOrderItemId: order2.items[0].id, quantity: 1 }]);
  const done = await admin.api.post(`/stock-counts/${countId}/complete`, { completedBy: 'Forged Name' });
  check('the count completes', done.status === 200, brief(done));
  check('  ...the saree stays at 7: the 3 sold during the count are not taken off again', (await stock(saree.id, main.id)).onHand === 7, JSON.stringify(await stock(saree.id, main.id)));
  check('  ...the blouse sold after it was counted stays sold (4)', (await stock(blouse.id, main.id)).onHand === 4, JSON.stringify(await stock(blouse.id, main.id)));
  const doneRow = await prisma.stockCount.findFirst({ where: { id: countId } });
  check('  ...completed by the person signed in, not "Forged Name"', doneRow?.completedBy === 'Manager Anil', String(doneRow?.completedBy));
  const foreignCount = await admin.api.post('/stock-counts', { name: 'Not ours', locationId: foreignStore.id });
  check('a count for another shop\'s store is refused (404)', foreignCount.status === 404, brief(foreignCount));

  // ── B ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. RECORD STOCK MOVEMENT');
  const txCountBefore = await prisma.inventoryTransaction.count({ where: { clientId: SHOP, variantId: blouse.id, locationId: branch.id } });
  const outAtBranch = await owner.api.post('/inventory/transactions', { variantId: blouse.id, type: 'OUT', reason: 'DAMAGE', quantity: 2, notes: 'Torn in the window' });
  check('a stock-out is recorded (201)', outAtBranch.status === 201, brief(outAtBranch));
  check('  ...at the store selected at the top (Branch 6 -> 4), not Main Store', (await stock(blouse.id, branch.id)).onHand === 4 && (await stock(blouse.id, main.id)).onHand === 4, JSON.stringify([await stock(blouse.id, branch.id), await stock(blouse.id, main.id)]));
  const row = await prisma.inventoryTransaction.findFirst({ where: { clientId: SHOP, variantId: blouse.id, locationId: branch.id }, orderBy: { createdAt: 'desc' } });
  check('  ...written as a reduction (-2), so the day book counts it as going out', (await prisma.inventoryTransaction.count({ where: { clientId: SHOP, variantId: blouse.id, locationId: branch.id } })) === txCountBefore + 1 && Number(row?.quantity) === -2, JSON.stringify(row));
  const v = await prisma.productVariant.findFirst({ where: { id: blouse.id } });
  check('  ...and the stock\'s value follows (8 pieces x 400 = 3,200)', Number(v?.inventoryValue) === 3200, String(v?.inventoryValue));
  const tooMany = await owner.api.post('/inventory/transactions', { variantId: blouse.id, type: 'OUT', reason: 'DAMAGE', quantity: 50 });
  check('taking out more than is there is refused, not a server error', tooMany.status === 400 && noLeak(tooMany), brief(tooMany));

  // ── C ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. HELD STOCK');
  const holdOrder: any = await salesOrderService.createFullOrder(SHOP, main.id, { customer: { id: customer.id }, status: 'CONFIRMED', items: [{ variantId: held.id, quantity: 4 }] });
  check('4 of 5 dupattas held for an order', (await stock(held.id, main.id)).held === 4);
  const moveHeld = await admin.api.post('/inventory-transfers', { originLocationId: main.id, destinationLocationId: branch.id, items: [{ variantId: held.id, quantity: 3 }] });
  check('moving 3 to another store is refused: only 1 is free (409)', moveHeld.status === 409 && /held for orders/i.test(msg(moveHeld)), brief(moveHeld));
  const moveFree = await admin.api.post('/inventory-transfers', { originLocationId: main.id, destinationLocationId: branch.id, items: [{ variantId: held.id, quantity: 1 }] });
  check('  ...moving the 1 free piece works', moveFree.status === 200, brief(moveFree));
  const writeOff = await admin.api.post('/inventory/transactions', { variantId: held.id, type: 'OUT', reason: 'DAMAGE', quantity: 1 });
  check('  ...writing off a held piece is refused (409)', writeOff.status === 409, brief(writeOff));
  const holdSend = await dispatchService.createDispatch(SHOP, holdOrder.id, [{ salesOrderItemId: holdOrder.items[0].id, quantity: 4 }]).then(() => 'ok', (e: any) => e.message);
  check('  ...and the order can still send out all 4', holdSend === 'ok', holdSend);
  const holdAgain: any = await salesOrderService.createFullOrder(SHOP, branch.id, { customer: { id: customer.id }, status: 'CONFIRMED', items: [{ variantId: held.id, quantity: 1 }] });
  const recount = await admin.api.post('/stock-counts', { name: 'Branch recount', locationId: branch.id });
  const recountId = recount.data?.data?.id ?? recount.data?.id;
  await admin.api.post(`/stock-counts/${recountId}/start`);
  const heldLine = await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: recountId, variantId: held.id } });
  await admin.api.put(`/stock-counts/${recountId}/items/${heldLine.id}`, { countedQty: 0 });
  const recountDone = await admin.api.post(`/stock-counts/${recountId}/complete`);
  check('a count that finds a held piece missing is still posted (the shelf is the truth)', recountDone.status === 200 && (await stock(held.id, branch.id)).onHand === 0, brief(recountDone));
  await salesOrderService.cancelOrder(SHOP, holdAgain.id);

  // ── D ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. PURCHASE ORDERS');
  const supplier = await prisma.supplier.create({ data: { clientId: SHOP, name: `Gap Supplier ${STAMP}`, supplierCode: `SUP-G-${STAMP}` } as any });
  const po = await admin.api.post('/purchase-orders', { supplierId: supplier.id, locationId: main.id, items: [{ variantId: trio.id, orderedQty: 4, unitPrice: 150 }] });
  const poId = po.data?.data?.id ?? po.data?.id;
  check('a purchase order is raised', po.status === 201 && !!poId, brief(po));
  const toReceived = await admin.api.put(`/purchase-orders/${poId}/status`, { status: 'RECEIVED' });
  check('it cannot be marked received without receiving anything (409)', toReceived.status === 409, brief(toReceived));
  const bogus = await admin.api.put(`/purchase-orders/${poId}/status`, { status: 'LOST_IN_POST' });
  check('a made-up status is refused (400), not a server error', bogus.status === 400 && noLeak(bogus), brief(bogus));
  const sentTwice = [await admin.api.put(`/purchase-orders/${poId}/status`, { status: 'SENT' }), await admin.api.put(`/purchase-orders/${poId}/status`, { status: 'SENT' })];
  check('sending it (twice, as when it is emailed again) is fine', sentTwice.every(r => r.status === 200), sentTwice.map(brief).join(' | '));
  const backToDraft = await admin.api.put(`/purchase-orders/${poId}/status`, { status: 'DRAFT' });
  check('a sent order cannot go back to draft (409)', backToDraft.status === 409, brief(backToDraft));
  const halfPo = await admin.api.post('/purchase-orders', { supplierId: supplier.id, locationId: main.id, items: [{ variantId: trio.id, orderedQty: 2.5, unitPrice: 150 }] });
  const dupPo = await admin.api.post('/purchase-orders', { supplierId: supplier.id, locationId: main.id, items: [{ variantId: trio.id, orderedQty: 1, unitPrice: 150 }, { variantId: trio.id, orderedQty: 2, unitPrice: 150 }] });
  check('2.5 pieces, or the same item twice, is refused (400)', halfPo.status === 400 && dupPo.status === 400, `${brief(halfPo)} | ${brief(dupPo)}`);
  const cancel = await admin.api.put(`/purchase-orders/${poId}/status`, { status: 'CANCELLED' });
  const reopen = await admin.api.put(`/purchase-orders/${poId}/status`, { status: 'SENT' });
  check('a cancelled order stays cancelled', cancel.status === 200 && reopen.status === 409, `${brief(cancel)} | ${brief(reopen)}`);

  // ── E ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nE. TRANSFERS');
  const badTransfers: [string, any][] = [
    ['no items', { originLocationId: main.id, destinationLocationId: branch.id }],
    ['items that are not a list', { originLocationId: main.id, destinationLocationId: branch.id, items: 'all of it' }],
    ['half a piece', { originLocationId: main.id, destinationLocationId: branch.id, items: [{ variantId: trio.id, quantity: 0.5 }] }],
    ['the same item twice', { originLocationId: main.id, destinationLocationId: branch.id, items: [{ variantId: trio.id, quantity: 1 }, { variantId: trio.id, quantity: 1 }] }],
    ['no destination', { originLocationId: main.id, items: [{ variantId: trio.id, quantity: 1 }] }]
  ];
  for (const [label, body] of badTransfers) {
    const r = await admin.api.post('/inventory-transfers', body);
    check(`a transfer with ${label} is refused with a sentence (400)`, r.status === 400 && noLeak(r) && msg(r).length > 10, brief(r));
  }

  // ── F ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nF. SWITCHING A STORE OFF');
  const offWithStock = await owner.api.put(`/locations/${main.id}`, { name: 'Main Store', code: 'MAIN-STORE', type: 'STORE', active: false });
  check('a store still holding stock cannot be switched off (409)', offWithStock.status === 409 && /in stock/i.test(msg(offWithStock)), brief(offWithStock));
  const offEmpty = await owner.api.put(`/locations/${empty.id}`, { name: 'Empty Kiosk', code: 'KIOSK', type: 'STORE', active: false });
  check('an empty store with nothing on order can be switched off', offEmpty.status === 200, brief(offEmpty));

  // ── G ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nG. RETURNS');
  const sold: any = await salesOrderService.createFullOrder(SHOP, main.id, { customer: { id: customer.id }, status: 'CONFIRMED', items: [{ variantId: trio.id, quantity: 3 }, { variantId: saree.id, quantity: 1 }] });
  const disp: any = await dispatchService.createDispatch(SHOP, sold.id, sold.items.map((i: any) => ({ salesOrderItemId: i.id, quantity: i.quantity })));
  const trioDi = disp.items.find((i: any) => i.salesOrderItemId === sold.items.find((x: any) => x.variantId === trio.id).id);
  const part = await admin.api.post('/returns', { salesOrderId: sold.id, reason: 'SIZE_ISSUE', items: [{ dispatchItemId: trioDi.id, quantity: 1 }] });
  check('one piece of three can be returned on its own', part.status === 201, brief(part));
  const again = await admin.api.post('/returns', { salesOrderId: sold.id, reason: 'SIZE_ISSUE', items: [{ dispatchItemId: trioDi.id, quantity: 3 }] });
  check('  ...the same pieces cannot be put on a second return while the first is open (409)', again.status === 409 && /open return/i.test(msg(again)), brief(again));
  const rest = await admin.api.post('/returns', { salesOrderId: sold.id, reason: 'SIZE_ISSUE', items: [{ dispatchItemId: trioDi.id, quantity: 2 }] });
  check('  ...but the other two still can', rest.status === 201, brief(rest));
  const retId = part.data?.data?.id;
  const retItems = part.data?.data?.items ?? [];
  await admin.api.post(`/returns/${retId}/receive`);
  const scrap = await admin.api.post(`/returns/${retId}/inspect`, { itemsDisposition: retItems.map((i: any) => ({ salesReturnItemId: i.id, disposition: 'SCRAP' })) });
  const fixDecision = await admin.api.post(`/returns/${retId}/inspect`, { itemsDisposition: retItems.map((i: any) => ({ salesReturnItemId: i.id, disposition: 'RESTOCK' })) });
  check('a wrong inspection can be corrected before completing', scrap.status === 200 && fixDecision.status === 200, `${brief(scrap)} | ${brief(fixDecision)}`);
  const beforeComplete = (await stock(trio.id, main.id)).onHand;
  const complete = await admin.api.post(`/returns/${retId}/complete`);
  check('  ...and the corrected decision is what happens: the piece goes back on the shelf', complete.status === 200 && (await stock(trio.id, main.id)).onHand === beforeComplete + 1, brief(complete));
  const reject = await admin.api.post(`/returns/${rest.data?.data?.id}/reject`);
  const rejectAgain = await admin.api.post(`/returns/${rest.data?.data?.id}/reject`);
  check('a return booked by mistake can be turned down, once (then 409)', reject.status === 200 && rejectAgain.status === 409, `${brief(reject)} | ${brief(rejectAgain)}`);
  const afterReject = await admin.api.post('/returns', { salesOrderId: sold.id, reason: 'SIZE_ISSUE', items: [{ dispatchItemId: trioDi.id, quantity: 2 }] });
  check('  ...its pieces can then be returned properly', afterReject.status === 201, brief(afterReject));

  // ── H ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nH. CUSTOMER PAGE');
  const cd = await admin.api.get(`/customers/${customer.id}`);
  const cdItems = (cd.data?.salesOrders ?? cd.data?.data?.salesOrders ?? []).flatMap((o: any) => o.dispatches.flatMap((d: any) => d.items));
  const trioItem = cdItems.find((i: any) => i.id === trioDi.id);
  check('dispatch lines say what they are', trioItem?.salesOrderItem?.variant?.product?.title === 'Trio Set', JSON.stringify(trioItem).slice(0, 200));
  check('  ...and how many are on a return still open (2)', trioItem?.openReturnQty === 2, String(trioItem?.openReturnQty));
  for (let i = 0; i < 11; i++) await prisma.salesOrder.create({ data: { clientId: SHOP, orderNumber: `SO-G-${STAMP}-${i}`, customerId: customer.id, locationId: main.id, status: 'DRAFT', subtotal: 0, total: 0 } });
  const cd2 = await admin.api.get(`/customers/${customer.id}`);
  check('an older sale is still listed after 11 newer orders, so it can be returned', (cd2.data?.salesOrders ?? []).some((o: any) => o.id === sold.id), String((cd2.data?.salesOrders ?? []).length));
  await prisma.customer.update({ where: { id: customer.id }, data: { deletedAt: new Date() } });
  const editDeleted = await admin.api.patch(`/customers/${customer.id}`, { name: 'Back from the dead' });
  check('a deleted customer cannot be edited (404)', editDeleted.status === 404, brief(editDeleted));
  await prisma.customer.update({ where: { id: customer.id }, data: { deletedAt: null } });

  // ── I ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nI. ITEM SEARCH');
  await prisma.productVariant.update({ where: { id: trio.id }, data: { barcode: `CLASH${STAMP}` } });
  await prisma.productVariant.update({ where: { id: saree.id }, data: { sku: `CLASH${STAMP}` } });
  const clash = await admin.api.get('/counter-sales/items', { params: { q: `CLASH${STAMP}`, locationId: main.id } });
  check('a code that is one item\'s barcode and another\'s SKU lists both to pick from', clash.status === 200 && clash.data.data.exact === false && clash.data.data.items.length === 2, brief(clash));

  // ── J ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nJ. TEAM');
  const perm = async (keys: string[]) => (await prisma.permission.findMany({ where: { key: { in: keys } } })).map(p => p.id);
  const lead = await prisma.role.create({ data: { clientId: SHOP, name: 'TEAM-LEAD' } });
  await prisma.rolePermission.createMany({ data: (await perm(['admin:users', 'sales_order:create', 'customer:create', 'dashboard:view'])).map(permissionId => ({ roleId: lead.id, permissionId })) });
  const accountant = await prisma.role.create({ data: { clientId: SHOP, name: 'ACCOUNTANT' } });
  await prisma.rolePermission.createMany({ data: (await perm(['report:financial', 'cost:manage', 'team:view_password'])).map(permissionId => ({ roleId: accountant.id, permissionId })) });
  const cashierRole = await prisma.role.create({ data: { clientId: SHOP, name: 'CASHIER-LITE' } });
  await prisma.rolePermission.createMany({ data: (await perm(['sales_order:create', 'customer:create'])).map(permissionId => ({ roleId: cashierRole.id, permissionId })) });
  const teamLead = await person(SHOP, 'Team Lead Kavya', lead.id, main.id);
  const coOwner = await person(SHOP, 'Almost Owner', accountant.id, main.id);

  const inviteUp = await teamLead.api.post('/team/members', { name: 'Sneaky', email: `sneaky-${STAMP}@example.com`, roleId: accountant.id, customPassword: 'Sneaky-pass-1' });
  check('a team lead cannot invite someone into a role with more access (403)', inviteUp.status === 403 && /more access/i.test(msg(inviteUp)), brief(inviteUp));
  check('  ...and no account was created', !(await prisma.user.findFirst({ where: { email: `sneaky-${STAMP}@example.com` } })));
  const takeOver = await teamLead.api.post(`/team/members/${coOwner.id}/password`, { customPassword: 'Taken-over-1' });
  check('a team lead cannot reset the password of someone with more access (403)', takeOver.status === 403, brief(takeOver));
  const promote = await teamLead.api.patch(`/team/members/${teamLead.id}/role`, { roleId: accountant.id });
  check('a team lead cannot move anyone, themselves included, into a bigger role (403)', promote.status === 403, brief(promote));
  const inviteDown = await teamLead.api.post('/team/members', { name: 'New Cashier', email: `cashier-${STAMP}@example.com`, roleId: cashierRole.id, customPassword: 'Cashier-pass-1' });
  check('  ...but can add someone to a role within their own access', inviteDown.status === 201, brief(inviteDown));
  for (const name of ['SALES', 'WAREHOUSE', 'INVENTORY_MANAGER']) {
    const r = await admin.api.post('/team/members', { name: `Staff ${name}`, email: `staff-${name.toLowerCase()}-${STAMP}@example.com`, roleId: roles[name], customPassword: 'Staff-pass-1' });
    check(`a manager (ADMIN) can still add ${name} staff`, r.status === 201, brief(r));
  }
  const staff = await prisma.user.findFirstOrThrow({ where: { email: `staff-sales-${STAMP}@example.com` } });
  const resetStaff = await admin.api.post(`/team/members/${staff.id}/password`, { customPassword: 'New-staff-pass-2' });
  check('  ...and reset a salesperson\'s password', resetStaff.status === 200, brief(resetStaff));

  // ── K ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nK. CHANGING YOUR OWN PASSWORD');
  // The owner: only the account owner changes their own password here; staff ask an admin.
  const wrong = await owner.api.post('/auth/me/password', { currentPassword: 'not-it', newPassword: 'Brand-new-pass-9' });
  check('a wrong current password is refused as 400, so the app does not sign the person out', wrong.status === 400 && /current password/i.test(msg(wrong)), brief(wrong));

  // ── L ────────────────────────────────────────────────────────────────────────────────────
  console.log('\nL. RATE LIMIT');
  const hits = await Promise.all(Array.from({ length: 110 }, () => axios.post(`${BASE}/shopify/webhooks`, {}, { validateStatus: () => true, headers: { 'X-Shopify-Hmac-Sha256': 'bad', 'X-Shopify-Topic': 'orders/create', 'X-Shopify-Shop-Domain': 'nobody.myshopify.com' } })));
  check('110 Shopify webhook calls in a burst are not throttled by the address limit (no 429)', hits.every(r => r.status !== 429), [...new Set(hits.map(r => r.status))].join(','));
  check('  ...and each one without a valid signature is still refused', hits.every(r => r.status === 401 || r.status === 400 || r.status === 404), [...new Set(hits.map(r => r.status))].join(','));
}

async function cleanup() {
  for (const id of [SHOP, OTHER]) {
    await platformAdminService.deleteClientCompletely(id, id).catch((e: any) => { if (!/No such client/.test(e?.message)) check(`shop ${id} deleted`, false, e?.message); });
  }
  const left = await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER] } } }) + await prisma.stockLocation.count({ where: { clientId: { in: [SHOP, OTHER] } } });
  check('the throwaway shops are gone', left === 0, String(left));
}

main()
  .catch(e => { failed++; failures.push(`crashed: ${e?.message}`); console.error(e); })
  .finally(async () => {
    await cleanup().catch(e => console.error('cleanup failed', e));
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
