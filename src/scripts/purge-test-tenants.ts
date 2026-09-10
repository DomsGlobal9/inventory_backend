/**
 * Remove the tenants left behind by testing, and nothing else.
 *
 * Fifty-three tenants had accumulated in this database: two real ones and fifty-one made by
 * end-to-end runs, signup experiments and audits. They are not free -- they appear in the
 * Platform Console's client list, they are counted in every platform-wide total, and their
 * images sit in storage costing money.
 *
 * Two things make this safe enough to run against a live database.
 *
 * IT KEEPS A COPY. Every tenant it is about to remove is written to a JSON file first, so a
 * deletion made in error is a restore rather than an apology. platform-admin's own
 * deleteClientCompletely has no undo by design; this adds one from the outside.
 *
 * IT NAMES WHAT IT KEEPS, NOT WHAT IT DELETES. KEEP is the allow-list. A tenant created
 * tomorrow is deleted by this script unless somebody adds it -- which is the right way round
 * for something destructive: the failure mode is "it refused to delete something", never
 * "it deleted something nobody listed".
 *
 * The deletion itself is platform-admin's, not a second implementation: one transaction, and
 * it interrogates the schema afterwards for any table with a client_id that still has rows,
 * aborting if it finds one. A table added next year does not silently leave a residue.
 *
 *   npx ts-node src/scripts/purge-test-tenants.ts           # show what would go
 *   npx ts-node src/scripts/purge-test-tenants.ts --apply    # do it
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { prisma } from '../lib/prisma';
import { platformAdminService } from '../services/platform-admin.service';

/** The real shops. Everything else in this database is test residue. */
const KEEP = new Set([
  'sphl',          // Akshaya's shop
  'demo-client'    // the demo workspace
]);

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = join(process.cwd(), 'backups');

async function snapshot(clientId: string) {
  const [users, products, variants, stock, orders, orderItems, customers, suppliers, locations, images, transactions] =
    await Promise.all([
      prisma.user.findMany({ where: { clientId } }),
      prisma.product.findMany({ where: { clientId } }),
      prisma.productVariant.findMany({ where: { clientId } }),
      prisma.inventoryStock.findMany({ where: { clientId } }),
      prisma.salesOrder.findMany({ where: { clientId } }),
      prisma.salesOrderItem.findMany({ where: { salesOrder: { clientId } } }),
      prisma.customer.findMany({ where: { clientId } }),
      prisma.supplier.findMany({ where: { clientId } }),
      prisma.stockLocation.findMany({ where: { clientId } }),
      prisma.productImage.findMany({ where: { product: { clientId } } }),
      prisma.inventoryTransaction.findMany({ where: { variant: { clientId } } })
    ]);
  return { clientId, takenAt: new Date().toISOString(), users, products, variants, stock, orders, orderItems, customers, suppliers, locations, images, transactions };
}

async function main() {
  /**
   * Every clientId that appears ANYWHERE, not just on a user row.
   *
   * This asked prisma.user alone at first, and missed seven tenants outright: older seed and
   * acceptance fixtures that had products, variants, locations and customers but never a login
   * -- `acceptance-test-tenant`, `client-a`, `tenant-b`, `default-client` and friends. They
   * survived the purge, invisible, because "a tenant" was being defined as "something with a
   * user" rather than "something with data".
   *
   * A tenant is anything with rows. Asking several tables and taking the union costs four
   * queries and cannot miss a tenant whose users were deleted first.
   */
  const [byUser, byProduct, byVariant, byLocation, byCustomer] = await Promise.all([
    prisma.user.groupBy({ by: ['clientId'] }),
    prisma.product.groupBy({ by: ['clientId'] }),
    prisma.productVariant.groupBy({ by: ['clientId'] }),
    prisma.stockLocation.groupBy({ by: ['clientId'] }),
    prisma.customer.groupBy({ by: ['clientId'] })
  ]);
  const all = [...new Set(
    [...byUser, ...byProduct, ...byVariant, ...byLocation, ...byCustomer].map(g => g.clientId)
  )].sort();
  const doomed = all.filter(c => !KEEP.has(c));
  const kept = all.filter(c => KEEP.has(c));

  console.log(`\n${all.length} tenants: keeping ${kept.length}, removing ${doomed.length}\n`);
  console.log(`  KEEP:   ${kept.join(', ')}\n`);

  if (!APPLY) {
    for (const c of doomed) {
      const p = await platformAdminService.previewClientDeletion(c);
      console.log(`  ${c.padEnd(34)} users ${p.users}  products ${p.products}  variants ${p.variants}  orders ${p.orders}  transactions ${p.transactions}`);
    }
    console.log(`\n  Nothing removed. Re-run with --apply.\n`);
    await prisma.$disconnect();
    return;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(BACKUP_DIR, `tenants-${stamp}.json`);

  console.log('  taking a copy first...');
  const backup = [];
  for (const c of doomed) backup.push(await snapshot(c));
  writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`  saved ${backup.length} tenants to ${file}\n`);

  let removed = 0, images = 0;
  const failed: string[] = [];
  for (const c of doomed) {
    try {
      // The confirmation is the client id, exactly as the Platform Console requires from a
      // person. Passed deliberately rather than bypassed.
      const r = await platformAdminService.deleteClientCompletely(c, c);
      removed++;
      images += r.imagesRemoved || 0;
      console.log(`  removed ${c}${r.imagesRemoved ? `  (+${r.imagesRemoved} images)` : ''}`);
    } catch (e: any) {
      failed.push(`${c}: ${e.message}`);
      console.log(`  FAILED  ${c} -- ${e.message}`);
    }
  }

  const left = await prisma.user.groupBy({ by: ['clientId'] });
  console.log(`\n  removed ${removed} tenants, ${images} images from storage`);
  if (failed.length) { console.log('\n  did not go:'); failed.forEach(f => console.log('    ' + f)); }
  console.log(`  tenants remaining: ${left.map(l => l.clientId).sort().join(', ')}`);
  console.log(`  backup: ${file}\n`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
