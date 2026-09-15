/**
 * Which store a purchase order is for, from raising it to receiving it.
 *
 *   A  raising an order: the store named, else the one selected at the top of the app, else the
 *      main store; another shop's store, a switched-off store, another shop's supplier or item
 *      refused, and a refused order uses up no PO number
 *   B  changing the store: allowed until fully received, says whether the supplier was already
 *      told another store, refused for a finished order, a bad store, or no permission
 *   C  receiving: with no store chosen the goods go to the order's store, not the top bar; a
 *      store picked on purpose wins; a switched-off order store is passed over, not refused
 *   D  sending: an order with no store is not emailed
 *   E  stores: address and phone saved and cleared; a store with orders on the way cannot be
 *      deleted, and deleting it once they are finished clears the link
 *   F  reorder suggestions per store: stock at that store only, what is on order for it counted,
 *      and drafts made from them go to that store
 *
 * Fixtures on demo-client (two stores, a supplier, a product, three people), all removed at the
 * end. Sends no email. Needs the API on :4006.
 *
 *   npx tsx src/scripts/verify-po-deliver-to.ts
 */
import axios, { AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const CLIENT = 'demo-client';
const STAMP = Date.now();

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 240)}`;
const noLeak = (r: any) => !/prisma|Invalid `|foreign key/i.test(JSON.stringify(r.data));

const made = {
  users: [] as string[], locationIds: [] as string[], supplierId: '', productId: '',
  variantIds: [] as string[], poIds: [] as string[], otherTenant: `dt-other-${STAMP}`
};

