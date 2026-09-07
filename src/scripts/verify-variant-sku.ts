/**
 * Verifies that asking for two variants gets you two variants.
 *
 * SKUs are derived client-side as productCode-FIRST3OFCOLOUR-size, so two genuinely different
 * colours whose names start with the same three letters collapse to one SKU: "Light Blue" and
 * "Light Green" both reduce to LIG. [clientId, sku] is unique, so the second insert failed,
 * was counted as "skipped", and the UI reported it in a green success toast. A real customer
 * created a product with two variants and only one existed.
 *
 *   npx ts-node src/scripts/verify-variant-sku.ts
 */
import { prisma } from '../lib/prisma';
import { variantService } from '../services/variant.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** The exact rule the product wizard uses to build a SKU. */
const skuFor = (productCode: string, colour: string, size: string) =>
  `${productCode}-${colour.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 3)}-${size}`;

async function main() {
  const owner = await prisma.user.findFirst({
    where: { email: 'e2e1788452461634@example.com' }, select: { clientId: true }
  });
  if (!owner) throw new Error('Test tenant not found');
  const clientId = owner.clientId;

  console.log('\nTHE SKU RULE COLLIDES');
  check('two different colours can produce one SKU',
    skuFor('PRD-000009', 'Light Blue', 'M') === skuFor('PRD-000009', 'Light Green', 'M'),
    `${skuFor('PRD-000009', 'Light Blue', 'M')} vs ${skuFor('PRD-000009', 'Light Green', 'M')}`);

  // A throwaway product to create against.
  const product = await prisma.product.create({
    data: {
      clientId,
      productCode: `SKUTEST-${Date.now()}`,
      slug: `skutest-${Date.now()}`,
      title: 'SKU collision probe',
      status: 'DRAFT',
      category: 'WOMEN',
      productType: 'READY_TO_WEAR',
      basePrice: 0
    },
    select: { id: true, productCode: true }
  });

  try {
    console.log('\nBOTH VARIANTS SURVIVE IT');
    const colliding = [
      { sku: skuFor(product.productCode, 'Light Blue', 'M'), size: 'M', colorName: 'Light Blue', quantity: 0, reorderLevel: 5 },
      { sku: skuFor(product.productCode, 'Light Green', 'M'), size: 'M', colorName: 'Light Green', quantity: 0, reorderLevel: 5 }
    ];
    check('the two requests really do carry the same SKU',
      colliding[0].sku === colliding[1].sku, colliding.map(c => c.sku).join(' vs '));

    const result: any = await variantService.bulkCreateVariants(
      product.id, clientId, colliding, undefined, false
    );

    check('both variants are created, not one', result.created === 2,
      `created ${result.created}, skipped ${result.skipped}`);
    check('nothing is silently skipped', result.skipped === 0,
      JSON.stringify(result.errors));

    const rows = await prisma.productVariant.findMany({
      where: { productId: product.id }, select: { sku: true, colorName: true }
    });
    check('both colours exist in the database', rows.length === 2,
      JSON.stringify(rows.map(r => r.colorName)));
    check('their SKUs differ', new Set(rows.map(r => r.sku)).size === 2,
      JSON.stringify(rows.map(r => r.sku)));
    check('the caller is told which SKU was changed', result.adjusted?.length === 1,
      JSON.stringify(result.adjusted));
    check('the adjusted SKU keeps the original as its stem',
      result.adjusted?.[0]?.used?.startsWith(result.adjusted?.[0]?.requested),
      JSON.stringify(result.adjusted?.[0]));

    console.log('\nIT DOES NOT COLLIDE WITH WHAT ALREADY EXISTS');
    const again: any = await variantService.bulkCreateVariants(
      product.id, clientId,
      [{ sku: colliding[0].sku, size: 'M', colorName: 'Light Teal', quantity: 0, reorderLevel: 5 }],
      undefined, false
    );
    check('a SKU already held by this tenant is renamed, not rejected',
      again.created === 1 && again.skipped === 0,
      `created ${again.created}, skipped ${again.skipped}`);

    const all = await prisma.productVariant.findMany({
      where: { productId: product.id }, select: { sku: true }
    });
    check('all three variants have distinct SKUs',
      new Set(all.map(r => r.sku)).size === 3, JSON.stringify(all.map(r => r.sku)));

    console.log('\nDISTINCT COLOURS ARE LEFT ALONE');
    const distinct: any = await variantService.bulkCreateVariants(
      product.id, clientId,
      [
        { sku: skuFor(product.productCode, 'Red', 'L'), size: 'L', colorName: 'Red', quantity: 0, reorderLevel: 5 },
        { sku: skuFor(product.productCode, 'Black', 'L'), size: 'L', colorName: 'Black', quantity: 0, reorderLevel: 5 }
      ],
      undefined, false
    );
    check('SKUs that do not collide are used exactly as asked',
      distinct.created === 2 && (distinct.adjusted?.length ?? 0) === 0,
      JSON.stringify(distinct.adjusted));

  } finally {
    await prisma.inventoryStock.deleteMany({ where: { variant: { productId: product.id } } });
    await prisma.inventoryTransaction.deleteMany({ where: { variant: { productId: product.id } } });
    await prisma.productVariant.deleteMany({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });
    console.log('\n(probe product removed)');
  }

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
