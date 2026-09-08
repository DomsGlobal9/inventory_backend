/**
 * The identity cache must be fast AND must not keep anyone signed in who should not be.
 *
 * A cache in the authentication path is the kind of change that is easy to get 95% right and
 * dangerous in the other 5%: the failure is not a wrong number on a screen, it is a
 * deactivated account that still works. So the speed is checked once and the invalidation is
 * checked in every shape that matters.
 *
 *   npx ts-node src/scripts/verify-identity-cache.ts
 */
import { prisma } from '../lib/prisma';
import { loadIdentity, forgetIdentity, forgetClientIdentities } from '../lib/identityCache';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

async function main() {
  const user = await prisma.user.findFirst({
    where: { status: 'ACTIVE', roles: { some: {} } },
    select: { id: true, clientId: true, status: true }
  });
  if (!user) { console.log('No active user with a role to test against.'); return; }
  console.log(`Testing against ${user.id} (${user.clientId})\n`);

  const originalStatus = user.status;

  try {
    console.log('IT ANSWERS THE SAME QUESTION WITHOUT ASKING AGAIN');
    forgetIdentity(user.id);

    const coldStart = Date.now();
    const cold = await loadIdentity(user.id);
    const coldMs = Date.now() - coldStart;

    const warmStart = Date.now();
    const warm = await loadIdentity(user.id);
    const warmMs = Date.now() - warmStart;

    check('the first read reaches the database', cold !== null);
    check('the second is served from memory', warmMs < 5, `${warmMs}ms`);
    check('and is the same answer, not an emptier one',
      JSON.stringify(warm) === JSON.stringify(cold));
    console.log(`         (cold ${coldMs}ms -> warm ${warmMs}ms)`);

    console.log('\nA CHANGE OF STATUS IS NOT SERVED FROM MEMORY');
    // Written straight to the database, deliberately bypassing the service that would have
    // invalidated for us -- this is the check that the cache is genuinely cleared and not
    // merely bypassed by the code path used to change it.
    await prisma.user.update({ where: { id: user.id }, data: { status: 'INACTIVE' } });

    const stillCached = await loadIdentity(user.id);
    check('without being told, the old answer is still held', stillCached?.status === 'ACTIVE',
      String(stillCached?.status));

    forgetIdentity(user.id);
    const afterForget = await loadIdentity(user.id);
    check('forgetting one user re-reads that user', afterForget?.status === 'INACTIVE',
      String(afterForget?.status));
    // This is the property that matters: auth.middleware refuses anything not ACTIVE, so a
    // re-read showing INACTIVE is the same thing as being locked out.
    check('so a deactivated account is refused on its next request', afterForget?.status !== 'ACTIVE');

    console.log('\nSUSPENDING A WHOLE CLIENT CLEARS EVERYONE IN IT');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
    forgetIdentity(user.id);
    await loadIdentity(user.id); // back in the cache as ACTIVE

    await prisma.user.update({ where: { id: user.id }, data: { status: 'INACTIVE' } });
    forgetClientIdentities(user.clientId);
    const afterSuspend = await loadIdentity(user.id);
    check('a tenant-wide eviction reaches this user too', afterSuspend?.status === 'INACTIVE',
      String(afterSuspend?.status));

    forgetClientIdentities('some-other-client-entirely');
    check('and evicting a different tenant does not disturb this one',
      (await loadIdentity(user.id))?.status === 'INACTIVE');

    console.log('\nAN UNKNOWN USER IS NOT A REPEATED QUERY');
    const ghost = '00000000-0000-0000-0000-000000000000';
    check('an id that does not exist resolves to nobody', (await loadIdentity(ghost)) === null);
    const ghostStart = Date.now();
    await loadIdentity(ghost);
    check('and asking again does not go back to the database', Date.now() - ghostStart < 5);

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); for (const f of failures) console.log(`  - ${f}`); }
    if (failed) process.exitCode = 1;
  } finally {
    await prisma.user.update({ where: { id: user.id }, data: { status: originalStatus } });
    forgetIdentity(user.id);
    console.log(`\n(${user.id} restored to ${originalStatus})`);
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error('Suite crashed:', error); process.exitCode = 1; });
