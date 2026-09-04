/**
 * Rebuilds the supplier catalogue from purchase history.
 *
 * The supplier <-> item relationship has always existed in the data -- a purchase order
 * carries a supplier and its lines carry variants -- but never as anything queryable.
 * Without this the new supplier_products table starts empty, and an existing customer opens
 * the feature to find none of the suppliers they have been buying from for months.
 *
 * Idempotent: pairs already linked are skipped, and a preferred supplier chosen by hand is
 * never overwritten by one inferred from history.
 *
 *   npx ts-node src/scripts/backfill-supplier-products.ts           # report only
 *   npx ts-node src/scripts/backfill-supplier-products.ts --apply   # write the links
 */
import { prisma } from '../lib/prisma';
import { supplierProductService } from '../services/supplier-product.service';

async function main() {
  const apply = process.argv.includes('--apply');
  const result = await supplierProductService.backfillFromPurchaseHistory(undefined, apply);

  console.log(`purchase order lines scanned: ${result.scanned}`);
  console.log(`already linked:               ${result.alreadyLinked}`);
  if (apply) {
    console.log(`links created:                ${result.created}`);
  } else {
    console.log(`links that would be created:  ${result.wouldCreate}`);
    console.log('\nRe-run with --apply to write them.');
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
