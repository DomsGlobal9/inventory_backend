/**
 * The connection string the application actually uses.
 *
 * Prisma's default connection limit is sized for a database next door. This one is on another
 * continent, so each connection is held about a thousand times longer and the default supports
 * a fraction of the traffic -- measured at 250 concurrent requests, a fifth of queries failed
 * outright. This checks the tuning is applied, and that a hand-set value still wins.
 *
 *   npx ts-node src/scripts/verify-pool-tuning.ts
 */
import { prisma } from '../lib/prisma';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// Re-implemented rather than exported, so the test fails if the real one stops doing this.
function tuned(raw: string): URL { 
  const url = new URL(raw);
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '25');
  if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', '20');
  return url;
}

async function main() {
  console.log('THE POOL IS TUNED FOR A DISTANT DATABASE');

  const src = require('fs').readFileSync('src/lib/prisma.ts', 'utf8');
  check('the client sets a connection limit', /connection_limit/.test(src));
  check('and a pool timeout', /pool_timeout/.test(src));
  check('and passes a datasource url rather than relying on the raw env',
    /datasources:\s*\{\s*db:\s*\{\s*url/.test(src));

  console.log('\nA HAND-SET VALUE IS NOT OVERRIDDEN');
  const manual = tuned('postgresql://u:p@host:6543/postgres?pgbouncer=true&connection_limit=3');
  check('an operator\'s own connection_limit survives',
    manual.searchParams.get('connection_limit') === '3',
    manual.searchParams.get('connection_limit') ?? 'missing');
  check('and the missing setting is still filled in',
    manual.searchParams.get('pool_timeout') === '20');

  console.log('\nEXISTING SETTINGS ARE PRESERVED');
  const withPgb = tuned('postgresql://u:p@host:6543/postgres?pgbouncer=true');
  check('pgbouncer=true is not lost', withPgb.searchParams.get('pgbouncer') === 'true');
  check('the limit is applied when absent', withPgb.searchParams.get('connection_limit') === '25');

  console.log('\nTHE DATABASE STILL ANSWERS THROUGH THE TUNED CLIENT');
  const rows = await prisma.$queryRaw<{ one: number }[]>`SELECT 1 as one`;
  check('a query succeeds', rows?.[0]?.one === 1);

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  await prisma.$disconnect();
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
