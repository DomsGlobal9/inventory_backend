/**
 * What a careless, rushed or unlucky shop worker does to inventory -- the cases no other suite covered (26 Oct).
 * Through the real API, on the LOCAL database, in its own stores and items.
 *
 *   A  MOVE STOCK   the last piece sent to two stores at the same moment; 0, too many, the same store,
 *                   an unknown store, the same item twice in one move
 *   B  PRODUCTS     deleting one that still has stock, is on an open order, or sits on a shelf; archiving
 *                   keeps its stock
 *   C  STORES       deleting one with stock, with stock on its shelves, with an open order
 *   D  RECEIVING    one purchase order received twice at the same moment; more than ordered; nothing
 *   E  RENAMES      an item's code changed while it sits on a shelf: still on the shelf, found by the new code
 *   F  CORRECTIONS  two stock corrections at the same moment: the count equals what was applied, row for row
 *
 *   DATABASE_URL=<local> ROLE_TOKENS=<local-tokens.json> IDS=<local-ids.json> npx tsx src/scripts/verify-inventory-user-worst.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { salesOrderService } from '../services/sales-order.service';

if (!/localhost:55433|127\.0\.0\.1:55433/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing: this suite runs on the local database only (DATABASE_URL must be localhost:55433).');
  process.exit(1);
}
const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
const ids = JSON.parse(fs.readFileSync(process.env.IDS!, 'utf8'));
const C: string = ids.clientId, MAIN: string = ids.locationId;
const STAMP = Date.now() % 1_000_000;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const api = axios.create({ baseURL: API, headers: { Cookie: `token=${tokens.SUPER_ADMIN}` }, validateStatus: () => true });
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 240)}`;
const msg = (r: any) => String(r.data?.message ?? r.data?.error ?? '');
const data = (r: any) => r.data?.data ?? r.data;
const plain = (r: any) => msg(r).length > 0 && !/[0-9a-f]{8}-[0-9a-f]{4}-|Expected \w+, received|undefined|null|prisma|P20\d\d|Cannot read/i.test(msg(r));

async function item(title: string, stockAt: Record<string, number>) {
  const product = await prisma.product.create({ data: { clientId: C, productCode: `UW-${STAMP}-${title}`, slug: `uw-${STAMP}-${title}`.toLowerCase(), title: `UW ${title} ${STAMP}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any } as any });
  const v = await prisma.productVariant.create({ data: { clientId: C, productId: product.id, sku: `UW-${STAMP}-${title}`, variantCode: `UWV-${STAMP}-${title}`, colorName: 'Red', size: 'M', sellingPrice: 1000, costPrice: 500 } as any });
  for (const [loc, q] of Object.entries(stockAt)) {
    if (q > 0) await inventoryMutationService.applyMovement({ clientId: C, variantId: v.id, locationId: loc, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: q, unitCost: 500, notes: 'verify-inventory-user-worst', createdBy: 'verify-inventory-user-worst' } as any);
  }
  return { productId: product.id, variantId: v.id };
}
const stockAt = async (variantId: string, locationId: string) => (await prisma.inventoryStock.findUnique({ where: { variantId_locationId: { variantId, locationId } } }))?.quantity ?? 0;
async function store(name: string) {
  const r = await api.post('/locations', { name: `${name} ${STAMP}`, code: `UW${STAMP}${name.slice(0, 3).toUpperCase()}`, type: 'STORE' });
  const loc = data(r);
  if (!loc?.id) throw new Error(`could not make a store: ${brief(r)}`);
  return loc.id as string;
}

async function main() {
  console.log(`\nInventory, the worst a user can do -- LOCAL database (${C})\n`);
  const B = await store('Branch'), G = await store('Godown');

  console.log('A. MOVE STOCK');
  const last = await item('LAST', { [MAIN]: 1 });
  const send = (to: string) => api.post('/inventory-transfers', { originLocationId: MAIN, destinationLocationId: to, items: [{ variantId: last.variantId, quantity: 1 }] });
  const [t1, t2] = await Promise.all([send(B), send(G)]);
  const wins = [t1, t2].filter(r => r.status < 300).length;
  const lost = [t1, t2].find(r => r.status >= 400);
  check('the last piece sent to two stores at once: ONE move goes through', wins === 1, `${brief(t1)} | ${brief(t2)}`);
  check('  ...the other is refused in plain words', !!lost && plain(lost), lost ? brief(lost) : 'both went through');
  const total = (await stockAt(last.variantId, MAIN)) + (await stockAt(last.variantId, B)) + (await stockAt(last.variantId, G));
  check('  ...still exactly 1 piece in the shop overall, none below zero', total === 1 && (await stockAt(last.variantId, MAIN)) === 0, `main ${await stockAt(last.variantId, MAIN)} branch ${await stockAt(last.variantId, B)} godown ${await stockAt(last.variantId, G)}`);
  const ten = await item('TEN', { [MAIN]: 10 });
  const bad = [
    ['0 pieces', { originLocationId: MAIN, destinationLocationId: B, items: [{ variantId: ten.variantId, quantity: 0 }] }],
    ['more than there is (11 of 10)', { originLocationId: MAIN, destinationLocationId: B, items: [{ variantId: ten.variantId, quantity: 11 }] }],
    ['to the same store', { originLocationId: MAIN, destinationLocationId: MAIN, items: [{ variantId: ten.variantId, quantity: 1 }] }],
    ['to a store that does not exist', { originLocationId: MAIN, destinationLocationId: '00000000-0000-4000-8000-000000000000', items: [{ variantId: ten.variantId, quantity: 1 }] }],
    ['the same item twice in one move', { originLocationId: MAIN, destinationLocationId: B, items: [{ variantId: ten.variantId, quantity: 1 }, { variantId: ten.variantId, quantity: 2 }] }],
    ['no items at all', { originLocationId: MAIN, destinationLocationId: B, items: [] }]
  ] as const;
  for (const [what, body] of bad) {
    const r = await api.post('/inventory-transfers', body);
    check(`moving ${what}: refused in plain words`, r.status >= 400 && r.status < 500 && plain(r), brief(r));
  }
  check('  ...and none of those moved a piece (still 10 at Main, 0 at Branch)', await stockAt(ten.variantId, MAIN) === 10 && await stockAt(ten.variantId, B) === 0);

  console.log('\nB. PRODUCTS THAT STILL HAVE STOCK');
  const pStock = await item('PSTOCK', { [MAIN]: 4 });
  const hd = await api.delete(`/products/${pStock.productId}/hard`);
  check('deleting for good a product with 4 in stock: refused in plain words', hd.status >= 400 && plain(hd), brief(hd));
  check('  ...the product and its 4 pieces are still there', !!(await prisma.product.findUnique({ where: { id: pStock.productId } })) && await stockAt(pStock.variantId, MAIN) === 4);
  const pOrder = await item('PORDER', { [MAIN]: 3 });
  const order: any = await salesOrderService.createFullOrder(C, MAIN, { customer: { id: ids.customerId }, items: [{ variantId: pOrder.variantId, quantity: 1 }] }, 'POS');
  await salesOrderService.confirmOrder(C, order.id);
  const ho = await api.delete(`/products/${pOrder.productId}/hard`);
  check('deleting for good a product on a confirmed order: refused in plain words', ho.status >= 400 && plain(ho), brief(ho));
  const tr = await api.post(`/products/${pOrder.productId}/trash`);
  const afterTrash = await prisma.salesOrderItem.findFirst({ where: { salesOrderId: order.id } });
  check('putting it in the bin: either refused in words, or the open order still has its line and its stock', (tr.status >= 400 && plain(tr)) || (!!afterTrash && await stockAt(pOrder.variantId, MAIN) === 3), brief(tr));
  if (tr.status < 300) await api.post(`/products/${pOrder.productId}/restore`);
  const ar = await api.post(`/products/${pStock.productId}/archive`);
  check('archiving a product with stock keeps its 4 pieces in the count', ar.status < 300 && await stockAt(pStock.variantId, MAIN) === 4, brief(ar));
  await api.post(`/products/${pStock.productId}/restore`);

  console.log('\nC. STORES THAT ARE NOT EMPTY');
  const S1 = await store('Full');
  await item('S1STOCK', { [S1]: 2 });
  const ds1 = await api.delete(`/locations/${S1}`);
  check('deleting a store with 2 pieces in it: refused in plain words, store still there', ds1.status >= 400 && plain(ds1) && !!(await prisma.stockLocation.findUnique({ where: { id: S1 } })), brief(ds1));
  const S2 = await store('Shelved');
  const sh = await item('S2SHELF', { [S2]: 2 });
  const area = data(await api.post(`/shelves/locations/${S2}/spots`, { kind: 'AREA', code: `UA${STAMP}`, isShopFloor: true }));
  const sp = data(await api.post(`/shelves/locations/${S2}/spots`, { parentId: area?.id, kind: 'SHELF', code: '1' }));
  await api.post('/shelves/putaway', { locationId: S2, variantId: sh.variantId, spotId: sp?.id, quantity: 2 });
  const ds2 = await api.delete(`/locations/${S2}`);
  check('deleting a store whose stock is on its shelves: refused, shelves and pieces kept', ds2.status >= 400 && plain(ds2) && (await prisma.spotStock.count({ where: { spotId: sp?.id } })) === 1, brief(ds2));
  const S3 = await store('Ordered');
  const o3item = await item('S3ORDER', { [S3]: 1 });
  const o3: any = await salesOrderService.createFullOrder(C, S3, { customer: { id: ids.customerId }, items: [{ variantId: o3item.variantId, quantity: 1 }] }, 'POS');
  await salesOrderService.confirmOrder(C, o3.id);
  const ds3 = await api.delete(`/locations/${S3}`);
  check('deleting a store with a confirmed order waiting to go out: refused in plain words', ds3.status >= 400 && plain(ds3), brief(ds3));

  console.log('\nD. RECEIVING A PURCHASE ORDER');
  const sup = await prisma.supplier.create({ data: { clientId: C, supplierCode: `UWS${STAMP}`, name: `UW Weavers ${STAMP}`, isActive: true } as any });
  const rec = await item('RECV', {});
  const po = data(await api.post('/purchase-orders', { supplierId: sup.id, locationId: MAIN, items: [{ variantId: rec.variantId, orderedQty: 5, unitPrice: 400 }] }));
  await api.put(`/purchase-orders/${po?.id}/status`, { status: 'SENT' });
  const poItem = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { poId: po.id } });
  const body = { receipts: [{ poItemId: poItem.id, quantityReceived: 5 }], locationId: MAIN, receivedByName: 'Ravi' };
  const [r1, r2] = await Promise.all([api.post(`/purchase-orders/${po.id}/receive`, body), api.post(`/purchase-orders/${po.id}/receive`, body)]);
  check('the same 5 received twice at the same moment: 5 in stock, not 10', await stockAt(rec.variantId, MAIN) === 5, `${brief(r1)} | ${brief(r2)} | stock ${await stockAt(rec.variantId, MAIN)}`);
  const refused = [r1, r2].find(r => r.status >= 400);
  check('  ...the second press is refused in plain words (or answered as already received)', !refused || plain(refused), refused ? brief(refused) : '');
  const rec2 = await item('RECV2', {});
  const po2 = data(await api.post('/purchase-orders', { supplierId: sup.id, locationId: MAIN, items: [{ variantId: rec2.variantId, orderedQty: 5, unitPrice: 400 }] }));
  await api.put(`/purchase-orders/${po2?.id}/status`, { status: 'SENT' });
  const po2Item = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { poId: po2.id } });
  const over = await api.post(`/purchase-orders/${po2.id}/receive`, { receipts: [{ poItemId: po2Item.id, quantityReceived: 50 }], locationId: MAIN, receivedByName: 'Ravi' });
  check('receiving 50 against 5 ordered: refused in plain words, or capped at 5 -- never 50 in stock', (over.status >= 400 && plain(over)) || await stockAt(rec2.variantId, MAIN) <= 5, `${brief(over)} stock ${await stockAt(rec2.variantId, MAIN)}`);
  const zero = await api.post(`/purchase-orders/${po2.id}/receive`, { receipts: [{ poItemId: po2Item.id, quantityReceived: 0 }], locationId: MAIN, receivedByName: 'Ravi' });
  check('receiving 0: refused in plain words, nothing changes', zero.status >= 400 && plain(zero), brief(zero));

  console.log('\nE. AN ITEM CODE CHANGED WHILE IT SITS ON A SHELF');
  const ren = await item('RENAME', { [MAIN]: 2 });
  const mainArea = data(await api.post(`/shelves/locations/${MAIN}/spots`, { kind: 'AREA', code: `UR${STAMP}`, isShopFloor: true }));
  const mainShelf = data(await api.post(`/shelves/locations/${MAIN}/spots`, { parentId: mainArea?.id, kind: 'SHELF', code: '1' }));
  await api.post('/shelves/putaway', { locationId: MAIN, variantId: ren.variantId, spotId: mainShelf?.id, quantity: 2 });
  const newSku = `UW-${STAMP}-RENAMED`;
  const up = await api.patch(`/variants/${ren.variantId}`, { sku: newSku });
  check('(set-up) the item code changes', up.status < 300, brief(up));
  check('  ...the 2 pieces are still on the shelf', (await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId: mainShelf.id, variantId: ren.variantId } } }))?.quantity === 2);
  const found = await api.get('/shelves/find', { params: { q: newSku } });
  check('  ..."Where is it?" finds it by the NEW code, on that shelf', JSON.stringify(data(found)).includes(mainShelf.address ?? 'x'), brief(found));

  console.log('\nF. TWO STOCK CORRECTIONS AT THE SAME MOMENT');
  const adj = await item('ADJ', { [MAIN]: 5 });
  const minus = () => api.post('/inventory/adjustment', { variantId: adj.variantId, locationId: MAIN, quantity: -2, notes: 'verify-inventory-user-worst' });
  const results = await Promise.all([minus(), minus(), minus()]);
  const ok = results.filter(r => r.status < 300).length;
  const now = await stockAt(adj.variantId, MAIN);
  const rows = await prisma.inventoryTransaction.count({ where: { clientId: C, variantId: adj.variantId, type: 'ADJUSTMENT' as any } });
  check(`three "-2" corrections at once: the count equals 5 minus what was applied (${ok} applied)`, now === 5 - 2 * ok, `stock ${now}, applied ${ok}: ${results.map(r => r.status).join(',')}`);
  check('  ...one ledger row per applied correction, none lost or doubled', rows === ok, `${rows} rows for ${ok}`);
  const refusedAdj = results.find(r => r.status >= 400);
  check('  ...any refused one says why in plain words', !refusedAdj || plain(refusedAdj), refusedAdj ? brief(refusedAdj) : '');

  console.log('\nG. ODD CHARACTERS IN THE SEARCH BOX');
  // Search compares without case, which the database does with LIKE: a lone \ used to be a 500,
  // and % or _ matched every product in the shop.
  await item('PCT', { [MAIN]: 1 });
  const pctSku = `UW-${STAMP}-PCT`;
  for (const q of [String.fromCharCode(92), '%', '_', '%%', "'", '"']) {
    const r = await api.get('/search', { params: { q } });
    const hits = (data(r)?.products ?? []).length + (data(r)?.variants ?? []).length;
    check(`searching for ${JSON.stringify(q)} answers normally and matches nothing`, r.status === 200 && hits === 0, brief(r));
  }
  const exact = await api.get('/search', { params: { q: pctSku } });
  check('  ...and a real item code is still found', JSON.stringify(data(exact)).includes(pctSku), brief(exact));
}

main()
  .catch((e) => { failed++; console.error(e); })
  .finally(async () => {
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
