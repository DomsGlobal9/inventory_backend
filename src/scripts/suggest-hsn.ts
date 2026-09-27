/**
 * Suggest an HSN code and tax rate for a shop's products, from what the shop already typed.
 *
 * A shopkeeper with four hundred sarees should not type 5007 four hundred times. But HSN is the
 * shop's own declaration and the shop answers for it, so this prints what it would do and changes
 * nothing until it is told to -- and even then it only fills in products that have NOTHING set.
 * A code somebody already chose is never overwritten.
 *
 *   npx tsx src/scripts/suggest-hsn.ts <clientId>            show what it would do
 *   npx tsx src/scripts/suggest-hsn.ts <clientId> --apply    fill in the blanks
 *
 * Products it cannot read honestly are listed and left alone, which is the correct outcome: the
 * shop is then asked, rather than being given a wrong code that prints on every invoice.
 */
import { prisma } from '../lib/prisma';
import { suggestHsn } from '../services/pricing/hsn';

async function main() {
  const clientId = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!clientId) {
    console.error('Usage: npx tsx src/scripts/suggest-hsn.ts <clientId> [--apply]');
    process.exit(1);
  }

  const products = await prisma.product.findMany({
    where: { clientId, trashedAt: null },
    select: {
      id: true, productCode: true, title: true, dressType: true, fabric: true,
      productType: true, hsnCode: true, taxRateBps: true, taxSlabbed: true, priceIsExclusive: true
    },
    orderBy: { productCode: 'asc' }
  });

  if (!products.length) {
    console.log(`No products for ${clientId}.`);
    return;
  }

  console.log(`${products.length} product(s) for ${clientId}\n`);

  let already = 0, willSet = 0, cannot = 0;
  const changes: { id: string; hsnCode: string; taxRateBps: number; taxSlabbed: boolean; priceIsExclusive: boolean }[] = [];

  for (const p of products) {
    const label = `${p.productCode} ${(p.title ?? '').slice(0, 28)}`.padEnd(42);

    if (p.hsnCode) {
      already++;
      console.log(`  keep      ${label} ${p.hsnCode} @ ${(p.taxRateBps ?? 0) / 100}%`);
      continue;
    }

    const s = suggestHsn({ dressType: p.dressType, fabric: p.fabric, productType: p.productType, title: p.title });
    if (!s) {
      cannot++;
      console.log(`  ASK       ${label} dressType="${p.dressType ?? ''}" fabric="${p.fabric ?? ''}"`);
      continue;
    }

    willSet++;
    const slab = s.taxSlabbed ? '  (slabbed: 5% up to Rs 2,500 a piece, 18% above)' : '';
    console.log(`  suggest   ${label} ${s.hsnCode} @ ${s.taxRateBps / 100}%${slab}`);
    console.log(`            ${s.because}`);
    if (s.conflict) console.log(`            CHECK: ${s.conflict}`);

    changes.push({
      id: p.id,
      hsnCode: s.hsnCode,
      taxRateBps: s.taxRateBps,
      taxSlabbed: s.taxSlabbed,
      /*
       * Stitched clothing must be priced without tax, because its rate depends on its price and a
       * tax-inclusive price cannot decide its own rate between Rs 2,625 and Rs 2,950. Fabric keeps
       * the shop's existing inclusive prices, so nothing about a saree's price changes.
       */
      priceIsExclusive: s.taxSlabbed
    });
  }

  console.log(`\n  ${already} already set, ${willSet} can be suggested, ${cannot} need asking`);

  if (!apply) {
    console.log('\nNothing changed. Add --apply to fill in the blanks.');
    return;
  }

  if (!changes.length) {
    console.log('\nNothing to fill in.');
    return;
  }

  // One transaction: either the shop's catalogue is consistent afterwards or it is untouched.
  await prisma.$transaction(
    changes.map(c => prisma.product.update({
      where: { id: c.id },
      data: {
        hsnCode: c.hsnCode, taxRateBps: c.taxRateBps,
        taxSlabbed: c.taxSlabbed, priceIsExclusive: c.priceIsExclusive
      }
    }))
  );

  console.log(`\n  ${changes.length} product(s) updated.`);
  if (changes.some(c => c.taxSlabbed)) {
    console.log('  NOTE: stitched items were set to tax-exclusive pricing. Check their prices --');
    console.log('        the tag price is now worked out from the price you enter, plus tax.');
  }
}

main()
  .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
