/**
 * Writing an offer, changing it, and never rewriting what it already did.
 *
 * Two halves: the rules on their own (pure, no database), then a real offer through the real
 * service in a throwaway tenant.
 *
 * The property this suite exists to defend is the last one: an order priced in October must still
 * explain itself in March. Everything about versions is in service of that.
 *
 *   npx tsx src/scripts/verify-offers.ts
 */
import { prisma } from '../lib/prisma';
import {
  offerService, validateOffer, effectiveStatus, isLive, discountFor, compareCandidates
} from '../services/offers';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `offers-${Date.now()}`;
const USER = 'offer-writer';
const num = (v: any) => Number(v);

const day = (n: number) => new Date(Date.UTC(2026, 8, n, 0, 0, 0));

/** A valid offer, so each test states only what it is about. */
const draft = (over: any = {}) => ({
  name: 'Deepavali Sale',
  trigger: 'AUTOMATIC',
  level: 'LINE',
  valueType: 'PERCENTAGE',
  value: 20,
  scope: 'ALL',
  startsAt: day(1),
  endsAt: day(30),
  ...over
});

async function refuses(name: string, fragment: string, fn: () => Promise<any>) {
  try {
    await fn();
    check(name, false, 'it was accepted');
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    check(name, msg.toLowerCase().includes(fragment.toLowerCase()), `status=${e?.statusCode} "${msg}"`);
  }
}

