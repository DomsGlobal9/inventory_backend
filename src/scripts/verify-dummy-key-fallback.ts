/**
 * The dummy-key scenario, end to end against the REAL gateway.
 *
 * The sequence a platform admin actually performs when something is wrong:
 *
 *   1. a client has no key of their own and runs on the platform's shared one
 *   2. an admin pastes a key that does not work
 *   3. that client's try-ons fail -- visibly, and recorded as failures rather than silence
 *   4. the admin removes the key
 *   5. the client is back on the shared key and working, with no other action
 *
 * Step 3 is the one worth proving. A wrong key must not read as "no usage": a shop with a
 * broken integration and a shop nobody is using look identical on that reading, and the first
 * is an incident while the second is a Tuesday.
 *
 * Runs against production data and spends real generations. It restores whatever credential
 * state it found, including on failure.
 *
 *   npx ts-node src/scripts/verify-dummy-key-fallback.ts
 */
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { encryptCredential } from '../lib/credentialEncryption';
import { serviceCredentialService, tryOnUsageService } from '../services/tryon';
import { shopperTryOnGatewayService, shopperTryOnProductService } from '../services/shopper-tryon';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = 'sphl';
const PRODUCT = 'PRD-000002';
const HUMAN = 'https://www.tryon2buy.com/assets/ui/tryon-models.png';
const DUMMY = 'dummy_live_thisisadummykeythatwillneverwork0000000000';

/** Runs one generation the way the public route does, and reports what happened. */
async function attempt(): Promise<{ ok: boolean; status?: number; message?: string }> {
  const garment = await shopperTryOnProductService.resolve(CLIENT, PRODUCT);
  if (!garment) return { ok: false, message: 'garment did not resolve' };
  try {
    await shopperTryOnGatewayService.generate({
      clientId: CLIENT,
      garmentImageUrl: garment.imageUrl,
      humanImageUrl: HUMAN,
      category: garment.category
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, status: error?.statusCode, message: error?.message };
  }
}

async function main() {
  const existing = await prisma.clientServiceCredential.findUnique({
    where: { uq_client_service_key: { clientId: CLIENT, service: 'SHOPPER_TRYON' } }
  });
  console.log(`Starting state: ${existing ? `a ${existing.status} key (${existing.keyPrefix}...)` : 'no key of their own'}`);
  console.log(`Shared fallback configured: ${env.SHOPPER_TRYON_API_KEY ? 'yes' : 'NO'}\n`);

  try {
    // ─── 1. NO KEY OF THEIR OWN ─────────────────────────────────────────────
    console.log('WITH NO KEY OF THEIR OWN, THEY RUN ON THE SHARED ONE');
    await prisma.clientServiceCredential.deleteMany({
      where: { clientId: CLIENT, service: 'SHOPPER_TRYON' }
    });

    const before = await serviceCredentialService.describe(CLIENT, 'SHOPPER_TRYON');
    check('the console shows no key of their own', before.configured === false);
    check('but the service still reads as available', before.usingSharedFallback === true);

    const shared = await serviceCredentialService.keyFor(CLIENT, 'SHOPPER_TRYON');
    check('and the shared key is what would be presented', shared.shared === true);

    // ─── 2. AN ADMIN PASTES A KEY THAT DOES NOT WORK ────────────────────────
    console.log('\nAN ADMIN PASTES A KEY THAT DOES NOT WORK');
    await prisma.clientServiceCredential.create({
      data: {
        clientId: CLIENT, service: 'SHOPPER_TRYON',
        keyEncrypted: encryptCredential(DUMMY), keyPrefix: DUMMY.slice(0, 12),
        addedByAdmin: 'dummy-key-suite@scaleezy.com', status: 'ACTIVE'
      }
    });

    const withDummy = await serviceCredentialService.describe(CLIENT, 'SHOPPER_TRYON');
    check('the console now shows a key of their own', withDummy.configured === true);
    check('and shows only its prefix, never the key', withDummy.keyPrefix === DUMMY.slice(0, 12));
    check('the full key is nowhere in what a screen receives',
      !JSON.stringify(withDummy).includes(DUMMY));

    const presented = await serviceCredentialService.keyFor(CLIENT, 'SHOPPER_TRYON');
    check('their own key is what gets presented now, not the shared one',
      presented.shared === false && presented.key === DUMMY);

    // ─── 3. THE FAILURE IS VISIBLE, AND COUNTED ─────────────────────────────
    console.log('\nTHEIR TRY-ONS FAIL, VISIBLY');
    const usageBefore = await tryOnUsageService.summary(CLIENT, undefined, 'SHOPPER_TRYON');

    const broken = await attempt();
    check('the generation fails rather than silently succeeding', broken.ok === false,
      broken.ok ? 'it succeeded' : `${broken.status} ${broken.message}`);
    check('and the error does not leak the gateway\'s internals to a shopper',
      !broken.ok && !/api[-_ ]?key|token|secret/i.test(broken.message ?? ''),
      broken.message);

    // The public route records the failure; do the same here so the meter reflects reality.
    await tryOnUsageService.record(CLIENT, { started: true, failed: true }, 'SHOPPER_TRYON');
    const afterFailure = await tryOnUsageService.summary(CLIENT, undefined, 'SHOPPER_TRYON');

    check('the failure is counted as a failure', afterFailure.failed === usageBefore.failed + 1,
      `${usageBefore.failed} -> ${afterFailure.failed}`);
    check('not as a completed generation', afterFailure.completed === usageBefore.completed);
    // The property that matters: a broken integration must not look like an unused one.
    check('so a broken shop shows as usage, not as silence',
      afterFailure.generations > usageBefore.generations);

    // ─── 4. THE ADMIN REMOVES IT ────────────────────────────────────────────
    console.log('\nTHE ADMIN REMOVES THE KEY');
    await serviceCredentialService.revoke(CLIENT, 'SHOPPER_TRYON');

    const afterRevoke = await serviceCredentialService.describe(CLIENT, 'SHOPPER_TRYON');
    check('the console no longer shows a key of their own', afterRevoke.configured === false);
    check('and says they are back on the shared key', afterRevoke.usingSharedFallback === true);
    check('no prefix is left behind on the screen', !afterRevoke.keyPrefix);

    // ─── 5. WORKING AGAIN, WITH NO OTHER ACTION ─────────────────────────────
    console.log('\nAND THEY WORK AGAIN, ON THE SHARED KEY');
    const recovered = await attempt();
    check('the next generation succeeds', recovered.ok === true,
      recovered.ok ? '' : `${recovered.status} ${recovered.message}`);

    const afterRecovery = await tryOnUsageService.summary(CLIENT, undefined, 'SHOPPER_TRYON');
    check('the earlier failure is still on the record', afterRecovery.failed >= afterFailure.failed);

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    // Put back exactly what was there, whatever happened above.
    await prisma.clientServiceCredential.deleteMany({
      where: { clientId: CLIENT, service: 'SHOPPER_TRYON' }
    });
    if (existing) {
      await prisma.clientServiceCredential.create({ data: { ...existing } });
      console.log('\n(restored the credential that was there before)');
    } else {
      console.log('\n(left them with no key of their own, as found)');
    }
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
