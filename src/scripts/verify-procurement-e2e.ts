/**
 * Suppliers, purchase orders, variants and price changes, on a throwaway tenant.
 *
 * This is the oldest and least glamorous part of the product, and the part a shopkeeper
 * actually lives in. It is also where a mistake costs money rather than embarrassment: a
 * receipt that moves the wrong quantity, a cost that does not update, a partial delivery
 * recorded as a whole one.
 *
 * Run against its own tenant rather than a real shop's, because it creates real records and
 * moves real stock. Everything it makes, it removes.
 *
 *   npx ts-node src/scripts/verify-procurement-e2e.ts
 */
import { prisma } from '../lib/prisma';
import { supplierService } from '../services/supplier.service';
import { purchaseOrderService } from '../services/purchase-order.service';
import { variantService } from '../services/variant.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `proc-e2e-${Date.now()}`;

async function stockOf(variantId: string, locationId: string) {
  const s = await prisma.inventoryStock.findFirst({ where: { variantId, locationId } });
  return s?.quantity ?? 0;
}

async function main() {
  let locationId = '';
  try {
    // ─── SETUP ──────────────────────────────────────────────────────────────
    const location = await prisma.stockLocation.create({
      data: { clientId: CLIENT, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE' }
    });
    locationId = location.id;

    const product = await prisma.product.create({
      data: {
        clientId: CLIENT, productCode: 'PRD-PROC-1', slug: `proc-${Date.now()}`,
        title: 'Procurement Test Saree', category: 'WOMEN', productType: 'READY_TO_WEAR',
        dressType: 'Saree', status: 'ACTIVE', basePrice: 3000
      }
    });

    // The path the Add Variants screen actually uses. It matters which one is tested: the
    // browser composes the SKU itself, as SE-<random 0-999>-<COLOUR>-<SIZE>, so two variants
    // of the same colour and size compete for a thousand values across the WHOLE catalogue --
    // there is no product in the string. A shop with a hundred red mediums is near-certain to
    // collide, and [clientId, sku] is unique, so the insert would fail.
    console.log('VARIANTS ARE ADDED THE WAY THE SCREEN ADDS THEM');
    const made: any = await variantService.bulkCreateVariants(product.id, CLIENT, [
      { sku: 'SE-101-RED-M', size: 'M', colorName: 'Red', sellingPrice: 3500, costPrice: 2000, reorderLevel: 5, quantity: 0 },
      { sku: 'SE-102-RED-L', size: 'L', colorName: 'Red', sellingPrice: 3500, costPrice: 2000, reorderLevel: 5, quantity: 0 }
    ], locationId);
    check('both variants are created', made?.created === 2, JSON.stringify({created: made?.created, skipped: made?.skipped}));

    const vs = await prisma.productVariant.findMany({ where: { clientId: CLIENT }, orderBy: { variantCode: 'asc' } });
    const v1: any = vs[0], v2: any = vs[1];
    check('each carries a distinct SKU', !!v1?.sku && !!v2?.sku && v1.sku !== v2.sku, `${v1?.sku} / ${v2?.sku}`);
    check('and a distinct variant code', v1?.variantCode !== v2?.variantCode);

    console.log('\nA COLLIDING SKU IS RESOLVED, NOT REJECTED');
    // The browser can and will propose a SKU that is already taken. Failing the row would lose
    // the variant; taking it silently would give the user a code they never saw.
    const clash: any = await variantService.bulkCreateVariants(product.id, CLIENT, [
      { sku: v1.sku, size: 'XL', colorName: 'Red', sellingPrice: 3500, costPrice: 2000, reorderLevel: 5, quantity: 0 }
    ], locationId);
    check('the colliding row is still created', clash?.created === 1, JSON.stringify({created: clash?.created, skipped: clash?.skipped}));
    check('and the caller is told which SKU was actually used',
      Array.isArray(clash?.adjusted) && clash.adjusted.length === 1,
      JSON.stringify(clash?.adjusted));

    console.log('\nA PRICE CHANGE STICKS');
    await variantService.updateVariant(v1.id, CLIENT, { sellingPrice: 4200 });
    const priced = await prisma.productVariant.findUnique({ where: { id: v1.id } });
    check('the new selling price is stored', Number(priced?.sellingPrice) === 4200, String(priced?.sellingPrice));

    // The bulk path is the one a CSV import uses, and the one that was fanning out unboundedly.
    await variantService.bulkUpdateVariants(CLIENT,
      [{ sku: v1.sku, sellingPrice: 4500 }, { sku: v2.sku, sellingPrice: 4600 }], locationId);
    const [b1, b2] = await Promise.all([
      prisma.productVariant.findUnique({ where: { id: v1.id } }),
      prisma.productVariant.findUnique({ where: { id: v2.id } })
    ]);
    check('a bulk price change updates every row', Number(b1?.sellingPrice) === 4500 && Number(b2?.sellingPrice) === 4600,
      `${b1?.sellingPrice}, ${b2?.sellingPrice}`);

    console.log('\nA SUPPLIER CAN BE CREATED AND FOUND');
    const supplier: any = await supplierService.createSupplier(CLIENT,
      { name: 'Test Weavers Ltd', email: 'weavers@example.com', phone: '9999999999' });
    check('the supplier is created', !!supplier?.id, supplier?.name);
    const suppliers: any = await supplierService.getSuppliers(CLIENT);
    const list = Array.isArray(suppliers) ? suppliers : (suppliers?.data ?? []);
    check('and appears in the list', list.some((s: any) => s.id === supplier.id), `${list.length} suppliers`);

    console.log('\nA PURCHASE ORDER GOES FROM DRAFT TO RECEIVED');
    const po: any = await purchaseOrderService.createPO(CLIENT, {
      supplierId: supplier.id,
      items: [
        { variantId: v1.id, orderedQty: 10, unitPrice: 2500 },
        { variantId: v2.id, orderedQty: 6, unitPrice: 2500 }
      ]
    });
    check('a PO is created', !!po?.id, po?.poNumber);
    check('it starts as a draft', po?.status === 'DRAFT', po?.status);
    check('its total is the sum of its lines', Number(po?.totalAmount) === 10 * 2500 + 6 * 2500,
      String(po?.totalAmount));

    await purchaseOrderService.updatePOStatus(CLIENT, po.id, 'SENT');
    const sent: any = await purchaseOrderService.getPOById(CLIENT, po.id);
    check('sending it moves the status', sent?.status === 'SENT', sent?.status);

    console.log('\nRECEIVING PART OF IT MOVES ONLY WHAT ARRIVED');
    const before1 = await stockOf(v1.id, locationId);
    const items = sent.items ?? sent.poItems ?? [];
    const line1 = items.find((i: any) => i.variantId === v1.id);
    check('the PO carries its lines back', !!line1, `${items.length} lines`);

    await purchaseOrderService.receiveGoods(CLIENT, po.id, [
      { poItemId: line1.id, quantityReceived: 4, locationId }
    ]);

    const after1 = await stockOf(v1.id, locationId);
    check('stock rises by exactly what was received', after1 - before1 === 4, `${before1} -> ${after1}`);

    const other = await stockOf(v2.id, locationId);
    // The line that was not received must not move. This is the mistake that costs money.
    check('the line that did not arrive did not move', other === 0, String(other));

    const partial: any = await purchaseOrderService.getPOById(CLIENT, po.id);
    check('the PO reads as partially received', partial?.status === 'PARTIALLY_RECEIVED', partial?.status);

    console.log('\nRECEIVING THE REST COMPLETES IT');
    const p2 = (partial.items ?? []).find((i: any) => i.variantId === v1.id);
    const p3 = (partial.items ?? []).find((i: any) => i.variantId === v2.id);
    await purchaseOrderService.receiveGoods(CLIENT, po.id, [
      { poItemId: p2.id, quantityReceived: 6, locationId },
      { poItemId: p3.id, quantityReceived: 6, locationId }
    ]);

    const done: any = await purchaseOrderService.getPOById(CLIENT, po.id);
    check('the PO reads as received', done?.status === 'RECEIVED', done?.status);
    check('all ordered stock has arrived', await stockOf(v1.id, locationId) === 10, String(await stockOf(v1.id, locationId)));
    check('for both lines', await stockOf(v2.id, locationId) === 6, String(await stockOf(v2.id, locationId)));

    console.log('\nRECEIVING UPDATES WHAT THE GOODS COST');
    const costed = await prisma.productVariant.findUnique({ where: { id: v1.id } });
    // A receipt at a known unit price is the best cost information there is, and the whole
    // point of recording it is that valuation stops guessing from the selling price.
    check('the average cost reflects the purchase price', Number(costed?.averageCost) > 0,
      String(costed?.averageCost));
    check('and the last purchase cost is recorded', Number(costed?.lastPurchaseCost) === 2500,
      String(costed?.lastPurchaseCost));

    console.log('\nA TENANT CANNOT REACH ANOTHER TENANT\'S PROCUREMENT');
    const asStranger = await purchaseOrderService.getPOById('some-other-client', po.id).catch(() => null);
    check('the PO is invisible to another client', !asStranger);
    const strangerSuppliers: any = await supplierService.getSuppliers('some-other-client');
    const sl = Array.isArray(strangerSuppliers) ? strangerSuppliers : (strangerSuppliers?.data ?? []);
    check('and so is the supplier', !sl.some((s: any) => s.id === supplier.id));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    // Everything this made, it removes -- in dependency order.
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.purchaseOrderItem.deleteMany({ where: { po: { clientId: CLIENT } } }).catch(() => {});
    await prisma.purchaseOrder.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.productVariant.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.product.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.supplier.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    console.log('\n(test tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
