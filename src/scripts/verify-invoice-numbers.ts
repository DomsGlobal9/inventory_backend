/**
 * Invoice numbering, against the real database, because the properties that matter are database
 * properties and a mock cannot have them.
 *
 *   A  a fresh series starts at 1 and counts up
 *   B  TWENTY AT ONCE get twenty different numbers, contiguous, no gaps -- two tills on a Saturday
 *   C  a sale that FAILS after taking a number does not consume it (no hole in the series)
 *   D  each series counts separately -- the till and the online shop do not share
 *   E  the count restarts on 1 April, by itself
 *   F  reading where a series has got to never advances it
 *
 * A throwaway tenant, deleted at the end. No API needed.
 *   npx tsx src/scripts/verify-invoice-numbers.ts
 */
import { prisma } from '../lib/prisma';
import { allocateInvoiceNumber, lastInvoiceNumber, SERIES } from '../services/invoicing/invoiceNumber';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  [PASS] ${name}${detail ? '  -- ' + detail : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? '  -- ' + detail : ''}`); }
};

const CLIENT = `invno-${Date.now()}`;
const IN_FY_2026 = new Date('2026-09-27T10:00:00');
const IN_FY_2027 = new Date('2027-04-02T10:00:00');

async function main() {
  console.log('\nA. A FRESH SERIES');
  const first = await prisma.$transaction(tx => allocateInvoiceNumber(tx as any, CLIENT, SERIES.COUNTER, IN_FY_2026));
  check('starts at 1', first.number === 1, String(first.number));
  check('and prints as CTR/2026-27/00001', first.formatted === 'CTR/2026-27/00001', first.formatted);

  const second = await prisma.$transaction(tx => allocateInvoiceNumber(tx as any, CLIENT, SERIES.COUNTER, IN_FY_2026));
  check('the next is 2', second.number === 2, String(second.number));

  console.log('\nB. TWENTY AT ONCE');
  /*
   * Two counters on a busy Saturday, or one till pressed twice. Every one of these opens its own
   * transaction against the same row, which is exactly the collision the atomic increment exists
   * to survive -- a read-then-write would hand the same number to several of them.
   */
  const many = await Promise.all(
    Array.from({ length: 20 }, () =>
      prisma.$transaction(tx => allocateInvoiceNumber(tx as any, CLIENT, SERIES.COUNTER, IN_FY_2026))
    )
  );
  const numbers = many.map(m => m.number).sort((a, b) => a - b);
  check('twenty different numbers', new Set(numbers).size === 20, `${new Set(numbers).size} distinct`);
  check('contiguous, from 3 to 22 -- no gaps',
    numbers[0] === 3 && numbers[19] === 22 && numbers.every((v, i) => v === 3 + i),
    `${numbers[0]}..${numbers[19]}`);

  console.log('\nC. A SALE THAT FAILS TAKES NO NUMBER');
  const before = await lastInvoiceNumber(prisma as any, CLIENT, SERIES.COUNTER, IN_FY_2026);
  let threw = false;
  try {
    await prisma.$transaction(async tx => {
      await allocateInvoiceNumber(tx as any, CLIENT, SERIES.COUNTER, IN_FY_2026);
      // the sale falls over after the number was taken
      throw new Error('the card machine declined');
    });
  } catch { threw = true; }
  const after = await lastInvoiceNumber(prisma as any, CLIENT, SERIES.COUNTER, IN_FY_2026);
  check('the sale did fail', threw);
  check('and the series did NOT advance -- no hole for a tax officer to ask about',
    after === before, `${before} -> ${after}`);

  const next = await prisma.$transaction(tx => allocateInvoiceNumber(tx as any, CLIENT, SERIES.COUNTER, IN_FY_2026));
  check('the next real sale gets the number the failed one would have had',
    next.number === before + 1, `${next.number}`);

  console.log('\nD. EACH SERIES COUNTS SEPARATELY');
  const web = await prisma.$transaction(tx => allocateInvoiceNumber(tx as any, CLIENT, SERIES.ONLINE, IN_FY_2026));
  check('the online shop starts at 1 of its own', web.number === 1, web.formatted);
  check('and the till is untouched',
    await lastInvoiceNumber(prisma as any, CLIENT, SERIES.COUNTER, IN_FY_2026) === next.number);
  const note = await prisma.$transaction(tx => allocateInvoiceNumber(tx as any, CLIENT, SERIES.CREDIT_NOTE, IN_FY_2026));
  check('credit notes count separately too, as GST requires', note.number === 1, note.formatted);

  console.log('\nE. APRIL RESTARTS IT, BY ITSELF');
  const newYear = await prisma.$transaction(tx => allocateInvoiceNumber(tx as any, CLIENT, SERIES.COUNTER, IN_FY_2027));
  check('2 April 2027 starts a fresh count at 1', newYear.number === 1, newYear.formatted);
  check('and says the new year', newYear.formatted === 'CTR/2027-28/00001', newYear.formatted);
  check('last year kept its place',
    await lastInvoiceNumber(prisma as any, CLIENT, SERIES.COUNTER, IN_FY_2026) === next.number);

  console.log('\nF. READING NEVER ADVANCES');
  const read1 = await lastInvoiceNumber(prisma as any, CLIENT, SERIES.ONLINE, IN_FY_2026);
  const read2 = await lastInvoiceNumber(prisma as any, CLIENT, SERIES.ONLINE, IN_FY_2026);
  check('asking twice gives the same answer', read1 === read2 && read1 === 1, `${read1}, ${read2}`);
  check('a series never asked about is 0, not 1',
    await lastInvoiceNumber(prisma as any, `${CLIENT}-untouched`, SERIES.COUNTER, IN_FY_2026) === 0);
}

main()
  .then(async () => {
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async e => {
    console.error('CRASHED:', e.message);
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
