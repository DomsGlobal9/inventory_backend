/**
 * A client's stock is worth one number, whoever is looking at it.
 *
 * This has now been wrong twice. The first time, the dashboard computed the figure live while
 * the console summed a stored column, and they disagreed for five tenants. That was fixed by
 * putting one definition in lib/inventoryValuation.ts -- and then a THIRD chain survived inside
 * report.service.ts, so the console and the merchant's own dashboard drifted apart again. Same
 * five tenants, worse: demo-client differed by ten lakh, sphl by twenty-one.
 *
 * So this checks the property directly, against every tenant holding stock, rather than
 * trusting that one file imports another.
 *
 *   npx ts-node src/scripts/verify-one-inventory-value.ts
 */
import { prisma } from '../lib/prisma';
import { inventoryValueFor } from '../lib/inventoryValuation';
import { reportService } from '../services/report.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

async function main() {
  console.log('EVERY TENANT IS WORTH THE SAME ON BOTH SCREENS');

  const clients = (await prisma.productVariant.groupBy({ by: ['clientId'] })).map(c => c.clientId);
  const mismatched: string[] = [];
  let checkedWithStock = 0;

  for (const clientId of clients) {
    // What the platform console shows.
    const console_ = await inventoryValueFor(clientId);
    // What the merchant's own dashboard shows, through the real service.
    const summary: any = await reportService.getDashboardSummary(clientId);
    const dashboard = Number(summary?.inventoryValue ?? 0);

    if (console_ > 0 || dashboard > 0) checkedWithStock++;
    // Rounded: one path sums in SQL and the other returns a Decimal, so exact float equality
    // would fail on presentation rather than on meaning.
    if (Math.round(console_) !== Math.round(dashboard)) {
      mismatched.push(`${clientId}: console=${Math.round(console_)} dashboard=${Math.round(dashboard)}`);
    }
  }

  check('no tenant sees two different inventory values', mismatched.length === 0,
    mismatched.slice(0, 4).join(' | '));
  // Without this the check above passes on a database where nobody holds stock.
  check('and there were tenants holding stock to check', checkedWithStock > 0, `${checkedWithStock} with stock`);

  console.log('\nTHE DEFINITION LIVES IN ONE PLACE');
  const report = require('fs').readFileSync('src/services/report.service.ts', 'utf8');
  // Looks for a second VALUATION chain, not for any mention of those columns. pricedNotCosted
  // legitimately names them to work out which rows fell through to a price, and flagging that
  // would make this test cry wolf at correct code.
  check('report.service does not keep its own valuation chain',
    !/const unitCost = Prisma\.sql/.test(report));
  check('it imports the shared one instead', /UNIT_COST/.test(report) && /inventoryValuation/.test(report));

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  await prisma.$disconnect();
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
