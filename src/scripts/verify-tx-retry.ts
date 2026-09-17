/**
 * The retry that saves a delivery when the database is slow.
 *
 * A transaction that runs out of time (Prisma P2028) or loses a race (P2034) has written nothing,
 * so running it again is the right answer -- and that is exactly what failed in the shop: a receipt
 * died with "Something went wrong at our end" and the goods stayed unbooked. These checks force
 * each kind of failure from inside the transaction and watch what runTransaction does with it.
 *
 *   npx tsx src/scripts/verify-tx-retry.ts
 */
import { prisma } from '../lib/prisma';
import { runTransaction, isRetryableTransactionError, isTransactionTimeout } from '../lib/txRetry';

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); }
};

const timeoutError = () => Object.assign(new Error("Transaction not found. Transaction ID is invalid, refers to an old closed transaction"), { code: 'P2028' });
const conflictError = () => Object.assign(new Error('write conflict'), { code: 'P2034' });
const businessError = () => Object.assign(new Error('Cannot receive more than remaining quantity'), { statusCode: 400 });

async function main() {
  console.log('\nWhat counts as worth retrying');
  check('a closed transaction (P2028) counts as out of time', isTransactionTimeout(timeoutError()));
  check('no connection free (P2024) counts as out of time', isTransactionTimeout(Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' })));
  check('a write conflict (P2034) counts as a conflict', isRetryableTransactionError(conflictError()));
  check('a deadlock counts as a conflict', isRetryableTransactionError(Object.assign(new Error('deadlock detected'), { code: '40P01' })));
  check('"receive more than ordered" is neither', !isTransactionTimeout(businessError()) && !isRetryableTransactionError(businessError()));
  check('nothing at all is neither', !isTransactionTimeout(null) && !isRetryableTransactionError(undefined));

  console.log('\nRunning out of time, then succeeding');
  {
    let attempts = 0;
    const answer = await runTransaction(async (tx) => {
      attempts++;
      if (attempts === 1) throw timeoutError();
      await tx.$queryRaw`SELECT 1`;
      return 'saved';
    }, { label: 'test: out of time once', timeout: 20000 });
    check('a delivery that ran out of time is tried again and saved', attempts === 2 && answer === 'saved', `attempts ${attempts}, answer ${answer}`);
  }

  console.log('\nLosing a race, then succeeding');
  {
    let attempts = 0;
    const answer = await runTransaction(async () => { attempts++; if (attempts < 3) throw conflictError(); return 'saved'; }, { label: 'test: conflict twice', timeout: 20000 });
    check('two lost races are tried again and the third saves', attempts === 3 && answer === 'saved', `attempts ${attempts}`);
  }

  console.log('\nWhat must NOT be tried again');
  {
    let attempts = 0;
    const failed = await runTransaction(async () => { attempts++; throw businessError(); }, { label: 'test: a refusal', timeout: 20000 })
      .then(() => null, (e) => e);
    check('a refusal is passed straight back, not tried again', attempts === 1 && failed?.statusCode === 400, `attempts ${attempts}, ${failed?.message}`);
    check('the refusal keeps its own words', /remaining quantity/.test(String(failed?.message)), String(failed?.message));
  }

  console.log('\nWhen time runs out every single time');
  {
    let attempts = 0;
    const failed = await runTransaction(async () => { attempts++; throw timeoutError(); }, {
      label: 'test: always out of time',
      attempts: 3,
      timeout: 20000,
      tooSlowMessage: 'Saving this delivery took too long, so nothing was recorded. Check the order and try again.'
    }).then(() => null, (e) => e);
    check('it gives up after 3 tries', attempts === 3, `attempts ${attempts}`);
    check('and says so in plain words, as a "try again" (503), not a crash', failed?.statusCode === 503 && /took too long/.test(String(failed?.message)), `${failed?.statusCode} ${failed?.message}`);
  }

  console.log('\nWork that was already finished is never done twice');
  {
    let attempts = 0;
    const answer = await runTransaction(async () => { attempts++; throw timeoutError(); }, {
      label: 'test: someone else already did it',
      alreadyDone: async () => ({ receiptNumber: 'GRN-1' }) as any,
      timeout: 20000
    });
    check('the finished receipt is returned instead of a second one', attempts === 1 && (answer as any).receiptNumber === 'GRN-1', `attempts ${attempts}`);
  }

  console.log('\nThe transaction still works normally');
  {
    const rows = await runTransaction(async (tx) => tx.$queryRaw<{ one: number }[]>`SELECT 1 as one`, { label: 'test: ordinary work', timeout: 20000 });
    check('an ordinary transaction goes through untouched', Array.isArray(rows) && Number((rows as any)[0].one) === 1);
  }

  console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  await prisma.$disconnect();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
