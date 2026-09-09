/**
 * What stock cost, and what happens when nobody ever said.
 *
 * Found from a real shop. sphl held 50 pieces of PRD-000001-PUR-Free Size with no cost of any
 * kind, and raised a purchase order for one more at 4,999. Receiving it would have set the
 * cost of that saree to 4999 / 51 = 98 rupees, because the fifty already there were being
 * averaged in as though they were free.
 *
 * They were not free. Nobody had said what they cost. Those are different statements, and the
 * whole bug is that the code could not tell them apart -- opening stock enters through
 * applyInitialStock, which never passed a cost, so averageCost sat at 0 and 0 went into the
 * average as a fact.
 *
 * Every serious inventory system refuses an opening quantity without an opening rate for
 * exactly this reason, and every one of them also ships a way to restate the cost of stock
 * already held. This checks all three: the cost is carried in, an unknown is not treated as
 * zero, and stock already in the bad state can be repaired.
 *
 *   npx ts-node src/scripts/verify-cost-of-stock.ts
 */
import { prisma } from '../lib/prisma';
import { variantService } from '../services/variant.service';
import { valuationService } from '../services/valuation.service';
import { inventoryMutationService } from '../services/inventory-mutation.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `cost-${Date.now()}`;
const OTHER = `cost-other-${Date.now()}`;

const costOf = async (variantId: string) => {
  const v = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { averageCost: true, costPrice: true, lastPurchaseCost: true, inventoryValue: true, stocks: { select: { quantity: true } } }
  });
  return {
    averageCost: Number(v?.averageCost ?? 0),
    costPrice: Number(v?.costPrice ?? 0),
    lastPurchaseCost: Number(v?.lastPurchaseCost ?? 0),
    inventoryValue: Number(v?.inventoryValue ?? 0),
    qty: (v?.stocks ?? []).reduce((s, x) => s + x.quantity, 0)
  };
};

