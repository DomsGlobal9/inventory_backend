/**
 * What a real shop's spreadsheet does to the importer.
 *
 * The happy path and the obvious errors were already covered. These are the ones a person
 * actually produces: the same saree typed in twice under two keys, a SKU copied from another
 * product, a ProductCode from a shop they used to work at, a file re-uploaded because they
 * were not sure it worked the first time.
 *
 * Everything runs in a throwaway tenant that is deleted at the end, so this can be run against
 * the live database without touching a real shop.
 *
 *   npx tsx src/scripts/verify-import-scenarios.ts
 */
import { prisma } from '../lib/prisma';
import { productImportService } from '../services/product-import.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `imp-${Date.now()}`;
const OTHER = `imp-other-${Date.now()}`;
const USER = 'importer-user';
const ALL = ['*'];

let rowNo = 1;
const row = (r: Record<string, any>) => ({ rowNumber: ++rowNo, ...r });

const plan = (rows: any[], perms = ALL) =>
  productImportService.plan(CLIENT, rows as any, perms);
const apply = async (rows: any[], perms = ALL) => {
  const p = await plan(rows, perms);
  if (!p.canApply) throw new Error('plan refused: ' + JSON.stringify(p.errors));
  return productImportService.apply(CLIENT, rows as any, perms, USER, p.fingerprint);
};

const errorsSay = (p: any, fragment: string) =>
  p.errors.some((e: any) => String(e.message).toLowerCase().includes(fragment.toLowerCase()));
const warningsSay = (p: any, fragment: string) =>
  p.warnings.some((w: any) => String(w.message).toLowerCase().includes(fragment.toLowerCase()));

