/**
 * Deleting "Pink" must be refused when a product is wearing it.
 *
 * The first version of this suite compared the new grouped counts against the old
 * one-at-a-time counts and passed -- because both were wrong in the same way. A catalogue
 * entry has a label ("Pink") and a value ("pink"), the counts were matched on the value, and
 * the product form stores the LABEL on the variant. So every colour read as unused and the
 * delete guard never fired for anybody.
 *
 * That is the lesson this file exists to remember: a rewrite checked only against the thing it
 * replaced inherits its bugs. So the checks below start from the products that actually exist
 * and work back to the catalogue, rather than trusting either implementation.
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
  console.log('A COLOUR A PRODUCT IS WEARING COUNTS AS USED, ACROSS EVERY TENANT');

  // Start from the variants. Every colour actually on a variant, for every client, must be
  // reported as in use by whichever catalogue entry names it -- whether the entry's label or
  // its value is what got stored, and in whatever case.
  const variants = await prisma.productVariant.findMany({
    where: { colorName: { not: null } },
    select: { clientId: true, colorName: true },
    distinct: ['clientId', 'colorName']
  });

  const byClient = new Map<string, Set<string>>();
  for (const v of variants) {
    if (!byClient.has(v.clientId)) byClient.set(v.clientId, new Set());
    byClient.get(v.clientId)!.add(v.colorName as string);
  }

  let checkedPairs = 0;
  const missed: string[] = [];

  for (const [clientId, colours] of byClient) {
    const entries = await prisma.clientCatalogItem.findMany({ where: { clientId, type: 'COLOR' } });
    if (entries.length === 0) continue;
    const usage = await usageCountsForClient(clientId);

    for (const colour of colours) {
      // The catalogue entry a person would say this variant is using.
      const entry = entries.find(e =>
        e.label.toLowerCase() === colour.toLowerCase() ||
        e.value.toLowerCase() === colour.toLowerCase()
      );
      // A free-typed colour with no catalogue entry ("Pink Shade") is not a miss -- there is
      // no entry for anyone to delete.
      if (!entry) continue;

      checkedPairs++;
      if (usage.countFor(entry) === 0) {
        missed.push(`${clientId}: a variant is "${colour}" but ${entry.label}/${entry.value} reads as unused`);
      }
    }
  }

  check('every catalogue colour worn by a product reads as in use', missed.length === 0,
    missed.slice(0, 3).join(' | '));
  // Without this the check above passes trivially on a database where no product has a colour.
  check('and there were real product/catalogue pairs to check', checkedPairs > 0, `${checkedPairs} pairs`);

  console.log('\nTHE FRESH SINGLE READ AGREES WITH THE SCREEN');
  // Delete re-reads its own count, so the two must not disagree -- a screen that offers Delete
  // and a server that refuses it is the worst of both.
  const sample = await prisma.clientCatalogItem.findMany({ take: 25, orderBy: { createdAt: 'desc' } });
  const usageByClient = new Map<string, Awaited<ReturnType<typeof usageCountsForClient>>>();
  const disagreements: string[] = [];
  for (const item of sample) {
    if (!usageByClient.has(item.clientId)) {
      usageByClient.set(item.clientId, await usageCountsForClient(item.clientId));
    }
    const fromScreen = usageByClient.get(item.clientId)!.countFor(item);
    const fromDelete = await usageCountFor(item.clientId, item);
    if (fromScreen !== fromDelete) {
      disagreements.push(`${item.clientId} ${item.type}:${item.label} screen=${fromScreen} delete=${fromDelete}`);
    }
  }
  check('the grouped count and the fresh count give the same answer', disagreements.length === 0,
    disagreements.slice(0, 3).join(' | '));

  console.log('\nCASE AND LABEL/VALUE DIFFERENCES DO NOT HIDE USAGE');
  const purple = await prisma.clientCatalogItem.findFirst({
    where: { type: 'COLOR', OR: [{ label: 'Purple' }, { value: 'purple' }] }
  });
  if (purple) {
    const stored = await prisma.productVariant.count({
      where: { clientId: purple.clientId, colorName: { equals: 'Purple', mode: 'insensitive' } }
    });
    const reported = (await usageCountsForClient(purple.clientId)).countFor(purple);
    check(`a variant stored as "Purple" is found by the entry valued "purple"`,
      stored === 0 || reported >= stored, `${stored} variants -> reported ${reported}`);
  } else {
    check('a Purple entry exists somewhere to check this against', false, 'none found');
  }

  console.log('\nNOTHING BREAKS ON THINGS THAT DO NOT MAP');
  check('an unknown catalogue type is 0, not a crash',
    (await usageCountFor('demo-client', { type: 'NOT_A_REAL_TYPE', value: 'x', label: 'X' })) === 0);

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) { console.log('\nFailed:'); for (const f of failures) console.log(`  - ${f}`); }
  if (failed) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch(error => {
  console.error('\nSuite did not finish:', error?.message ?? error);
  process.exitCode = 1;
});
