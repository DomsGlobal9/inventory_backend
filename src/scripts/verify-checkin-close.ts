/**
 * Closing a door arrival from CRM's Shop floor (12 Nov 2026): "Not here" (LEFT / MISTAKE), its undo, and
 * that nothing waits for a closed arrival any more (no bell, no "sorry for the wait"). Plus how DONE and a
 * bill record how it ended. Service level, on a throwaway shop, LOCAL database only.
 *
 *   DATABASE_URL=<local> DIRECT_URL=<local> npx tsx src/scripts/verify-checkin-close.ts
 */
import { prisma } from '../lib/prisma';
import { doorCheckins, UNDO_MS, WAIT_ALERT_MS } from '../services/door-checkin';

for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
const STAMP = Date.now();
const CLIENT = `checkin-close-${STAMP}`;
const NOCRM = `checkin-close-nocrm-${STAMP}`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const fails = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return e; } };

async function main() {
  const store = await prisma.stockLocation.create({ data: { clientId: CLIENT, name: 'Main', code: `CC-${STAMP}`, type: 'STORE' as any, active: true } });
  // Walk-ins are taken on CRM's Shop floor: this shop has CRM. NOCRM has not.
  await prisma.moduleSubscription.create({ data: { clientId: CLIENT, module: 'crm', enabledBy: 'verify-checkin-close' } as any });
  const plainStore = await prisma.stockLocation.create({ data: { clientId: NOCRM, name: 'Plain', code: `CP-${STAMP}`, type: 'STORE' as any, active: true } });
  const priya = { id: `u-priya-${STAMP}`, name: 'Priya', owner: false };
  const ravi = { id: `u-ravi-${STAMP}`, name: 'Ravi', owner: false };
  const owner = { id: `u-owner-${STAMP}`, name: 'Owner', owner: true };
  const arrive = (minsAgo = 1, phone = `+9190000440${Math.floor(Math.random() * 90 + 10)}`) =>
    prisma.storeCheckin.create({ data: { clientId: CLIENT, locationId: store.id, phone, createdAt: new Date(Date.now() - minsAgo * 60_000), waitingSince: new Date(Date.now() - minsAgo * 60_000) } });
  const row = (id: string) => prisma.storeCheckin.findUniqueOrThrow({ where: { id } });

  console.log('A. NOT HERE ON A WALK-IN NOBODY HAS TAKEN');
  const a = await arrive(1);
  let r: any = await doorCheckins.close(CLIENT, a.id, 'LEFT', ravi);
  let x = await row(a.id);
  check('anyone can close it: done, LEFT, by Ravi', r.done && x.doneAt !== null && x.closedAs === 'LEFT' && x.closedByName === 'Ravi', JSON.stringify(x));
  r = await doorCheckins.close(CLIENT, a.id, 'MISTAKE', priya);
  x = await row(a.id);
  check('closing again answers the same and changes nothing', r.closedAs === 'LEFT' && x.closedAs === 'LEFT' && x.closedByName === 'Ravi', JSON.stringify(r));
  check('a wrong "as" is refused in words', (await fails(doorCheckins.close(CLIENT, (await arrive()).id, 'GONE', ravi)))?.message === 'Say how it ended: LEFT, MISTAKE or DONE.');
  check('DONE on a walk-in nobody has taken: refused (nobody served them)', /Nobody is with them yet/.test((await fails(doorCheckins.close(CLIENT, (await arrive()).id, 'DONE', ravi)))?.message ?? ''));
  check('an arrival of another shop: not found', /could not be found/.test((await fails(doorCheckins.close('someone-else', a.id, 'LEFT', owner)))?.message ?? ''));

  console.log('\nB. NO "SORRY FOR THE WAIT" AFTER IT');
  const late = await arrive(Math.ceil(WAIT_ALERT_MS / 60_000) + 2);
  await doorCheckins.close(CLIENT, late.id, 'LEFT', ravi);
  await doorCheckins.waitTick(new Date(), [CLIENT]);
  x = await row(late.id);
  check('a closed arrival is never alerted', x.waitAlertedAt === null && x.waitAlertId === null, JSON.stringify({ at: x.waitAlertedAt }));
  const alerted = await arrive(Math.ceil(WAIT_ALERT_MS / 60_000) + 2);
  await doorCheckins.waitTick(new Date(), [CLIENT]);
  const before = await row(alerted.id);
  await doorCheckins.close(CLIENT, alerted.id, 'LEFT', ravi);
  const bell = before.waitAlertId ? await prisma.inventoryAlert.findUnique({ where: { id: before.waitAlertId } }) : null;
  check('one already alerted: closing settles the owner\'s bell', !!bell && bell.isResolved === true, JSON.stringify({ alert: before.waitAlertId, resolved: bell?.isResolved }));

  // A shop without CRM (or one that switched it off) with an arrival left from before: nobody can take it,
  // so no bell and no "sorry for the wait".
  const old = await prisma.storeCheckin.create({ data: { clientId: NOCRM, locationId: plainStore.id, phone: '+919000044999',
    createdAt: new Date(Date.now() - 20 * 60_000), waitingSince: new Date(Date.now() - 20 * 60_000) } });
  await doorCheckins.waitTick(new Date(), [NOCRM]);
  const oldAfter = await row(old.id);
  check('a shop without CRM: an old waiting arrival gets no bell and no apology', oldAfter.waitAlertedAt === null && oldAfter.waitAlertId === null, JSON.stringify(oldAfter));

  console.log('\nC. A TAKEN CUSTOMER');
  const t = await arrive(2);
  await doorCheckins.take(CLIENT, t.id, priya);
  check('someone else may not close Priya\'s customer', (await fails(doorCheckins.close(CLIENT, t.id, 'LEFT', ravi)))?.statusCode === 403);
  r = await doorCheckins.close(CLIENT, t.id, 'LEFT', owner);
  check('the owner may (a visit left open at closing time)', r.closedAs === 'LEFT', JSON.stringify(r));
  const t2 = await arrive(2);
  await doorCheckins.take(CLIENT, t2.id, priya);
  r = await doorCheckins.close(CLIENT, t2.id, 'MISTAKE', priya);
  check('Priya may close her own, as a mistake', r.closedAs === 'MISTAKE', JSON.stringify(r));
  const t3 = await arrive(2);
  await doorCheckins.take(CLIENT, t3.id, priya);
  check('DONE by someone else on Priya\'s customer: refused', (await fails(doorCheckins.close(CLIENT, t3.id, 'DONE', ravi)))?.statusCode === 403);
  r = await doorCheckins.close(CLIENT, t3.id, 'DONE', priya);
  x = await row(t3.id);
  check('CRM ends Priya\'s visit as served: DONE, by Priya, and it cannot be undone as a Not here', r.closedAs === 'DONE' && x.closedByName === 'Priya'
    && /Only a "Not here"/.test((await fails(doorCheckins.reopen(CLIENT, t3.id, priya)))?.message ?? ''), JSON.stringify(x));

  console.log('\nD. UNDO');
  const u = await arrive(1);
  await doorCheckins.close(CLIENT, u.id, 'LEFT', ravi);
  check('someone else cannot undo Ravi\'s "Not here"', (await fails(doorCheckins.reopen(CLIENT, u.id, priya)))?.statusCode === 403);
  r = await doorCheckins.reopen(CLIENT, u.id, ravi);
  x = await row(u.id);
  check('Ravi undoes it: waiting again, as before', r.done === false && x.doneAt === null && x.closedAs === null && x.takenAt === null, JSON.stringify(x));
  await doorCheckins.close(CLIENT, u.id, 'LEFT', ravi);
  check('too late to undo after the undo window', /Too late/.test((await fails(doorCheckins.reopen(CLIENT, u.id, ravi, new Date(Date.now() + UNDO_MS + 5000))))?.message ?? ''));
  const d = await arrive(2);
  await doorCheckins.take(CLIENT, d.id, priya);
  await doorCheckins.done(CLIENT, d.id, priya);
  x = await row(d.id);
  check('Done records DONE, by Priya', x.closedAs === 'DONE' && x.closedByName === 'Priya', JSON.stringify(x));
  check('a Done cannot be "undone" as a Not here', /Only a "Not here"/.test((await fails(doorCheckins.reopen(CLIENT, d.id, owner)))?.message ?? ''));
  r = await doorCheckins.close(CLIENT, d.id, 'LEFT', owner);
  check('closing a finished one answers DONE, unchanged', r.closedAs === 'DONE', JSON.stringify(r));
}

main()
  .catch(e => { failed++; console.error('CRASHED', e); })
  .finally(async () => {
    const alerts = await prisma.storeCheckin.findMany({ where: { clientId: { in: [CLIENT, NOCRM] } }, select: { waitAlertId: true } });
    await prisma.inventoryAlert.deleteMany({ where: { id: { in: alerts.map(a => a.waitAlertId).filter(Boolean) as string[] } } }).catch(() => null);
    await prisma.storeCheckin.deleteMany({ where: { clientId: { in: [CLIENT, NOCRM] } } });
    await prisma.moduleSubscription.deleteMany({ where: { clientId: { in: [CLIENT, NOCRM] } } });
    await prisma.moduleEvent.deleteMany({ where: { clientId: { in: [CLIENT, NOCRM] } } });
    await prisma.stockLocation.deleteMany({ where: { clientId: { in: [CLIENT, NOCRM] } } });
    const left = await prisma.storeCheckin.count({ where: { clientId: { in: [CLIENT, NOCRM] } } });
    check('nothing left behind', left === 0);
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
