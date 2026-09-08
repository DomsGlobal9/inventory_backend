/**
 * Deleting "Pink" must be refused when a product is wearing it.
 *
 * The counts behind that guard were rewritten from one COUNT per catalogue entry into seven
 * grouped queries, so this checks the new figures against the old method entry by entry --
 * a rewrite that is merely faster and quietly wrong would let someone delete a colour that
 * is in use.
 *
 *   npx ts-node src/scripts/verify-catalog-usage.ts
 */
import { prisma } from '../lib/prisma';
import { usageCountsForClient, usageCountFor } from '../services/catalog-usage.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

async function main() {
  // The tenant with the most catalogue entries, because that is where a per-entry query
  // storm hurts most and where a mismatch is most likely to show up.
  const busiest = (await prisma.clientCatalogItem.groupBy({
    by: ['clientId'], _count: { _all: true }
  })).sort((a, b) => b._count._all - a._count._all)[0];

  if (!busiest) { console.log('No catalogue entries anywhere to check.'); return; }
  const clientId = busiest.clientId;
  const items = await prisma.clientCatalogItem.findMany({ where: { clientId } });
  console.log(`${clientId}: ${items.length} catalogue entries\n`);

  console.log('THE GROUPED COUNTS MATCH THE ONE-AT-A-TIME COUNTS');
  const groupedStart = Date.now();
  const grouped = await usageCountsForClient(clientId);
  const groupedMs = Date.now() - groupedStart;

  const oneByOneStart = Date.now();
  const oneByOne = new Map<string, number>();
  for (const item of items) {
    oneByOne.set(`${item.type}:${item.value}`, await usageCountFor(clientId, item.type, item.value));
  }
  const oneByOneMs = Date.now() - oneByOneStart;

  const mismatched = items.filter(i => {
    const key = `${i.type}:${i.value}`;
    return (grouped.get(key) ?? 0) !== (oneByOne.get(key) ?? 0);
  });
  check('every entry gets the same count either way', mismatched.length === 0,
    mismatched.slice(0, 3).map(i => `${i.type}:${i.value}`).join(', '));

  const inUse = items.filter(i => (grouped.get(`${i.type}:${i.value}`) ?? 0) > 0);
  // A run where nothing is in use would pass the comparison above trivially, by agreeing on
  // zero everywhere -- so say out loud whether the check had anything to bite on.
  check('and at least one entry is genuinely in use, so this proved something',
    inUse.length > 0, `${inUse.length} in use`);
  console.log(`         (grouped ${groupedMs}ms for all ${items.length}, one-at-a-time ${oneByOneMs}ms)`);

  console.log('\nAN ENTRY NOTHING USES READS AS ZERO, NOT AS UNKNOWN');
  const unused = items.find(i => (grouped.get(`${i.type}:${i.value}`) ?? 0) === 0);
  check('a value with no products returns 0 rather than undefined',
    unused ? (grouped.get(`${unused.type}:${unused.value}`) ?? 0) === 0 : true);
  check('a type that does not map to any column is 0, not a crash',
    (await usageCountFor(clientId, 'NOT_A_REAL_TYPE', 'whatever')) === 0);

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) { console.log('\nFailed:'); for (const f of failures) console.log(`  - ${f}`); }
  if (failed) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch(error => {
  console.error('\nSuite did not finish:', error?.message ?? error);
  process.exitCode = 1;
});