async function main() {
  // ── A. WHAT MAKES AN OFFER VALID ───────────────────────────────────────
  console.log('\nA. WHAT MAKES AN OFFER VALID');

  check('a sensible offer has nothing wrong with it', validateOffer(draft()).length === 0,
    validateOffer(draft()).join(' '));
  check('an offer with no name is refused',
    validateOffer(draft({ name: '  ' })).some(p => /name/i.test(p)));
  check('a percentage over 100 is refused',
    validateOffer(draft({ value: 120 })).some(p => /more than 100/i.test(p)));
  check('an offer worth nothing is refused',
    validateOffer(draft({ value: 0 })).some(p => /more than nothing/i.test(p)));
  check('an offer that ends before it starts is refused',
    validateOffer(draft({ startsAt: day(30), endsAt: day(1) })).some(p => /end before it starts/i.test(p)));
  check('a code offer with no code is refused',
    validateOffer(draft({ trigger: 'CODE' })).some(p => /needs a code/i.test(p)));
  check('a code with a space in it is refused',
    validateOffer(draft({ trigger: 'CODE', couponCode: 'DEEPA VALI' })).some(p => /letters, numbers/i.test(p)));
  check('an automatic offer carrying a code is refused',
    validateOffer(draft({ couponCode: 'X1' })).some(p => /cannot also have a code/i.test(p)));
  check('a category offer naming no categories is refused',
    validateOffer(draft({ scope: 'CATEGORY' })).some(p => /which categories/i.test(p)));
  check('an everything offer naming particular items is refused',
    validateOffer(draft({ targets: [{ scope: 'PRODUCT', refId: 'p1' }] }))
      .some(p => /cannot also list/i.test(p)));
  check('a cap on a fixed amount is refused',
    validateOffer(draft({ valueType: 'FIXED_AMOUNT', value: 500, maxDiscount: 100 }))
      .some(p => /only means something on a percentage/i.test(p)));

  /*
   * "500 off the order, but only for sarees" has no agreed meaning, and different merchants mean
   * different things by it. Refused rather than guessed at.
   */
  check('an order-level offer limited to certain products is refused',
    validateOffer(draft({ level: 'ORDER', scope: 'PRODUCT', targets: [{ scope: 'PRODUCT', refId: 'p1' }] }))
      .some(p => /comes off the whole order/i.test(p)));

  // ── B. WHAT AN OFFER IS WORTH ──────────────────────────────────────────
  console.log('\nB. WHAT AN OFFER IS WORTH');

  check('20% of 12,000', discountFor({ valueType: 'PERCENTAGE', value: 20 }, 1200000) === 240000);
  check('a cap holds it back',
    discountFor({ valueType: 'PERCENTAGE', value: 20, maxDiscount: 2000 }, 1200000) === 200000);
  check('a fixed amount comes straight off',
    discountFor({ valueType: 'FIXED_AMOUNT', value: 500 }, 1200000) === 50000);
  check('  ...but never more than the line is worth',
    discountFor({ valueType: 'FIXED_AMOUNT', value: 5000 }, 100000) === 100000);
  check('a fixed price takes the difference',
    discountFor({ valueType: 'FIXED_PRICE', value: 9999 }, 1200000, 1) === 200100);
  check('  ...per unit, not per basket',
    discountFor({ valueType: 'FIXED_PRICE', value: 9999 }, 3600000, 3) === 600300);
  check('  ...and nothing when it is already cheaper',
    discountFor({ valueType: 'FIXED_PRICE', value: 15000 }, 1200000, 1) === 0);
  check('nothing off nothing', discountFor({ valueType: 'PERCENTAGE', value: 20 }, 0) === 0);

  // ── C. WHEN AN OFFER IS ACTUALLY RUNNING ───────────────────────────────
  console.log('\nC. WHEN AN OFFER IS ACTUALLY RUNNING');

  const window = { status: 'ACTIVE' as const, startsAt: day(1), endsAt: day(30) };
  check('before it starts, it is scheduled', effectiveStatus(window, day(0)) === 'SCHEDULED');
  check('AT the moment it starts, it is running', effectiveStatus(window, day(1)) === 'ACTIVE');
  check('in the middle, it is running', effectiveStatus(window, day(15)) === 'ACTIVE');
  check('AT the moment it ends, it is over',
    effectiveStatus(window, day(30)) === 'EXPIRED', effectiveStatus(window, day(30)));
  check('a paused offer stays paused whatever the date',
    effectiveStatus({ ...window, status: 'PAUSED' }, day(15)) === 'PAUSED');
  check('an open-ended offer never expires',
    effectiveStatus({ status: 'ACTIVE', startsAt: day(1), endsAt: null }, day(3000)) === 'ACTIVE');

  check('an offer at its usage limit is not live',
    isLive({ ...window, usageLimit: 5, usageCount: 5 }, day(15)) === false);
  check('  ...and one below it is',
    isLive({ ...window, usageLimit: 5, usageCount: 4 }, day(15)) === true);
  check('no limit means no ceiling',
    isLive({ ...window, usageLimit: null, usageCount: 9999 }, day(15)) === true);

  // ── D. WHICH OF TWO OFFERS WINS ────────────────────────────────────────
  console.log('\nD. WHICH OF TWO OFFERS WINS A LINE');

  const cand = (o: any) => ({ priority: 0, amountMinor: 0, createdAt: day(1), id: 'a', ...o });
  check('higher priority wins',
    compareCandidates(cand({ priority: 10 }), cand({ priority: 5 })) < 0);
  check('at equal priority, the bigger discount wins',
    compareCandidates(cand({ amountMinor: 500 }), cand({ amountMinor: 100 })) < 0);
  check('then the older one',
    compareCandidates(cand({ createdAt: day(1) }), cand({ createdAt: day(2) })) < 0);
  /*
   * Two offers created in the same millisecond with the same value. Without the id as a final
   * key the database's row order decides, and the same basket prices differently on two runs --
   * the kind of bug nobody can reproduce and everybody remembers.
   */
  check('and finally the id, so the ordering is total',
    compareCandidates(cand({ id: 'a' }), cand({ id: 'b' })) < 0);
  check('  ...which makes it reproducible',
    [cand({ id: 'c' }), cand({ id: 'a' }), cand({ id: 'b' })].sort(compareCandidates).map(c => c.id).join('') === 'abc');

  // ── E. A REAL OFFER ────────────────────────────────────────────────────
  console.log('\nE. A REAL OFFER, THROUGH THE REAL SERVICE');

  const created: any = await offerService.create(CLIENT, draft() as any, USER);
  check('it is created', !!created.id);
  check('  ...with a code a merchant can quote', /^OFR-\d{6}$/.test(created.offerCode), created.offerCode);
  check('  ...as a DRAFT, never live on arrival', created.status === 'DRAFT', created.status);

  const v1 = await prisma.offerVersion.findMany({ where: { offerId: created.id } });
  check('  ...and version 1 is recorded', v1.length === 1 && v1[0].version === 1);
  check('  ...which the offer points at', created.currentVersionId === v1[0].id);

  await refuses('a percentage over 100 is refused by the service too', 'more than 100',
    () => offerService.create(CLIENT, draft({ value: 150 }) as any, USER));

  // ── F. CODES ARE UNIQUE ────────────────────────────────────────────────
  console.log('\nF. ONE CODE, ONE OFFER');

  const coded: any = await offerService.create(
    CLIENT, draft({ name: 'Code sale', trigger: 'CODE', couponCode: 'DEEPAVALI' }) as any, USER);
  check('a code offer is created', coded.couponCode === 'DEEPAVALI');

  await refuses('a second offer cannot take the same code', 'already uses the code',
    () => offerService.create(
      CLIENT, draft({ name: 'Copycat', trigger: 'CODE', couponCode: 'DEEPAVALI' }) as any, USER));

  // ── G. CHANGING IT, WITHOUT REWRITING HISTORY ──────────────────────────
  console.log('\nG. CHANGING IT, WITHOUT REWRITING HISTORY');

  await offerService.update(CLIENT, created.id, { name: 'Deepavali Mega Sale' } as any, USER);
  const afterRename = await prisma.offerVersion.count({ where: { offerId: created.id } });
  check('renaming it does NOT make a version', afterRename === 1, String(afterRename));

  await offerService.update(CLIENT, created.id, { value: 25 } as any, USER, 'Bumped to 25%');
  const versions = await prisma.offerVersion.findMany({
    where: { offerId: created.id }, orderBy: { version: 'asc' }
  });
  check('changing the rule DOES make a version', versions.length === 2, String(versions.length));
  check('  ...numbered in order', versions[1].version === 2);
  check('  ...with the note that explains it', versions[1].changeNote === 'Bumped to 25%');
  check('  ...and who did it', versions[1].changedBy === USER);

  check('VERSION 1 STILL SAYS 20%', String((versions[0].snapshot as any).value) === '20',
    String((versions[0].snapshot as any).value));
  check('  ...and version 2 says 25%', String((versions[1].snapshot as any).value) === '25');

  const reread: any = await offerService.getById(CLIENT, created.id);
  check('the offer now points at the newest version', reread.currentVersionId === versions[1].id);

  await offerService.update(CLIENT, created.id, { targets: [] } as any, USER);
  const afterNoChange = await prisma.offerVersion.count({ where: { offerId: created.id } });
  check('saving with nothing changed makes no version', afterNoChange === 2, String(afterNoChange));

  // ── H. STARTING AND STOPPING ───────────────────────────────────────────
  console.log('\nH. STARTING AND STOPPING');

  const live: any = await offerService.create(
    CLIENT, draft({ name: 'Live one', startsAt: new Date(Date.now() - 86400000), endsAt: null }) as any, USER);

  const started: any = await offerService.setStatus(CLIENT, live.id, 'ACTIVE', USER);
  check('a draft can be started', started.status === 'ACTIVE');
  check('  ...and it reads as running', effectiveStatus(started as any) === 'ACTIVE');

  const paused: any = await offerService.setStatus(CLIENT, live.id, 'PAUSED', USER);
  check('a running offer can be paused', paused.status === 'PAUSED');
  check('  ...and started again', (await offerService.setStatus(CLIENT, live.id, 'ACTIVE', USER)).status === 'ACTIVE');

  const expired: any = await offerService.create(
    CLIENT, draft({ name: 'Too late', startsAt: day(1), endsAt: day(2) }) as any, USER);
  await refuses('an offer that already ended cannot be started', 'already ended',
    () => offerService.setStatus(CLIENT, expired.id, 'ACTIVE', USER));

  const archived: any = await offerService.setStatus(CLIENT, expired.id, 'ARCHIVED', USER);
  check('anything can be archived', archived.status === 'ARCHIVED');
  await refuses('an archived offer cannot be started again', 'cannot be started again',
    () => offerService.setStatus(CLIENT, expired.id, 'ACTIVE', USER));
  await refuses('an archived offer cannot be edited', 'has been archived',
    () => offerService.update(CLIENT, expired.id, { value: 5 } as any, USER));

  // ── I. TWO PEOPLE AT ONCE ──────────────────────────────────────────────
  console.log('\nI. TWO PEOPLE PRESSING START AT ONCE');

  const raced: any = await offerService.create(
    CLIENT, draft({ name: 'Raced', startsAt: new Date(Date.now() - 86400000), endsAt: null }) as any, USER);

  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => offerService.setStatus(CLIENT, raced.id, 'ACTIVE', USER))
  );
  const ok = attempts.filter(a => a.status === 'fulfilled').length;
  const refusedCount = attempts.filter(
    a => a.status === 'rejected' && (a as any).reason?.statusCode === 409).length;

  /*
   * NOT "exactly one succeeds", and the difference matters.
   *
   * Confirming an order has to admit exactly one winner because the loser would reserve stock a
   * second time. Starting an offer has no such side effect: a caller that reads the row AFTER the
   * first one committed finds it already ACTIVE and returns it, which is an idempotent success and
   * the friendlier answer. Whether a given attempt lands in that branch or on the compare-and-set
   * is a matter of microseconds, so asserting a count here only produced a test that failed when
   * the database was fast.
   *
   * What must hold is that nothing CRASHED and the offer ended in one state.
   */
  check('every simultaneous start is either applied or a clean conflict',
    ok + refusedCount === 5, `${ok} succeeded, ${refusedCount} refused, of 5`);
  check('  ...and at least one really did the work', ok >= 1, String(ok));

  const racedAfter = await prisma.offer.findUniqueOrThrow({ where: { id: raced.id } });
  check('  ...leaving the offer running, once', racedAfter.status === 'ACTIVE', racedAfter.status);
  const racedVersions = await prisma.offerVersion.count({ where: { offerId: raced.id } });
  check('  ...and no extra versions written by the losers', racedVersions === 1, String(racedVersions));

  // ── K. SCHEDULING ──────────────────────────────────────────────────────
  console.log('\nK. AN OFFER SET UP IN ADVANCE');

  const soon = new Date(Date.now() + 7 * 86400000);
  const later = new Date(Date.now() + 14 * 86400000);
  const future: any = await offerService.create(
    CLIENT, draft({ name: 'Next Friday', startsAt: soon, endsAt: later }) as any, USER);

  const armed: any = await offerService.setStatus(CLIENT, future.id, 'ACTIVE', USER);
  check('an offer that starts later can still be armed', armed.status === 'ACTIVE', armed.status);
  check('  ...and reads as waiting, not running',
    effectiveStatus(armed as any) === 'SCHEDULED', effectiveStatus(armed as any));
  check('  ...so nothing can apply it yet',
    isLive({ ...armed, usageLimit: null, usageCount: 0 } as any) === false);

  /*
   * The bug this section exists for.
   *
   * Filtering on the STATUS COLUMN alone, "what is running" returns an offer that starts next
   * Friday and an offer that ended in August -- both of which the very same screen labels as not
   * running. The filters have to mean what the merchant means.
   */
  const running: any[] = await offerService.list(CLIENT, { status: 'ACTIVE' });
  check('"running" does not include one that starts next Friday',
    !running.some(o => o.id === future.id), running.map(o => o.name).join(', '));
  check('  ...and everything it does list really is running',
    running.every(o => o.effectiveStatus === 'ACTIVE'),
    running.map(o => o.effectiveStatus).join(', '));

  const scheduled: any[] = await offerService.list(CLIENT, { status: 'SCHEDULED' });
  check('"starts later" finds it', scheduled.some(o => o.id === future.id), String(scheduled.length));
  check('  ...and nothing that has already begun',
    scheduled.every(o => o.effectiveStatus === 'SCHEDULED'));

  // An armed offer whose end has passed. Its column still says ACTIVE, and it is not running.
  const done: any = await offerService.create(
    CLIENT, draft({ name: 'Ran in September', startsAt: day(1), endsAt: day(2) }) as any, USER);
  await prisma.offer.update({ where: { id: done.id }, data: { status: 'ACTIVE' } });

  const endedList: any[] = await offerService.list(CLIENT, { status: 'EXPIRED' });
  check('"ended" finds an offer time switched off', endedList.some(o => o.id === done.id), String(endedList.length));
  check('  ...and "running" does not', !(await offerService.list(CLIENT, { status: 'ACTIVE' })).some((o: any) => o.id === done.id));

  // A flash sale: a time of day on both ends, not just a date.
  const flashStart = new Date(Date.now() + 3600_000);
  const flashEnd = new Date(Date.now() + 7200_000);
  const flash: any = await offerService.create(
    CLIENT, draft({ name: 'Two hours only', startsAt: flashStart, endsAt: flashEnd }) as any, USER);
  check('an offer can run for hours rather than days',
    new Date(flash.endsAt).getTime() - new Date(flash.startsAt).getTime() === 3600_000,
    String(new Date(flash.endsAt).getTime() - new Date(flash.startsAt).getTime()));
  check('  ...and is not live before its hour',
    isLive({ ...flash, status: 'ACTIVE', usageLimit: null, usageCount: 0 } as any, new Date()) === false);
  check('  ...but is, inside it',
    isLive({ ...flash, status: 'ACTIVE', usageLimit: null, usageCount: 0 } as any,
      new Date(flashStart.getTime() + 60_000)) === true);

  // ── J. THE LIST A MERCHANT READS ───────────────────────────────────────
  console.log('\nJ. THE LIST A MERCHANT READS');

  const list: any[] = await offerService.list(CLIENT);
  check('every offer is listed', list.length === 8, String(list.length));
  check('each says what it IS, not what its column says',
    list.every(o => typeof o.effectiveStatus === 'string'));
  const dead = list.find(o => o.name === 'Too late');
  check('  ...so an archived one reads as archived', dead?.effectiveStatus === 'ARCHIVED', dead?.effectiveStatus);

  const filtered: any[] = await offerService.list(CLIENT, { status: 'ACTIVE' });
  check('the list can be filtered', filtered.every(o => o.status === 'ACTIVE') && filtered.length >= 1);

  const searched: any[] = await offerService.list(CLIENT, { search: 'DEEPAVALI' });
  check('and searched by code', searched.some(o => o.couponCode === 'DEEPAVALI'), String(searched.length));

  const detail: any = await offerService.getById(CLIENT, created.id);
  check('a single offer carries its history', detail.versions.length === 2);
  check('  ...and what it has saved people so far', num(detail.totalDiscounted) === 0 && detail.redemptionCount === 0);

  await refuses('an offer belonging to another shop is not found', 'no longer exists',
    () => offerService.getById('somebody-else', created.id));
}

main()
  .catch(e => { console.error('\nSUITE CRASHED:', e); failed++; failures.push('suite crashed'); })
  .finally(async () => {
    await prisma.offerRedemption.deleteMany({ where: { clientId: CLIENT } });
    await prisma.offerVersion.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offerTarget.deleteMany({ where: { offer: { clientId: CLIENT } } });
    await prisma.offer.deleteMany({ where: { clientId: CLIENT } });
    await prisma.clientSequence.deleteMany({ where: { clientId: CLIENT } });
    await prisma.$disconnect();

    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(failed ? 1 : 0);
  });
