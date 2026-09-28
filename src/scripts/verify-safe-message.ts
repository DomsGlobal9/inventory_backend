/** What a shopkeeper is allowed to be shown. */
import { safeMessage } from '../lib/safeMessage';

const FALLBACK = 'The photo studio could not finish this one. Please try again.';
let passed = 0, failed = 0;
const hide = (input: string, why: string) => {
  const out = safeMessage(input, FALLBACK);
  const ok = out === FALLBACK;
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] hidden: ${why}  -- ${JSON.stringify(input).slice(0, 62)}`);
};
const keep = (input: string, why: string) => {
  const out = safeMessage(input, FALLBACK);
  const ok = out === input;
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] kept:   ${why}  -- ${JSON.stringify(input).slice(0, 62)}`);
};

console.log('\nSUPPLIERS AND MACHINE TALK ARE HIDDEN');
hide('Gemini API produced no response after retries.', 'the one a real shop was shown');
hide('OpenAI request failed', 'another supplier');
hide('Vertex AI quota exhausted', 'a supplier with a space in its name');
hide('Request failed with status code 503', 'a bare status code');
hide('upstream endpoint did not respond', 'machine words');
hide('Cannot read properties of undefined', 'a programmer error');
hide('Invalid `prisma.order.create()` invocation', 'still catches the old kind');
hide('connect ECONNREFUSED 127.0.0.1:5432', 'still catches a host and port');

console.log('\nOUR OWN SENTENCES SURVIVE');
keep('That colour was removed while its photographs were being made.', 'written for a shopkeeper');
keep('This shop has used its picture generations for the month.', 'the cap message');
keep('Cannot dispatch 5. Only 2 reserved remaining', 'a real instruction');
keep('Choose at least one colour to photograph.', 'plain guidance');
keep('That product is in the bin. Restore it before making photographs for it.', 'plain guidance');

console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
process.exit(failed ? 1 : 0);
