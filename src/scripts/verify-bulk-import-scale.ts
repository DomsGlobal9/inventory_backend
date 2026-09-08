/**
 * A bulk import must not take the instance down with it.
 *
 * The concern is not speed. Each row of an import is several round trips inside its own
 * transaction, and the connection pool is shared with every other tenant on the instance --
 * so an unbounded import does not merely run slowly, it starves everyone else until it
 * finishes or times out. This checks the two properties that prevent that:
 *
 *   - work is done in bounded batches rather than all at once
 *   - a single request cannot ask for unbounded work in the first place
 *
 *   npx ts-node src/scripts/verify-bulk-import-scale.ts
 */
import { prisma } from '../lib/prisma';
import { bulkUpdateVariantSchema } from '../validations/variant.schema';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ sku: `SKU-${i}`, sellingPrice: 100 }));

async function main() {
  console.log('A SINGLE REQUEST CANNOT QUEUE UNBOUNDED WORK');

  const ok = bulkUpdateVariantSchema.safeParse({ updates: rows(2000) });
  check('a large but sane file is accepted', ok.success, ok.success ? '' : 'rejected 2000');

  const tooBig = bulkUpdateVariantSchema.safeParse({ updates: rows(2001) });
  check('an oversized file is refused', !tooBig.success);
  check('and the refusal says what to do about it',
    !tooBig.success && /split/i.test(JSON.stringify(tooBig.error.issues)),
    !tooBig.success ? JSON.stringify(tooBig.error.issues[0]?.message) : '');

  const empty = bulkUpdateVariantSchema.safeParse({ updates: [] });
  check('an empty file is still refused', !empty.success);

  console.log('\nTHE WORK IS DONE IN BOUNDED BATCHES');
  // Read the source rather than the behaviour: the property is structural, and proving it by
  // timing would need a thousand real variants and would still be a guess.
  const src = require('fs').readFileSync('src/services/variant.service.ts', 'utf8');
  check('bulkUpdateVariants no longer fans the whole file out at once',
    !/const results = await Promise\.allSettled\(\s*updates\.map/.test(src));
  check('it loops in slices instead', /for \(let start = 0; start < updates\.length; start \+= BULK_UPDATE_CONCURRENCY\)/.test(src));
  const width = src.match(/const BULK_UPDATE_CONCURRENCY = (\d+)/);
  check('with a width small enough to leave the pool usable',
    !!width && Number(width[1]) > 0 && Number(width[1]) <= 16, width ? width[1] : 'not found');

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  await prisma.$disconnect();
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
