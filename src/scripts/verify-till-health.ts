/**
 * The Platform Console's Till link page: each shop's tills, its last bill, and the bills Inventory
 * refused or that are stuck -- in the state order the page sorts by.
 *
 * Writes only rows the live queue worker never touches: REJECTED rows, and a RUNNING row with a
 * FRESH heartbeat (recoverStranded wants five minutes of silence). "Stuck" is reached by asking
 * the service about ten minutes from now instead of waiting. Deletes everything it made.
 *
 *   npx tsx src/scripts/verify-till-health.ts
 */
import { prisma } from '../lib/prisma';
import { tillHealthService } from '../services/platform-health';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`); }
};
const STAMP = Date.now();
const REFUSED = `till-health-refused-${STAMP}`;
const STUCK = `till-health-stuck-${STAMP}`;
const event = (clientId: string, invoiceNo: string, data: any) => ({
  clientId, locationId: 'test-location', kind: 'sale.completed', invoiceNo, payload: {}, ...data
});

async function main() {
  const now = new Date();
  await prisma.posInboundEvent.createMany({
    data: [
      event(REFUSED, 'INV/T/0001', { status: 'APPLIED', answer: 'APPLIED', settledAt: now, receivedAt: new Date(now.getTime() - 3600_000) }),
      event(REFUSED, 'INV/T/0002', { status: 'REJECTED', answer: 'UNKNOWN_ITEM', detail: 'Item X-1 is not in this shop', attempts: 1, settledAt: now, receivedAt: new Date(now.getTime() - 1800_000) }),
      event(REFUSED, 'INV/T/0003', { kind: 'document.skipped', status: 'APPLIED', answer: 'APPLIED', settledAt: now, receivedAt: new Date(now.getTime() + 1000) }),
      event(STUCK, 'INV/T/0001', { status: 'RUNNING', attempts: 1, heartbeatAt: now })
    ]
  });

  console.log('\nA. RIGHT NOW');
  let { clients } = await tillHealthService.overview(now);
  let r = clients.find(c => c.clientId === REFUSED);
  let s = clients.find(c => c.clientId === STUCK);
  check('a shop with a refused bill is CHECK', r?.state === 'CHECK', r?.state);
  check('refused count is 1', r?.refused7d === 1, r?.refused7d);
  check('the refused bill is listed with Inventory\'s answer and reason',
    r?.problems.length === 1 && r.problems[0].invoiceNo === 'INV/T/0002' && r.problems[0].answer === 'UNKNOWN_ITEM' && /X-1/.test(r.problems[0].detail ?? ''), r?.problems);
  check('last bill in ignores a left-out marker (document.skipped)',
    r?.lastBillAt?.getTime() === now.getTime() - 1800_000 || false, r?.lastBillAt);
  check('a shop with no till key shows 0 tills', r?.tills === 0, r?.tills);
  check('a bill running with a fresh heartbeat is waiting, not stuck', s?.waiting === 1 && s?.stuck === 0 && s?.state === 'OK', s);

  console.log('\nB. TEN MINUTES LATER, NO SIGN OF LIFE');
  ({ clients } = await tillHealthService.overview(new Date(now.getTime() + 10 * 60_000)));
  s = clients.find(c => c.clientId === STUCK);
  r = clients.find(c => c.clientId === REFUSED);
  check('the silent running bill is STUCK', s?.state === 'STUCK' && s.stuck === 1, s);
  check('it is listed as a problem', s?.problems[0]?.status === 'RUNNING', s?.problems);
  const order = clients.map(c => c.clientId);
  check('stuck shops sort above shops with a refused bill', order.indexOf(STUCK) < order.indexOf(REFUSED), order.slice(0, 5));

  console.log('\nC. EIGHT DAYS LATER');
  ({ clients } = await tillHealthService.overview(new Date(now.getTime() + 8 * 86_400_000)));
  r = clients.find(c => c.clientId === REFUSED);
  check('a refusal older than 7 days no longer counts', r?.refused7d === 0 && r.problems.length === 0 && r.state === 'OK', r);
}

main()
  .catch(e => { failed++; console.error(e); })
  .finally(async () => {
    await prisma.posInboundEvent.deleteMany({ where: { clientId: { in: [REFUSED, STUCK] } } });
    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
