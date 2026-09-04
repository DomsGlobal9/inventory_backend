/**
 * Gives a MAIN-STORE location to every tenant that has none.
 *
 * Until onboardClient started creating one, a client was provisioned with roles and catalog
 * defaults but no stock location at all. Every stock movement requires a locationId, so
 * those tenants could not hold stock: their first product went through
 * resolveInitialStockLocationIds -> [] and the opening quantity was silently dropped.
 * Fixing onboarding stops it happening again but leaves everyone already provisioned
 * broken, which is what this repairs.
 *
 * Additive and idempotent -- a tenant that already has any location is skipped untouched,
 * and the unique constraint on (clientId, code) makes a second run a no-op.
 *
 *   npx ts-node src/scripts/backfill-default-locations.ts          # report only
 *   npx ts-node src/scripts/backfill-default-locations.ts --apply  # create them
 */
import { prisma } from '../lib/prisma';

async function main() {
  const apply = process.argv.includes('--apply');

  const clientIds = (await prisma.user.findMany({
    distinct: ['clientId'], select: { clientId: true }
  })).map(u => u.clientId);

  const withLocations = new Set(
    (await prisma.stockLocation.groupBy({ by: ['clientId'], _count: { id: true } }))
      .map(l => l.clientId)
  );

  const missing = clientIds.filter(c => !withLocations.has(c));

  console.log(`${clientIds.length} tenants, ${missing.length} without any stock location.`);
  if (missing.length === 0) return;

  if (!apply) {
    console.log(missing.map(c => `  would create MAIN-STORE for ${c}`).join('\n'));
    console.log('\nRe-run with --apply to create them.');
    return;
  }

  for (const clientId of missing) {
    await prisma.stockLocation.create({
      data: { clientId, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE', active: true }
    });
    console.log(`  created MAIN-STORE for ${clientId}`);
  }
  console.log(`\nDone: ${missing.length} created.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
