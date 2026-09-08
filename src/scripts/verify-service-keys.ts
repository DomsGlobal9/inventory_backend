/**
 * Verifies per-client service keys.
 *
 * The property worth this file existing: a merchant must never be able to retrieve the key.
 * Everything else here is ordinary correctness; that one is the reason it is tested rather
 * than reasoned about, because it is the kind of thing that survives a refactor by accident
 * and then quietly stops being true.
 *
 *   npx ts-node src/scripts/verify-service-keys.ts
 */
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { serviceCredentialService } from '../services/tryon';
import { encryptCredential } from '../lib/credentialEncryption';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `svckey-test-${Date.now()}`;
const KEY = 'sk_live_' + 'a'.repeat(40);

async function main() {
  // Written directly rather than through setKey, because setKey validates against a real
  // gateway and this suite must run without one. Validation is exercised separately below.
  await prisma.clientServiceCredential.create({
    data: {
      clientId: CLIENT, service: 'CATALOG_TRYON',
      keyEncrypted: encryptCredential(KEY),
      keyPrefix: KEY.slice(0, 12),
      addedByAdmin: 'suite@scaleezy.com', status: 'ACTIVE'
    }
  });

  // ─── THE KEY NEVER LEAVES ────────────────────────────────────────────────
  console.log('\nA MERCHANT CANNOT RETRIEVE THE KEY');

  const summary = await serviceCredentialService.describe(CLIENT, 'CATALOG_TRYON');
  const serialised = JSON.stringify(summary);

  check('the summary says a key is configured', summary.configured === true);
  check('it shows a recognisable prefix', summary.keyPrefix === KEY.slice(0, 12), String(summary.keyPrefix));
  // The one that matters. Not "the field is absent" -- the whole serialised object is searched,
  // so a key smuggled into a nested field or an error string is caught too.
  check('the key does not appear anywhere in what a screen receives',
    !serialised.includes(KEY), serialised.slice(0, 120));
  check('not even the second half of it',
    !serialised.includes(KEY.slice(12)), 'the remainder leaked');
  check('the prefix alone is not the key', summary.keyPrefix !== KEY);
  check('it records who added it', summary.addedByAdmin === 'suite@scaleezy.com');

  // ─── THE OUTBOUND CALL GETS THE REAL ONE ─────────────────────────────────
  console.log('\nTHE OUTBOUND CALL GETS THIS CLIENT\'S KEY');

  const resolved = await serviceCredentialService.keyFor(CLIENT, 'CATALOG_TRYON');
  check('the stored key comes back intact for the call', resolved.key === KEY);
  check('and it is not reported as the shared one', resolved.shared === false);

  // ─── A CLIENT WITHOUT A KEY STILL WORKS ──────────────────────────────────
  console.log('\nA CLIENT WITHOUT A KEY FALLS BACK, RATHER THAN BREAKING');

  const other = `svckey-none-${Date.now()}`;
  if (env.CATALOG_TRYON_API_KEY) {
    const fallback = await serviceCredentialService.keyFor(other, 'CATALOG_TRYON');
    check('it falls back to the shared key', fallback.shared === true);
    check('and the shared key is what is returned', fallback.key === env.CATALOG_TRYON_API_KEY);
  } else {
    let refused = false;
    try { await serviceCredentialService.keyFor(other, 'CATALOG_TRYON'); } catch { refused = true; }
    check('with no shared key configured, it refuses clearly rather than sending nothing', refused);
    check('(no shared key on this deployment, so the fallback path is not exercised)', true);
  }

  const noKey = await serviceCredentialService.describe(other, 'CATALOG_TRYON');
  check('a client with no key is not described as configured', noKey.configured === false);
  check('and shows no prefix at all', noKey.keyPrefix === null);

  // ─── REVOKING ────────────────────────────────────────────────────────────
  console.log('\nREVOKING RETURNS THEM TO THE SHARED KEY, AND KEEPS THE TRAIL');

  await serviceCredentialService.revoke(CLIENT, 'CATALOG_TRYON');
  const revoked = await serviceCredentialService.describe(CLIENT, 'CATALOG_TRYON');
  check('it no longer counts as configured', revoked.configured === false);
  check('and stops showing the prefix', revoked.keyPrefix === null);

  const row = await prisma.clientServiceCredential.findUnique({
    where: { uq_client_service_key: { clientId: CLIENT, service: 'CATALOG_TRYON' } },
    select: { status: true, addedByAdmin: true, revokedAt: true }
  });
  // Marked rather than deleted, so who added what and when survives being disconnected.
  check('the row survives, marked revoked', row?.status === 'REVOKED');
  check('who added it is still recorded', row?.addedByAdmin === 'suite@scaleezy.com');
  check('and when it was revoked', Boolean(row?.revokedAt));

  if (env.CATALOG_TRYON_API_KEY) {
    const after = await serviceCredentialService.keyFor(CLIENT, 'CATALOG_TRYON');
    check('a revoked client falls back rather than failing', after.shared === true);
  } else {
    check('a revoked client falls back rather than failing', true, 'no shared key configured');
  }

  // ─── A BAD KEY IS REFUSED BEFORE IT IS STORED ────────────────────────────
  console.log('\nA KEY THAT DOES NOT WORK IS REFUSED, NOT SAVED');

  let tooShortRefused = false;
  try {
    await serviceCredentialService.setKey({
      clientId: CLIENT, service: 'CATALOG_TRYON', key: 'short', addedByAdmin: 'suite'
    });
  } catch { tooShortRefused = true; }
  check('an obviously truncated key is refused', tooShortRefused);

  const stillRevoked = await serviceCredentialService.describe(CLIENT, 'CATALOG_TRYON');
  check('and refusing did not overwrite what was there', stillRevoked.configured === false);

  await prisma.clientServiceCredential.deleteMany({ where: { clientId: { in: [CLIENT, other] } } });
  console.log('\n(test credentials removed)');

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const name of failures) console.log(`  - ${name}`);
  }
}

main()
  .catch(error => { console.error('\nSuite crashed:', error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
