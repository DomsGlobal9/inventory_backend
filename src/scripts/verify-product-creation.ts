/**
 * What a merchant is asked when they add a product, and what survives the asking.
 *
 * Three things were missing from the point where a shop actually knows the answer.
 *
 * The cost. Adding a product asked for a quantity and never for a cost, so opening stock
 * entered unvalued -- and the first purchase order was then averaged against a zero that was
 * never true. That is how a 4,999 saree came out at 98 rupees.
 *
 * The supplier. The link between a variant and who supplies it was created only as a side
 * effect of raising a purchase order, so every supplier's item list stayed empty until after
 * you had already ordered from them, and reordering could not suggest anyone.
 *
 * The price of one variant. There was a single Base Price for the whole product, so a plus
 * size or a heavier zari border could not be priced differently without editing every variant
 * afterwards, one at a time. 282 of the 344 variants on this platform have no price of their
 * own for exactly this reason -- and every margin warning that read the variant's price alone
 * stayed silent for all of them.
 *
 *   npx ts-node src/scripts/verify-product-creation.ts
 */
import { prisma } from '../lib/prisma';
import { variantService } from '../services/variant.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `create-${Date.now()}`;
const OTHER = `create-other-${Date.now()}`;

async function main() {
  try {
    const location = await prisma.stockLocation.create({
      data: { clientId: CLIENT, name: 'Chirala', code: 'CHIRALA', type: 'STORE', active: true }
    });
    const supplier = await prisma.supplier.create({
      data: { clientId: CLIENT, supplierCode: 'SUP-C-1', name: 'Kanchi Silk House', email: 'kanchi@example.com' }
    });
    const strangersSupplier = await prisma.supplier.create({
      data: { clientId: OTHER, supplierCode: 'SUP-X-1', name: 'Another Shop Supplier' }
    });
    const product = await prisma.product.create({
      data: {
        clientId: CLIENT, title: 'Kanjivaram Saree', productCode: 'PRD-CR-1',
        slug: `create-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 5000
      }
    });

    // --- WHAT THE WIZARD NOW SENDS ------------------------------------------
    console.log('ADDING A PRODUCT CARRIES THE COST, THE PRICE AND THE SUPPLIER');
    const stamp = Date.now();
    const result: any = await variantService.bulkCreateVariants(product.id, CLIENT, [
      // Priced at the product's price, which is the common case.
      { sku: `CR-${stamp}-A`, size: 'Free', colorName: 'Purple', quantity: 20, reorderLevel: 5, costPrice: 3000 },
      // Priced for itself -- the heavier one costs more and sells for more.
      { sku: `CR-${stamp}-B`, size: 'XL', colorName: 'Green', quantity: 10, reorderLevel: 5, costPrice: 3500, sellingPrice: 6200 }
    ], location.id, false, supplier.id);

    check('both variants are created', result?.created === 2, JSON.stringify({ created: result?.created, skipped: result?.skipped }));

    const made = await prisma.productVariant.findMany({
      where: { clientId: CLIENT }, orderBy: { sku: 'asc' },
      include: { stocks: true }
    });
    const [a, b] = made;

    console.log('\nTHE COST IS SAVED, AND THE STOCK IS VALUED BY IT');
    check('the cost is on the variant', Number(a.costPrice) === 3000, String(a.costPrice));
    // The whole point. Without it the pieces enter unvalued and the first purchase order
    // averages against a zero.
    check('the opening stock is valued at that cost', Number(a.averageCost) === 3000, String(a.averageCost));
    check('so twenty pieces are worth 60,000', Number(a.inventoryValue) === 60000, String(a.inventoryValue));

    console.log('\nA VARIANT CAN CARRY ITS OWN PRICE');
    check('the one that was priced for itself kept that price',
      Number(b.sellingPrice) === 6200, String(b.sellingPrice));
    check('and the one that was not has none, so it falls back to the product',
      a.sellingPrice === null || Number(a.sellingPrice) === 0, String(a.sellingPrice));

    console.log('\nTHE SUPPLIER IS LINKED IMMEDIATELY, NOT AFTER THE FIRST ORDER');
    const links = await prisma.supplierProduct.findMany({
      where: { clientId: CLIENT, supplierId: supplier.id }
    });
    check('every new variant is linked to them', links.length === 2, `${links.length} links`);
    check('carrying what each one cost',
      links.every(l => Number(l.costPrice) > 0),
      JSON.stringify(links.map(l => Number(l.costPrice))));

    console.log('\nAND A SUPPLIER FROM ANOTHER SHOP IS IGNORED, NOT LINKED');
    // A supplierId is chosen in a browser and can be anything by the time it reaches here.
    // Linking one tenant's variants to another tenant's supplier would put this shop's buying
    // prices on a screen it does not own.
    const p2 = await prisma.product.create({
      data: {
        clientId: CLIENT, title: 'Cotton Saree', productCode: 'PRD-CR-2',
        slug: `create2-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1200
      }
    });
    await variantService.bulkCreateVariants(p2.id, CLIENT, [
      { sku: `CR-${stamp}-C`, size: 'Free', colorName: 'Blue', quantity: 5, reorderLevel: 5, costPrice: 800 }
    ], location.id, false, strangersSupplier.id);
    const leaked = await prisma.supplierProduct.findMany({ where: { supplierId: strangersSupplier.id } });
    check('no link is made to the stranger', leaked.length === 0, `${leaked.length} links`);

    const survived = await prisma.productVariant.count({ where: { clientId: CLIENT, sku: `CR-${stamp}-C` } });
    check('but the variant itself is still created', survived === 1,
      'a supplier that cannot be linked must never lose the stock');

    console.log('\nNO SUPPLIER IS A NORMAL ANSWER, NOT AN ERROR');
    // Plenty of stock is made in-house or has no supplier worth recording.
    const p3 = await prisma.product.create({
      data: {
        clientId: CLIENT, title: 'House Blouse', productCode: 'PRD-CR-3',
        slug: `create3-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 400
      }
    });
    const noSupplier: any = await variantService.bulkCreateVariants(p3.id, CLIENT, [
      { sku: `CR-${stamp}-D`, size: 'Free', colorName: 'White', quantity: 3, reorderLevel: 2 }
    ], location.id, false, undefined);
    check('the variant is created without one', noSupplier?.created === 1, JSON.stringify(noSupplier?.errors));

    console.log('\nAND STOCK WITH NO COST IS STILL ALLOWED, JUST UNVALUED');
    // Requiring a cost would block a merchant who genuinely does not know it yet. What must
    // not happen is calling the unknown zero.
    const d = await prisma.productVariant.findFirst({ where: { clientId: CLIENT, sku: `CR-${stamp}-D` } });
    check('it has no cost', Number(d?.averageCost ?? 0) === 0, String(d?.averageCost));
    check('and no value, rather than a made-up one', Number(d?.inventoryValue ?? 0) === 0, String(d?.inventoryValue));

    console.log('\nTHE PRICE A VARIANT ACTUALLY SELLS AT IS REPORTED TO THE PO SCREEN');
    // The margin warning on a purchase order compares the cost being entered against what the
    // item sells for. It read the variant's own price alone, which most variants do not have,
    // so it stayed silent for 82% of this platform's catalogue.
    const search: any = await variantService.searchVariants(CLIENT, {
      q: `CR-${stamp}-A`, page: 1, limit: 5, includeCosting: true
    });
    const found = (search?.items ?? []).find((i: any) => i.sku === `CR-${stamp}-A`);
    check('the search finds it', !!found, String(search?.items?.length));
    check('it has no price of its own', !found?.sellingPrice, String(found?.sellingPrice));
    check("but reports the product's price as what it sells for",
      Number(found?.effectiveSellingPrice) === 5000, String(found?.effectiveSellingPrice));

    const foundB = (await variantService.searchVariants(CLIENT, { q: `CR-${stamp}-B`, page: 1, limit: 5 }) as any)
      ?.items?.find((i: any) => i.sku === `CR-${stamp}-B`);
    check("and a variant with its own price reports that instead",
      Number(foundB?.effectiveSellingPrice) === 6200, String(foundB?.effectiveSellingPrice));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    const where = { clientId: { in: [CLIENT, OTHER] } };
    await prisma.supplierProduct.deleteMany({ where }).catch(() => {});
    await prisma.inventoryTransaction.deleteMany({ where }).catch(() => {});
    await prisma.inventoryEvent.deleteMany({ where }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where }).catch(() => {});
    await prisma.productVariant.deleteMany({ where }).catch(() => {});
    await prisma.product.deleteMany({ where }).catch(() => {});
    await prisma.supplier.deleteMany({ where }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory_client_sequences WHERE client_id = ANY($1::text[])`, [CLIENT, OTHER]).catch(() => {});
    console.log('\n(test tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