async function main() {
  let location: any, product: any;
  try {
    location = await prisma.stockLocation.create({
      data: { clientId: CLIENT, name: 'Chirala', code: 'CHIRALA', type: 'STORE', active: true }
    });
    product = await prisma.product.create({
      data: {
        clientId: CLIENT, title: 'Kanjivaram Saree', productCode: 'PRD-COST-1',
        slug: `cost-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 5000
      }
    });

    // --- OPENING STOCK CARRIES ITS COST -------------------------------------
    console.log('OPENING STOCK IS VALUED AT THE COST THE MERCHANT TYPED');
    const costed: any = await variantService.createVariant(product.id, CLIENT, {
      sku: `COST-A-${Date.now()}`, size: 'Free', colorName: 'Purple',
      quantity: 50, reorderLevel: 5, costPrice: 3000, sellingPrice: 5000
    }, location.id);
    const a = await costOf(costed.id);
    check('fifty pieces are on hand', a.qty === 50, String(a.qty));
    check('and they are valued at what they cost', a.averageCost === 3000, String(a.averageCost));
    check('so the stock is worth 50 x 3000', a.inventoryValue === 150000, String(a.inventoryValue));

    console.log('\nAND A LATER PURCHASE AVERAGES AGAINST IT PROPERLY');
    // Nothing clever here -- this is ordinary weighted average and it must stay ordinary.
    await inventoryMutationService.applyMovement({
      clientId: CLIENT, locationId: location.id, variantId: costed.id,
      movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 10, unitCost: 4000
    });
    const b = await costOf(costed.id);
    // (150000 + 40000) / 60 = 3166.67
    check('the average moves towards the new price, not to it',
      Math.abs(b.averageCost - 190000 / 60) < 0.01, String(b.averageCost));

    // --- THE REAL CASE ------------------------------------------------------
    console.log('\nSTOCK NOBODY COSTED IS UNVALUED, NOT FREE');
    // Exactly sphl's variant: 50 pieces in with no cost, then one bought at 4,999.
    const uncosted: any = await variantService.createVariant(product.id, CLIENT, {
      sku: `COST-B-${Date.now()}`, size: 'Free', colorName: 'Green',
      quantity: 50, reorderLevel: 5
    }, location.id);
    const c = await costOf(uncosted.id);
    check('fifty pieces are on hand', c.qty === 50, String(c.qty));
    check('with no cost recorded anywhere', c.averageCost === 0 && c.costPrice === 0, JSON.stringify(c));

    await inventoryMutationService.applyMovement({
      clientId: CLIENT, locationId: location.id, variantId: uncosted.id,
      movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 1, unitCost: 4999
    });
    const d = await costOf(uncosted.id);
    check('the first real cost is what the stock is worth, not 4999/51',
      d.averageCost === 4999, `${d.averageCost} (the old behaviour gave ${(4999 / 51).toFixed(2)})`);
    check('and all 51 pieces are valued at it', d.inventoryValue === 51 * 4999, String(d.inventoryValue));

    console.log('\nBUT ONLY THE FIRST TIME -- AFTER THAT IT IS ORDINARY AVERAGING');
    // The exception exists to get out of "unknown". Once a cost is known it must never fire
    // again, or every receipt would overwrite the average and weighted-average costing would
    // silently become last-price costing.
    await inventoryMutationService.applyMovement({
      clientId: CLIENT, locationId: location.id, variantId: uncosted.id,
      movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 9, unitCost: 1000
    });
    const e = await costOf(uncosted.id);
    // (51*4999 + 9*1000) / 60 = 4399.15
    check('a cheaper second purchase pulls the average down, it does not replace it',
      Math.abs(e.averageCost - (51 * 4999 + 9000) / 60) < 0.01, String(e.averageCost));
    check('and it is not simply the latest price', e.averageCost !== 1000, String(e.averageCost));

    console.log('\nA COST TYPED BY HAND IS AN ANSWER, AND IS WEIGHTED AGAINST');
    // The gap the first version of this fix left. A merchant who never entered opening cost
    // but later types one into the variant has told us what their stock cost -- and the
    // stored inventoryValue is still zero, because only costed movements maintain it.
    // Weighting against the stored total alone would throw their answer away and dilute
    // exactly as before.
    const typed: any = await variantService.createVariant(product.id, CLIENT, {
      sku: `COST-D-${Date.now()}`, size: 'Free', colorName: 'Blue', quantity: 50, reorderLevel: 5
    }, location.id);
    await prisma.productVariant.update({ where: { id: typed.id }, data: { costPrice: 3000 } });
    const typedBefore = await costOf(typed.id);
    check('the typed cost is there but the stored value is not',
      typedBefore.costPrice === 3000 && typedBefore.inventoryValue === 0, JSON.stringify(typedBefore));

    await inventoryMutationService.applyMovement({
      clientId: CLIENT, locationId: location.id, variantId: typed.id,
      movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: 1, unitCost: 4999
    });
    const typedAfter = await costOf(typed.id);
    // (50 x 3000 + 4999) / 51 = 3039.20 -- the typed cost is respected and averaged against.
    check('the new purchase is averaged against what they said it cost',
      Math.abs(typedAfter.averageCost - (50 * 3000 + 4999) / 51) < 0.01, String(typedAfter.averageCost));
    check('which is nowhere near the diluted figure', typedAfter.averageCost > 3000,
      `${typedAfter.averageCost} (dilution would have given ${(4999 / 51).toFixed(2)})`);

    console.log('\nTYPING A COST ONTO UNVALUED STOCK VALUES THAT STOCK');
    // What a merchant plainly means. Someone with fifty sarees who types 3,000 into the cost
    // box is saying these cost me three thousand each -- not merely filling in a label.
    const viaField: any = await variantService.createVariant(product.id, CLIENT, {
      sku: `COST-E-${Date.now()}`, size: 'Free', colorName: 'Gold', quantity: 20, reorderLevel: 5
    }, location.id);
    await variantService.updateVariant(viaField.id, CLIENT, { costPrice: 3500 });
    const field = await costOf(viaField.id);
    check('the stock is now valued at what they typed', field.averageCost === 3500, String(field.averageCost));
    check('and the shop is worth 20 x 3500', field.inventoryValue === 70000, String(field.inventoryValue));

    console.log('\nBUT IT DOES NOT OVERWRITE A COST REALLY PAID');
    // A variant costed by actual receipts must not have that quietly replaced by a typed
    // figure. Correcting a real cost is a deliberate revaluation, not a side effect of
    // editing a field.
    await variantService.updateVariant(costed.id, CLIENT, { costPrice: 99 });
    const stillReal = await costOf(costed.id);
    check('the receipted average survives a typed cost',
      Math.abs(stillReal.averageCost - 190000 / 60) < 0.01, String(stillReal.averageCost));

    // --- REPAIRING WHAT IS ALREADY WRONG ------------------------------------
    console.log('\nSTOCK ALREADY HELD WITH NO COST CAN BE PUT RIGHT');
    // No purchase order can fix this: buying more adds to the average, it does not restate
    // what is already on the shelf. Odoo calls this Inventory Revaluation, ERPNext calls it
    // Stock Reconciliation; this product had nothing.
    const stranded: any = await variantService.createVariant(product.id, CLIENT, {
      sku: `COST-C-${Date.now()}`, size: 'Free', colorName: 'Red', quantity: 40, reorderLevel: 5
    }, location.id);
    const before = await costOf(stranded.id);
    check('it starts with no value at all', before.inventoryValue === 0, String(before.inventoryValue));

    const result: any = await valuationService.setCostOfStockOnHand(CLIENT, stranded.id, 2500, {
      performedBy: 'Akshaya', notes: 'Opening stock costed after the fact.'
    });
    const after = await costOf(stranded.id);
    check('it says how many units it restated', result?.unitsRevalued === 40, String(result?.unitsRevalued));
    check('the cost is now what was entered', after.averageCost === 2500, String(after.averageCost));
    check('the typed cost field agrees with it', after.costPrice === 2500, String(after.costPrice));
    check('the stock is worth 40 x 2500', after.inventoryValue === 100000, String(after.inventoryValue));
    check('and not one piece moved', after.qty === before.qty, `${before.qty} -> ${after.qty}`);

    console.log('\nAND THE RESTATEMENT IS RECORDED, NOT SILENT');
    // Changing what stock is worth is exactly the kind of thing someone needs to find later.
    const record = await prisma.inventoryTransaction.findFirst({
      where: { variantId: stranded.id, referenceType: 'REVALUATION' },
      select: { quantity: true, balanceBefore: true, balanceAfter: true, unitCost: true, createdBy: true, notes: true }
    });
    check('a movement row exists for it', !!record);
    check('showing no quantity change', record?.quantity === 0, String(record?.quantity));
    check('the same balance either side', record?.balanceBefore === record?.balanceAfter,
      `${record?.balanceBefore} -> ${record?.balanceAfter}`);
    check('the new cost', Number(record?.unitCost) === 2500, String(record?.unitCost));
    check('and who did it', record?.createdBy === 'Akshaya', String(record?.createdBy));

    console.log('\nIT REFUSES WHAT WOULD MAKE THINGS WORSE');
    let zero: any = null, negative: any = null, cross: any = null;
    await valuationService.setCostOfStockOnHand(CLIENT, stranded.id, 0).catch(e => { zero = e; });
    await valuationService.setCostOfStockOnHand(CLIENT, stranded.id, -5).catch(e => { negative = e; });
    await valuationService.setCostOfStockOnHand(OTHER, stranded.id, 900).catch(e => { cross = e; });
    check('a cost of zero is refused', zero?.statusCode === 400, String(zero?.statusCode));
    check('so is a negative one', negative?.statusCode === 400, String(negative?.statusCode));
    check('and another shop cannot revalue this stock', cross?.statusCode === 404, String(cross?.statusCode));
    const untouched = await costOf(stranded.id);
    check('none of which changed anything', untouched.averageCost === 2500, String(untouched.averageCost));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    const where = { clientId: { in: [CLIENT, OTHER] } };
    await prisma.inventoryTransaction.deleteMany({ where }).catch(() => {});
    await prisma.inventoryEvent.deleteMany({ where }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where }).catch(() => {});
    await prisma.productVariant.deleteMany({ where }).catch(() => {});
    await prisma.product.deleteMany({ where }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory_client_sequences WHERE client_id = ANY($1::text[])`, [CLIENT, OTHER]).catch(() => {});
    console.log('\n(test tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
