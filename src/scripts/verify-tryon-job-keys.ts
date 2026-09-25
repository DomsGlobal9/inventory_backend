/**
 * Which job is being started, and whose is it?
 *
 * The catalog service reads the body's `clientId` as a JOB NAME: a second request under the same
 * name cancels the first mid-stream. We used to send the tenant id for every generation, so a shop
 * had exactly one job name -- which is what would have made "generate all the colours" produce one
 * colour and three cancellations.
 *
 * The browser now chooses a suffix. It must never be able to choose the whole name, because the
 * name is what decides which job gets cancelled, and where the gateway's tenant header does not
 * arrive the far end falls back to one flat namespace shared by every customer.
 *
 * So this checks the one function that builds it, from both directions: that two colours of one
 * shop are two different jobs, and that nothing a caller sends can reach outside its own shop.
 *
 *   npx tsx src/scripts/verify-tryon-job-keys.ts
 */
import { jobKeyFor } from '../services/tryon';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// What the far end will accept; anything outside it is ignored as malformed (identity.js).
const ACCEPTED = /^[A-Za-z0-9._:-]{1,128}$/;

function main() {
  console.log('\nTRY-ON JOB NAMES\n');

  console.log('A. TWO COLOURS OF ONE PRODUCT ARE TWO JOBS');
  const red = jobKeyFor('sphl', 'Crimson');
  const blue = jobKeyFor('sphl', 'RoyalBlue');
  check('a colour gets its own job name', red !== blue, `${red} vs ${blue}`);
  check('  ...and both say which shop they belong to',
    red.startsWith('sphl:') && blue.startsWith('sphl:'), `${red} / ${blue}`);
  check('the same colour twice is the same job -- so a retry replaces it, not runs beside it',
    jobKeyFor('sphl', 'Crimson') === red, red);

  console.log('\nB. NO CALLER CAN NAME A JOB OUTSIDE ITS OWN SHOP');
  // Every one of these is a caller trying to be, or collide with, another shop.
  const attacks: [string, unknown][] = [
    ['another tenant outright', 'demo-client'],
    ['a name that looks prefixed', 'demo-client:crimson'],
    ['climbing out with a colon', '../demo-client'],
    ['leading colon', ':demo-client'],
    ['whitespace padding', '   demo-client   '],
    ['an object', { clientId: 'demo-client' }],
    ['a number', 12345],
    ['null', null]
  ];
  for (const [what, value] of attacks) {
    const key = jobKeyFor('sphl', value);
    check(`${what} still lands inside sphl`,
      key === 'sphl' || key.startsWith('sphl:'), `${JSON.stringify(value)} -> ${key}`);
  }
  check('one shop can never produce another shop\'s bare name',
    attacks.every(([, v]) => jobKeyFor('sphl', v) !== jobKeyFor('demo-client', v)));

  console.log('\nC. THE NAME IS ALWAYS SOMETHING THE FAR END ACCEPTS');
  const awkward: [string, unknown][] = [
    ['a hex colour code', '#dc143c'],
    ['a colour with a space', 'Royal Blue'],
    ['unicode', 'नीला'],
    ['a quote', `O'Brien`],
    ['a very long suffix', 'x'.repeat(400)],
    ['empty', ''],
    ['only punctuation', '#$%^&*']
  ];
  for (const [what, value] of awkward) {
    const key = jobKeyFor('verify-suites-tenant', value);
    check(`${what} -> a usable name`, ACCEPTED.test(key), `${JSON.stringify(value)} -> ${JSON.stringify(key)}`);
  }
  check('a long suffix cannot push the name past the limit',
    jobKeyFor('verify-suites-tenant', 'x'.repeat(400)).length <= 128);

  console.log('\nD. A SHOP THAT NAMES NOTHING STILL GETS ITS OWN JOB');
  check('no suffix falls back to the tenant, as before', jobKeyFor('sphl', undefined) === 'sphl');
  check('  ...so cancelling without a name still stops that shop\'s job',
    jobKeyFor('sphl', '') === 'sphl');
  check('  ...and two shops with no name are still separate',
    jobKeyFor('sphl', undefined) !== jobKeyFor('demo-client', undefined));

  console.log(`\n${passed} passed | ${failed} failed`);
  if (failures.length) { console.log('Failed:\n  - ' + failures.join('\n  - ')); process.exitCode = 1; }
}

main();
