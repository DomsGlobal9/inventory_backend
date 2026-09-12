/**
 * Nothing internal leaves the building.
 *
 * Pressing Dispatch twice in the UI put this in a red toast on the shop floor, verbatim:
 *
 *   Invalid `db.clientSequence.upsert()` invocation in
 *   D:\villy\inventory\backend\src\utils\codeGenerator.ts:65:44
 *   Transaction failed due to a write conflict or a deadlock. Please retry your transaction
 *
 * The server's absolute file path, its ORM, its table and a line number, shown to a merchant.
 * respondWithError is the road out for forty-seven controller catch blocks and it had no guard
 * at all: with no `fallback.message` it fell through to the exception's own text.
 *
 * These cases are the ones that matter -- a deliberate refusal must keep the sentence somebody
 * wrote for it, and everything else must not say anything about how the server is built.
 *
 *   npx tsx src/scripts/verify-error-messages.ts
 */
import { respondWithError } from '../utils/respondWithError';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** A stand-in Response that records what would have been sent. */
function captor() {
  const res: any = { code: 0, body: null };
  res.status = (c: number) => { res.code = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

/** Anything that would tell a reader how the server is built or where its files live. */
const LEAKS = /Invalid `|prisma\.|codeGenerator|node_modules|\.ts:\d+|villy|ECONNREFUSED|127\.0\.0\.1/;

const PRISMA_DUMP = [
  '',
  'Invalid `db.clientSequence.upsert()` invocation in',
  'D:\\villy\\inventory\\backend\\src\\utils\\codeGenerator.ts:65:44',
  '',
  'Transaction failed due to a write conflict or a deadlock. Please retry your transaction'
].join('\n');

function main() {
  console.log('\nA. WHAT REACHES THE BROWSER');

  const dump = captor();
  respondWithError(dump, new Error(PRISMA_DUMP), { status: 400 });
  check('the exact dump seen in the UI is not passed through',
    !LEAKS.test(String(dump.body.message)), String(dump.body.message).slice(0, 120));
  check('  ...and a write conflict answers 409, not 400',
    dump.code === 409, String(dump.code));
  check('  ...in words a person can act on',
    /same moment|try again/i.test(String(dump.body.message)), String(dump.body.message));

  const db = captor();
  respondWithError(db, new Error('connect ECONNREFUSED 127.0.0.1:5432'), { status: 500 });
  check('a database connection failure says nothing about the database',
    !LEAKS.test(String(db.body.message)), String(db.body.message));

  const internalWithStatus = captor();
  respondWithError(
    internalWithStatus,
    Object.assign(new Error('Invalid `prisma.product.findMany()` invocation'), { statusCode: 400 }),
    { status: 400 }
  );
  check('an internal message is scrubbed even when it carries a status',
    !LEAKS.test(String(internalWithStatus.body.message)), String(internalWithStatus.body.message));

  console.log('\nB. DELIBERATE REFUSALS KEEP THEIR WORDING');

  const notFound = captor();
  respondWithError(notFound, Object.assign(new Error('Order not found'), { statusCode: 404 }), { status: 400 });
  check('a 404 keeps its status and its sentence',
    notFound.code === 404 && notFound.body.message === 'Order not found',
    `${notFound.code} ${notFound.body.message}`);

  const conflict = captor();
  const sentence = 'This order has already been confirmed. Refresh to see where it got to.';
  respondWithError(conflict, Object.assign(new Error(sentence), { statusCode: 409 }), { status: 400 });
  check('a 409 raised on purpose is shown as written',
    conflict.code === 409 && conflict.body.message === sentence,
    `${conflict.code} ${conflict.body.message}`);

  const fallback = captor();
  respondWithError(fallback, new Error('some internal thing at /usr/lib/x.ts:9'), {
    status: 500, message: 'Could not load orders.'
  });
  check("an unexpected fault uses the caller's own wording when it has one",
    fallback.body.message === 'Could not load orders.', String(fallback.body.message));

  console.log('\nC. THE OLDER KEY IS STILL ANSWERED');
  check('`error` mirrors `message`, for the few screens that still read it',
    notFound.body.error === notFound.body.message);
}

main();
console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed ? 1 : 0);