async function main() {
  try {
    await prisma.stockLocation.create({
      data: { clientId: CLIENT, name: 'Main Store', code: 'MAIN', type: 'STORE', active: true }
    });
    await prisma.stockLocation.create({
      data: { clientId: OTHER, name: 'Other Store', code: 'MAIN', type: 'STORE', active: true }
    });

    // ── A. THE SAME NAME TWICE ─────────────────────────────────────────────
    console.log('\nA. TWO PRODUCTS WITH THE SAME NAME');

    const twoKeys = [
      row({ productKey: 'saree-a', title: 'Kanchipuram Silk Saree', category: 'WOMEN', basePrice: 12500, size: 'Free Size', color: 'Red', quantity: 2 }),
      row({ productKey: 'saree-b', title: 'Kanchipuram Silk Saree', category: 'WOMEN', basePrice: 12500, size: 'Free Size', color: 'Blue', quantity: 2 })
    ];
    const pTwoKeys = await plan(twoKeys);
    check('two keys, one title, is allowed', pTwoKeys.canApply, JSON.stringify(pTwoKeys.errors));
    check('...but the file is warned that the name is used twice',
      warningsSay(pTwoKeys, 'created twice by this file'), JSON.stringify(pTwoKeys.warnings));

    await apply(twoKeys);
    const made = await prisma.product.findMany({ where: { clientId: CLIENT }, select: { productCode: true, title: true, status: true } });
    check('two keys really do make two products', made.length === 2, JSON.stringify(made));

    const sameNameAgain = [
      row({ productKey: 'saree-c', title: 'Kanchipuram Silk Saree', category: 'WOMEN', basePrice: 9000, size: 'Free Size', color: 'Green', quantity: 1 })
    ];
    const pSameName = await plan(sameNameAgain);
    check('a name the shop ALREADY has is warned about too',
      warningsSay(pSameName, 'already'), JSON.stringify(pSameName.warnings));
    check('...and is still allowed, because a shop may genuinely have two',
      pSameName.canApply, JSON.stringify(pSameName.errors));

    // ── B. IMPORTED PRODUCTS ARE SELLABLE ──────────────────────────────────
    console.log('\nB. WHAT AN IMPORTED PRODUCT IS WHEN IT ARRIVES');

    check('it arrives as a draft, because it has no photographs',
      made.every(p => p.status === 'DRAFT'), JSON.stringify(made.map(p => p.status)));
    check('the preview says so, rather than leaving it to be discovered',
      warningsSay(pTwoKeys, 'draft'), JSON.stringify(pTwoKeys.warnings));

    // ── C. SKUs THAT ALREADY BELONG TO SOMETHING ───────────────────────────
    console.log('\nC. A SKU THAT IS ALREADY SOMEBODY ELSE\'S');

    const first = made[0]!;
    const second = made[1]!;
    const firstsVariant = await prisma.productVariant.findFirst({
      where: { clientId: CLIENT, product: { productCode: first.productCode } },
      select: { sku: true }
    });

    const stolenSku = [
      row({ productCode: second.productCode, sku: firstsVariant!.sku, size: 'M', color: 'Black', sellingPrice: 100 })
    ];
    check('a SKU belonging to another product is refused',
      errorsSay(await plan(stolenSku), 'belongs to a different product'),
      JSON.stringify((await plan(stolenSku)).errors));

    const skuOnNewProduct = [
      row({ productKey: 'saree-d', title: 'New One', category: 'WOMEN', basePrice: 500, sku: firstsVariant!.sku, size: 'M', color: 'Black' })
    ];
    check('an existing SKU cannot be used to create a NEW product',
      errorsSay(await plan(skuOnNewProduct), 'cannot create a new product'),
      JSON.stringify((await plan(skuOnNewProduct)).errors));

    const dupeInFile = [
      row({ productCode: first.productCode, sku: 'DUPE-1', size: 'M', color: 'Black', sellingPrice: 100 }),
      row({ productCode: first.productCode, sku: 'DUPE-1', size: 'L', color: 'White', sellingPrice: 100 })
    ];
    check('the same SKU twice in one file is refused',
      errorsSay(await plan(dupeInFile), 'more than once'),
      JSON.stringify((await plan(dupeInFile)).errors));

    const sameProductSku = [
      row({ productCode: first.productCode, sku: firstsVariant!.sku, sellingPrice: 13000 })
    ];
    const pSameProduct = await plan(sameProductSku);
    check('its OWN SKU updates the variant rather than being refused',
      pSameProduct.canApply && pSameProduct.summary.updatedVariants === 1,
      JSON.stringify({ errors: pSameProduct.errors, summary: pSameProduct.summary }));

    // ── D. A PRODUCTCODE THAT IS NOT THIS SHOP'S ───────────────────────────
    console.log('\nD. A PRODUCTCODE FROM SOMEWHERE ELSE');

    const strangersProduct = await prisma.product.create({
      data: {
        clientId: OTHER, title: "Another Shop's Saree", productCode: 'PRD-STRANGER',
        slug: `stranger-${Date.now()}`, category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 1
      }
    });
    const foreign = [row({ productCode: strangersProduct.productCode, sellingPrice: 999, size: 'M', color: 'Red' })];
    check("another shop's ProductCode is not found",
      errorsSay(await plan(foreign), 'does not exist'),
      JSON.stringify((await plan(foreign)).errors));

    const strangersTitle = await prisma.product.findFirst({ where: { clientId: OTHER }, select: { title: true } });
    check("and another shop's product title does not trigger the duplicate-name warning",
      !warningsSay(await plan([
        row({ productKey: 'iso-1', title: strangersTitle!.title, category: 'WOMEN', basePrice: 100, size: 'M', color: 'Red' })
      ]), 'already'));

    const madeUp = [row({ productCode: 'PRD-999999', sellingPrice: 100, size: 'M', color: 'Red' })];
    check('a ProductCode that exists nowhere is refused', errorsSay(await plan(madeUp), 'does not exist'));

    // ── E. THINGS A NEW PRODUCT CANNOT DO WITHOUT ──────────────────────────
    console.log('\nE. A NEW PRODUCT WITH PIECES MISSING');

    check('no title', errorsSay(await plan([row({ productKey: 'x1', category: 'WOMEN', basePrice: 100, size: 'M' })]), 'title'));
    check('no category', errorsSay(await plan([row({ productKey: 'x2', title: 'T', basePrice: 100, size: 'M' })]), 'category'));
    check('no price', errorsSay(await plan([row({ productKey: 'x3', title: 'T', category: 'WOMEN', size: 'M' })]), 'price'));
    check('a category that is not one of ours',
      errorsSay(await plan([row({ productKey: 'x4', title: 'T', category: 'LADIES', basePrice: 100, size: 'M' })]), 'category'));
    check('no size and no colour',
      errorsSay(await plan([row({ productKey: 'x5', title: 'T', category: 'WOMEN', basePrice: 100 })]), 'size or a colour'));
    check('no key and no code at all',
      errorsSay(await plan([row({ title: 'T', category: 'WOMEN', basePrice: 100, size: 'M' })]), 'no way to tell'));

    // ── F. RUNNING THE SAME FILE AGAIN ─────────────────────────────────────
    console.log('\nF. THE SAME FILE, UPLOADED TWICE');

    const rerun = await plan(twoKeys);
    check('nothing new is created', rerun.summary.newProducts === 0 && rerun.summary.newVariants === 0,
      JSON.stringify(rerun.summary));
    check('the quantity is not counted again', warningsSay(rerun, 'importing it again would add the stock'),
      JSON.stringify(rerun.warnings));

    const stockBefore = await prisma.inventoryStock.aggregate({ where: { clientId: CLIENT }, _sum: { quantity: true } });
    await apply(twoKeys);
    const stockAfter = await prisma.inventoryStock.aggregate({ where: { clientId: CLIENT }, _sum: { quantity: true } });
    check('and the shelf does not double',
      Number(stockBefore._sum.quantity) === Number(stockAfter._sum.quantity),
      `${stockBefore._sum.quantity} -> ${stockAfter._sum.quantity}`);

    // ── G. THE COLOUR THE SHOP ALREADY KNOWS ───────────────────────────────
    console.log('\nG. A COLOUR THE CATALOGUE ALREADY HAS');

    await prisma.clientCatalogItem.create({
      data: {
        clientId: CLIENT, type: 'COLOR', value: 'blue', label: 'Blue', isSystem: true, isActive: true,
        metadata: { hex: '#0000ff', shades: [{ hex: '#4169e1', name: 'Royal Blue' }, { hex: '#87ceeb', name: 'Sky Blue' }] }
      }
    });

    const named = [
      row({ productKey: 'swatch-1', title: 'Swatch Test', category: 'WOMEN', basePrice: 100, size: 'Free Size', color: 'Royal Blue', quantity: 1 }),
      row({ productKey: 'swatch-1', size: 'Free Size', color: 'Not A Colour', quantity: 1 })
    ];
    await apply(named);
    const swatched = await prisma.productVariant.findMany({
      where: { clientId: CLIENT, product: { importKey: 'swatch-1' } },
      select: { colorName: true, hexCode: true }
    });
    const royal = swatched.find(v => v.colorName === 'Royal Blue');
    const unknown = swatched.find(v => v.colorName === 'Not A Colour');
    check('a colour named in the palette gets its swatch',
      royal?.hexCode === '#4169e1', JSON.stringify(royal));
    check('a colour the palette does not know is left without one, not invented',
      unknown?.hexCode === null, JSON.stringify(unknown));

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
    await prisma.clientCatalogItem.deleteMany({ where }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory_client_sequences WHERE client_id = ANY($1::text[])`, [CLIENT, OTHER]).catch(() => {});
    console.log('\n(test tenants removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
