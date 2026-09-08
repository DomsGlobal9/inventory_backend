import { prisma } from '../lib/prisma';
import { tryOnUsageService } from '../services/tryon';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  [PASS] ${n}`); } else { fail++; console.log(`  [FAIL] ${n}${d ? ' -> ' + d : ''}`); }
};

(async () => {
  const c = `usage-test-${Date.now()}`;

  console.log('\nOUTCOMES ARE COUNTED SEPARATELY');
  await tryOnUsageService.record(c, { started: true, completed: true, viewsGenerated: 4 });
  await tryOnUsageService.record(c, { started: true, completed: true, viewsGenerated: 3 });
  await tryOnUsageService.record(c, { started: true, failed: true });
  await tryOnUsageService.record(c, { started: true, cancelled: true });

  const s = await tryOnUsageService.summary(c);
  check('completed runs are counted', s.completed === 2, String(s.completed));
  check('failures are counted separately', s.failed === 1, String(s.failed));
  check('cancellations are counted separately', s.cancelled === 1, String(s.cancelled));
  // 3 + 4, not 2 x 4. A partial run is recorded as what it produced.
  check('views are what was produced, not four times the runs', s.viewsGenerated === 7, String(s.viewsGenerated));
  // completed + failed. A cancellation is the merchant stopping deliberately.
  check('billable generations exclude cancellations', s.generations === 3, String(s.generations));

  console.log('\nNO LIMIT MEANS NO LIMIT');
  check('an unlimited client has no ceiling', s.monthlyLimit === null && s.remaining === null);
  check('and is never over it', s.overLimit === false);
  await tryOnUsageService.assertWithinLimit(c);
  check('so a generation is allowed', true);

  console.log('\nA LIMIT WARNS BEFORE IT BITES');
  await tryOnUsageService.setMonthlyLimit(c, 4, 'suite@scaleezy.com');
  const warned = await tryOnUsageService.summary(c);
  check('3 of 4 is flagged as approaching', warned.approachingLimit === true, `${warned.generations}/${warned.monthlyLimit}`);
  check('but is not over', warned.overLimit === false);
  check('and remaining is shown', warned.remaining === 1, String(warned.remaining));
  await tryOnUsageService.assertWithinLimit(c);
  check('a generation is still allowed at 3 of 4', true);

  console.log('\nAT THE LIMIT IT REFUSES, WITH A USABLE MESSAGE');
  await tryOnUsageService.record(c, { started: true, completed: true, viewsGenerated: 4 });
  const over = await tryOnUsageService.summary(c);
  check('4 of 4 is over', over.overLimit === true, `${over.generations}/${over.monthlyLimit}`);
  check('remaining is zero, not negative', over.remaining === 0, String(over.remaining));

  let refusedWith = '';
  try { await tryOnUsageService.assertWithinLimit(c); }
  catch (e: any) { refusedWith = e.message; }
  check('a generation is refused', refusedWith.length > 0);
  check('and the message names the limit', refusedWith.includes('4'), refusedWith);

  console.log('\nRAISING THE LIMIT LETS THEM WORK AGAIN');
  await tryOnUsageService.setMonthlyLimit(c, 50, 'suite@scaleezy.com');
  await tryOnUsageService.assertWithinLimit(c);
  check('raising it unblocks immediately', true);

  await tryOnUsageService.setMonthlyLimit(c, null, 'suite@scaleezy.com');
  const cleared = await tryOnUsageService.summary(c);
  check('clearing it returns to unlimited', cleared.monthlyLimit === null && cleared.overLimit === false);

  await prisma.tryOnUsage.deleteMany({ where: { clientId: c } });
  await prisma.clientServiceLimit.deleteMany({ where: { clientId: c } });
  console.log('\n(test usage removed)');
  console.log(`\n================ RESULT: ${pass} passed | ${fail} failed ================`);
  if (fail) process.exitCode = 1;
  await prisma.$disconnect();
})().catch(error => {
  // A check that cannot finish has not passed. Without this the whole run could die on a
  // dropped connection and still leave a zero exit code behind it.
  console.error('\nSuite did not finish:', error?.message ?? error);
  process.exitCode = 1;
});