async function person(name: string, roleName: string): Promise<{ id: string; api: AxiosInstance }> {
  const role = await prisma.role.findFirstOrThrow({ where: { clientId: CLIENT, name: roleName } });
  const u = await prisma.user.create({ data: { clientId: CLIENT, email: `dt-${name}-${STAMP}@example.com`, name: `DT ${name} ${STAMP}`, password: 'unused', status: 'ACTIVE' } });
  made.users.push(u.id);
  await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
  const api = axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${AuthService.generateToken({ userId: u.id, clientId: CLIENT })}` },
    validateStatus: () => true
  });
  return { id: u.id, api };
}

const at = (locationId: string) => ({ headers: { 'x-location-id': locationId } });
const poNumberOf = (n: string) => Number(n.replace(/\D/g, ''));

async function main() {
  const admin = await person('manager', 'ADMIN');
  const sales = await person('sales', 'SALES');
  const main = await prisma.stockLocation.findFirstOrThrow({ where: { clientId: CLIENT, code: 'MAIN-STORE' } });

  // ── E (first part): stores with an address ──────────────────────────────────────────────
  console.log('\nE. STORES: ADDRESS AND PHONE');
  const mkStore = async (name: string, body: any = {}) => {
    const r = await admin.api.post('/locations', { name: `${name} ${STAMP}`, code: `DT-${name.toUpperCase()}-${STAMP}`, type: 'STORE', ...body });
    if (r.data?.id) made.locationIds.push(r.data.id);
    return r;
  };
  const aRes = await mkStore('Guntur', { address: '  14 Gandhi Road, Guntur 522002  ', phone: '+91 90000 55555' });
  check('a store is created with its address and phone, trimmed', aRes.status === 201 && aRes.data.address === '14 Gandhi Road, Guntur 522002' && aRes.data.phone === '+91 90000 55555', brief(aRes));
  const bRes = await mkStore('Tenali');
  check('...and without them', bRes.status === 201 && bRes.data.address === null && bRes.data.phone === null, brief(bRes));
  const A = aRes.data, B = bRes.data;
  const badPhone = await mkStore('Bad', { phone: 'call the manager' });
  check('refused: letters in a store phone (400)', badPhone.status === 400 && /digits/i.test(JSON.stringify(badPhone.data)), brief(badPhone));
  const longAddress = await mkStore('Long', { address: 'x'.repeat(301) });
  check('refused: an address over 300 characters (400)', longAddress.status === 400, brief(longAddress));
  const onlyActive = await admin.api.put(`/locations/${A.id}`, { active: true });
  check('switching a store on or off leaves its address alone', onlyActive.status === 200 && onlyActive.data.address === '14 Gandhi Road, Guntur 522002', brief(onlyActive));

  const supplier = await prisma.supplier.create({ data: { clientId: CLIENT, supplierCode: `SUP-DT-${STAMP}`, name: `DT Weavers ${STAMP}` } as any });
  made.supplierId = supplier.id;
  const product = await prisma.product.create({ data: { clientId: CLIENT, productCode: `PRD-DT-${STAMP}`, title: `DT Saree ${STAMP}`, slug: `dt-saree-${STAMP}`, category: 'WOMEN', basePrice: 3000, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  made.productId = product.id;
  const v = await prisma.productVariant.create({ data: { clientId: CLIENT, productId: product.id, sku: `DT-${STAMP}-Red`, variantCode: `VC-DT-${STAMP}`, size: 'Free', colorName: 'Red', sellingPrice: 3000, reorderLevel: 5 } });
  made.variantIds.push(v.id);
  await prisma.supplierProduct.create({ data: { clientId: CLIENT, supplierId: supplier.id, variantId: v.id, costPrice: 1500, isPreferred: true } as any });

  const other = { client: made.otherTenant };
  const otherLoc = await prisma.stockLocation.create({ data: { clientId: other.client, name: 'Elsewhere', code: 'MAIN-STORE', type: 'STORE', active: true } as any });
  const otherSup = await prisma.supplier.create({ data: { clientId: other.client, supplierCode: 'SUP-X', name: 'Other shop supplier' } as any });
  const otherProd = await prisma.product.create({ data: { clientId: other.client, productCode: 'PRD-X', title: 'Other', slug: `dt-x-${STAMP}`, category: 'WOMEN', basePrice: 10, status: 'ACTIVE', productType: 'READY_TO_WEAR' } });
  const otherVar = await prisma.productVariant.create({ data: { clientId: other.client, productId: otherProd.id, sku: `DTX-${STAMP}`, variantCode: `VC-DTX-${STAMP}`, size: 'M', colorName: 'Red', sellingPrice: 10 } });

  const line = (qty = 5) => [{ variantId: v.id, orderedQty: qty, unitPrice: 1500 }];
  const create = async (body: any, opts?: any) => {
    const r = await admin.api.post('/purchase-orders', { supplierId: supplier.id, items: line(), ...body }, opts);
    if (r.data?.data?.id) made.poIds.push(r.data.data.id);
    return r;
  };

  // ── A ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nA. RAISING AN ORDER');
  const named = await create({ locationId: A.id }, at(B.id));
  check('the store named on the order wins over the top bar', named.status === 201 && named.data.data.locationId === A.id, brief(named));
  check('  ...and the answer carries the store, with its address and phone', named.data?.data?.location?.name === A.name && named.data.data.location.address === A.address && named.data.data.location.phone === A.phone, brief(named));
  const fromTop = await create({}, at(B.id));
  check('with no store named, it is for the store selected at the top of the app', fromTop.status === 201 && fromTop.data.data.locationId === B.id, brief(fromTop));
  const plain = await create({});
  check('with neither, it is for the main store', plain.status === 201 && plain.data.data.locationId === main.id, brief(plain));

  const lastNumber = poNumberOf(plain.data.data.poNumber);
  await prisma.stockLocation.update({ where: { id: B.id }, data: { active: false } });
  const refusedCreates: [string, any, number][] = [
    ["another shop's store", { locationId: otherLoc.id }, 400],
    ['a switched-off store, by name', { locationId: B.id }, 400],
    ["another shop's supplier", { supplierId: otherSup.id }, 404],
    ["another shop's item", { items: [{ variantId: otherVar.id, orderedQty: 1, unitPrice: 1 }] }, 404]
  ];
  for (const [label, body, status] of refusedCreates) {
    const r = await create(body);
    check(`refused: ${label} (${status})`, r.status === status && noLeak(r), brief(r));
  }
  const offTop = await create({}, at(B.id));
  check('a switched-off store at the top of the app is passed over for the main store', offTop.status === 201 && offTop.data.data.locationId === main.id, brief(offTop));
  check('  ...and the refused orders used up no PO number', poNumberOf(offTop.data.data.poNumber) === lastNumber + 1, `${plain.data.data.poNumber} then ${offTop.data?.data?.poNumber}`);
  await prisma.stockLocation.update({ where: { id: B.id }, data: { active: true } });

  const list = await admin.api.get('/purchase-orders');
  const row = (list.data?.data || []).find((p: any) => p.id === named.data.data.id);
  check('the orders list shows each order\'s store', row?.location?.name === A.name, JSON.stringify(row?.location));

  // ── B ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. CHANGING THE STORE');
  const draftId = named.data.data.id;
  const d1 = await admin.api.put(`/purchase-orders/${draftId}/deliver-to`, { locationId: B.id });
  check('a draft moves to another store, and nobody has to be told', d1.status === 200 && d1.data.data.locationId === B.id && d1.data.changed === true && d1.data.supplierAlreadyTold === false && d1.data.previous === A.name, brief(d1));
  await admin.api.put(`/purchase-orders/${draftId}/status`, { status: 'SENT' });
  const d2 = await admin.api.put(`/purchase-orders/${draftId}/deliver-to`, { locationId: A.id });
  check('a sent order moves too, and the answer says the supplier was told the old store', d2.status === 200 && d2.data.data.locationId === A.id && d2.data.supplierAlreadyTold === true && d2.data.previous === B.name, brief(d2));
  const d3 = await admin.api.put(`/purchase-orders/${draftId}/deliver-to`, { locationId: A.id });
  check('choosing the store it already has changes nothing', d3.status === 200 && d3.data.changed === false && d3.data.supplierAlreadyTold === false, brief(d3));

  await prisma.stockLocation.update({ where: { id: B.id }, data: { active: false } });
  const refusedMoves: [string, any, any, number][] = [
    ['a switched-off store', admin, { locationId: B.id }, 400],
    ["another shop's store", admin, { locationId: otherLoc.id }, 400],
    ['no store at all', admin, {}, 400],
    ['someone who may not change orders', sales, { locationId: main.id }, 403]
  ];
  for (const [label, who, body, status] of refusedMoves) {
    const r = await who.api.put(`/purchase-orders/${draftId}/deliver-to`, body);
    check(`refused: ${label} (${status})`, r.status === status && noLeak(r), brief(r));
  }
  await prisma.stockLocation.update({ where: { id: B.id }, data: { active: true } });
  const missing = await admin.api.put(`/purchase-orders/00000000-0000-0000-0000-000000000000/deliver-to`, { locationId: A.id });
  check('refused: an order that does not exist (404)', missing.status === 404, brief(missing));
  const cancelledId = fromTop.data.data.id;
  await admin.api.put(`/purchase-orders/${cancelledId}/status`, { status: 'CANCELLED' });
  const onCancelled = await admin.api.put(`/purchase-orders/${cancelledId}/deliver-to`, { locationId: A.id });
  check('refused: a cancelled order, and it says so', onCancelled.status === 400 && /cancelled/i.test(onCancelled.data?.message), brief(onCancelled));
  check('  ...and none of the refusals moved the order', (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: draftId } })).locationId === A.id);

  // ── C ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. RECEIVING');
  const sentPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: draftId }, include: { items: true } });
  const itemId = sentPo.items[0].id;
  const r1 = await admin.api.post(`/purchase-orders/${draftId}/receive`, { receipts: [{ poItemId: itemId, quantityReceived: 1 }], receivedByName: 'Gopal' }, at(B.id));
  check("with no store chosen, the goods go to the order's store, not the top bar", r1.status === 200 && r1.data.receipt?.location?.id === A.id, brief(r1));
  const r2 = await admin.api.post(`/purchase-orders/${draftId}/receive`, { receipts: [{ poItemId: itemId, quantityReceived: 1 }], locationId: B.id, receivedByName: 'Gopal' });
  check('a store picked on purpose wins', r2.status === 200 && r2.data.receipt?.location?.id === B.id, brief(r2));
  check('  ...and the order is still for the store it was raised for', r2.data?.data?.locationId === A.id || (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: draftId } })).locationId === A.id);
  const page = await admin.api.get(`/purchase-orders/${draftId}`);
  check('the order page has the order\'s store beside each receipt\'s store', page.data?.data?.location?.id === A.id && page.data.data.receipts?.map((r: any) => r.location?.id).join() === [A.id, B.id].join(), brief(page));

  await prisma.stockLocation.update({ where: { id: A.id }, data: { active: false } });
  const r3 = await admin.api.post(`/purchase-orders/${draftId}/receive`, { receipts: [{ poItemId: itemId, quantityReceived: 1 }], receivedByName: 'Gopal' }, at(B.id));
  check("a switched-off order store is passed over for the top bar, not refused", r3.status === 200 && r3.data.receipt?.location?.id === B.id, brief(r3));
  const r4 = await admin.api.post(`/purchase-orders/${draftId}/receive`, { receipts: [{ poItemId: itemId, quantityReceived: 1 }], receivedByName: 'Gopal' });
  check('  ...and with no top bar either, for the main store', r4.status === 200 && r4.data.receipt?.location?.id === main.id, brief(r4));
  const onOff = await admin.api.put(`/purchase-orders/${draftId}/deliver-to`, { locationId: main.id });
  check('an order whose store was switched off can be moved to one that is on', onOff.status === 200 && onOff.data.data.locationId === main.id, brief(onOff));
  await prisma.stockLocation.update({ where: { id: A.id }, data: { active: true } });

  // The last piece: fully received, then the store can no longer change.
  const r5 = await admin.api.post(`/purchase-orders/${draftId}/receive`, { receipts: [{ poItemId: itemId, quantityReceived: 1 }], receivedByName: 'Gopal' });
  const onReceived = await admin.api.put(`/purchase-orders/${draftId}/deliver-to`, { locationId: A.id });
  check('refused: changing the store of a fully received order', r5.data?.data?.status === 'RECEIVED' && onReceived.status === 400 && /fully received/i.test(onReceived.data?.message), brief(onReceived));

  // ── D ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. SENDING');
  const noStoreId = plain.data.data.id;
  await prisma.purchaseOrder.update({ where: { id: noStoreId }, data: { locationId: null } });
  const email = await admin.api.post(`/purchase-orders/${noStoreId}/email`);
  check('an order with no store is not emailed, and it says why', email.status === 400 && /store this order is for/i.test(email.data?.message), brief(email));
  check('  ...and it stays a draft', (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: noStoreId } })).status === 'DRAFT');

  // ── F ───────────────────────────────────────────────────────────────────────────────────
  console.log('\nF. REORDER SUGGESTIONS PER STORE');
  // The deliveries in C left stock behind; start from a known picture: 1 at A, 20 at B, none at main.
  await prisma.inventoryStock.deleteMany({ where: { variantId: v.id } });
  await prisma.inventoryStock.createMany({ data: [
    { clientId: CLIENT, variantId: v.id, locationId: A.id, quantity: 1 },
    { clientId: CLIENT, variantId: v.id, locationId: B.id, quantity: 20 }
  ] });
  const findLine = (res: any) => [...(res.data?.data?.suppliers || []).flatMap((g: any) => g.lines), ...(res.data?.data?.unassigned || [])].find((l: any) => l.variantId === v.id);

  const sA = await admin.api.get('/reorder/suggestions', at(A.id));
  const lA = findLine(sA);
  check('at the store that ran out, the item is suggested, counting only that store\'s stock', sA.status === 200 && sA.data.data.location?.id === A.id && lA?.currentStock === 1 && lA?.onOrder === 0, brief(sA));
  const sB = await admin.api.get('/reorder/suggestions', at(B.id));
  check('at the store with plenty, it is not', sB.status === 200 && !findLine(sB), JSON.stringify(findLine(sB)));
  // Nothing held at the main store and, once this draft is cancelled, nothing on order for it.
  await admin.api.put(`/purchase-orders/${offTop.data.data.id}/status`, { status: 'CANCELLED' });
  const main0 = await admin.api.get('/reorder/suggestions', at(main.id));
  check('at a store that has never carried the item, it is not suggested at all', main0.status === 200 && !findLine(main0), JSON.stringify(findLine(main0)));
  const sAll = await admin.api.get('/reorder/suggestions');
  check('with no store selected, all stores together, as before', sAll.status === 200 && sAll.data.data.location === null && !findLine(sAll));

  const drafts = await admin.api.post('/reorder/draft-orders', { groups: [{ supplierId: supplier.id, items: [{ variantId: v.id, orderedQty: 2, unitPrice: 1500 }] }], locationId: A.id }, at(B.id));
  const draftPo = drafts.data?.data?.created?.[0];
  if (draftPo?.id) made.poIds.push(draftPo.id);
  check('a draft made from the suggestions is for that store, not the top bar', drafts.status === 201 && (await prisma.purchaseOrder.findUnique({ where: { id: draftPo?.id || 'none' } }))?.locationId === A.id, brief(drafts));
  const sA2 = await admin.api.get('/reorder/suggestions', at(A.id));
  const lA2 = findLine(sA2);
  check('  ...and the item is still suggested, with that draft counted as on order', lA2?.onOrder === 2 && lA2?.suggestedQty === 2, JSON.stringify(lA2));

  const bigger = await admin.api.post('/purchase-orders', { supplierId: supplier.id, items: line(10), locationId: A.id });
  if (bigger.data?.data?.id) made.poIds.push(bigger.data.data.id);
  const sA3 = await admin.api.get('/reorder/suggestions', at(A.id));
  check('once enough is on order for the store, it stops being suggested, and is counted as covered',
    !findLine(sA3) && sA3.data.data.summary.coveredByOpenOrders >= 1, JSON.stringify(findLine(sA3)));
  const sB2 = await admin.api.get('/reorder/suggestions', at(B.id));
  check("another store's orders do not count towards this one", sB2.status === 200 && !findLine(sB2) && (sB2.data.data.suppliers || []).every((g: any) => g.lines.every((l: any) => l.variantId !== v.id)));
  check('orders with no store chosen are reported, not counted', typeof sA3.data.data.summary.ordersWithoutStore === 'number' && sA3.data.data.summary.ordersWithoutStore >= 1, String(sA3.data.data.summary.ordersWithoutStore));
  const salesView = await sales.api.get('/reorder/suggestions', at(A.id));
  const salesLine = findLine(salesView);
  check('Sales still sees no prices in the suggestions', salesView.status !== 200 || (salesLine ? salesLine.unitPrice === undefined : true), JSON.stringify(salesLine));

  // ── E (second part): deleting a store orders are coming to ─────────────────────────────
  console.log('\nE. DELETING A STORE');
  const blocked = await admin.api.delete(`/locations/${A.id}`);
  check('a store with stock or orders on the way cannot be deleted', blocked.status === 400, brief(blocked));
  await prisma.inventoryStock.deleteMany({ where: { variantId: v.id, locationId: A.id } });
  const stillBlocked = await admin.api.delete(`/locations/${A.id}`);
  check('  ...with no stock left, the open orders still stop it, and it names them', stillBlocked.status === 400 && stillBlocked.data?.error?.includes(bigger.data.data.poNumber), brief(stillBlocked));
  // Receipts point at stores and are kept; this store has none of its own after moving them away.
  for (const id of made.poIds) {
    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (po && po.locationId === A.id && ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      await admin.api.put(`/purchase-orders/${id}/status`, { status: 'CANCELLED' });
    }
  }
  await prisma.purchaseReceipt.deleteMany({ where: { locationId: A.id, poId: { in: made.poIds } } });
  await prisma.inventoryTransaction.deleteMany({ where: { locationId: A.id, variantId: v.id } });
  await prisma.inventoryAlert.deleteMany({ where: { locationId: A.id } }).catch(() => undefined);
  await prisma.inventoryEvent.deleteMany({ where: { locationId: A.id } }).catch(() => undefined);
  await prisma.dailyLocationSnapshot.deleteMany({ where: { locationId: A.id } }).catch(() => undefined);
  const deleted = await admin.api.delete(`/locations/${A.id}`);
  check('once its orders are finished, it is deleted', deleted.status === 200, brief(deleted));
  check('  ...and those finished orders are kept, with the store link cleared', (await prisma.purchaseOrder.count({ where: { id: bigger.data.data.id, locationId: null, status: 'CANCELLED' } })) === 1);
  if (deleted.status === 200) made.locationIds = made.locationIds.filter(id => id !== A.id);

  await prisma.inventoryStock.deleteMany({ where: { clientId: other.client } });
  await prisma.productVariant.deleteMany({ where: { clientId: other.client } });
  await prisma.product.deleteMany({ where: { clientId: other.client } });
  await prisma.supplier.deleteMany({ where: { clientId: other.client } });
  await prisma.stockLocation.deleteMany({ where: { clientId: other.client } });
}

async function cleanup() {
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: made.poIds } } });
  await prisma.inventoryTransaction.deleteMany({ where: { variantId: { in: made.variantIds } } });
  await prisma.inventoryAlert.deleteMany({ where: { variantId: { in: made.variantIds } } }).catch(() => undefined);
  await prisma.inventoryEvent.deleteMany({ where: { variantId: { in: made.variantIds } } }).catch(() => undefined);
  await prisma.inventoryStock.deleteMany({ where: { variantId: { in: made.variantIds } } });
  await prisma.supplierProduct.deleteMany({ where: { variantId: { in: made.variantIds } } });
  await prisma.productVariant.deleteMany({ where: { id: { in: made.variantIds } } });
  if (made.productId) await prisma.product.deleteMany({ where: { id: made.productId } });
  if (made.supplierId) await prisma.supplier.deleteMany({ where: { id: made.supplierId } });
  for (const t of ['inventoryStock', 'productVariant', 'product', 'supplier', 'stockLocation'] as const) {
    await (prisma as any)[t].deleteMany({ where: { clientId: made.otherTenant } }).catch(() => undefined);
  }
  for (const id of made.locationIds) {
    await prisma.dailyLocationSnapshot.deleteMany({ where: { locationId: id } }).catch(() => undefined);
    await prisma.stockLocation.deleteMany({ where: { id } });
  }
  // Stores the refused creates might have made anyway.
  await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT, code: { startsWith: 'DT-', endsWith: `-${STAMP}` } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: made.users } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });

  const left = [
    await prisma.purchaseOrder.count({ where: { id: { in: made.poIds } } }),
    await prisma.productVariant.count({ where: { id: { in: made.variantIds } } }),
    await prisma.stockLocation.count({ where: { clientId: CLIENT, code: { endsWith: `-${STAMP}` } } }),
    await prisma.stockLocation.count({ where: { clientId: made.otherTenant } }),
    await prisma.user.count({ where: { id: { in: made.users } } })
  ];
  check('cleanup left nothing behind on demo-client', left.every(n => n === 0), left.join());
}

main()
  .catch(error => { failed++; failures.push(`crashed: ${error?.message}`); console.error(error); })
  .finally(async () => {
    try { await cleanup(); } catch (error: any) { failed++; console.error('cleanup failed', error); }
    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
