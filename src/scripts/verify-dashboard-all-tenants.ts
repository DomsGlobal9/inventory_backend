import { prisma } from '../lib/prisma';
import { reportService } from '../services/report.service';
import { inventoryService } from '../services/inventory.service';

/**
 * Every panel on the dashboard, for every tenant, at tenant level and at each location.
 *
 * The question is not whether the numbers are large -- an empty shop legitimately shows
 * zeros -- it is whether any tenant makes a panel THROW, because a throw is what turns the
 * dashboard blank rather than quiet.
 */
type Panel = [string, (c: string, l?: string) => Promise<unknown>];

const PANELS: Panel[] = [
  ['summary',      (c, l) => reportService.getDashboardSummary(c, l)],
  ['deadStock',    (c, l) => reportService.getDeadStock(c, 90, l)],
  ['supplierSpend',(c)    => reportService.getSupplierSpend(c)],
  ['stockMovement',(c, l) => reportService.getStockMovement(c, 30, l)],
  ['recentTxns',   (c, l) => reportService.getRecentTransactions(c, 10, l)],
  ['snapshots',    (c)    => reportService.getSnapshots(c, 30)],
  ['alerts',       (c: string) => inventoryService.getAlerts(c)]
];

(async () => {
  const clients = await prisma.user.findMany({
    distinct: ['clientId'], select: { clientId: true }, orderBy: { clientId: 'asc' }
  });
  const failures: string[] = [];
  for (const { clientId } of clients) {
    const locs = await prisma.stockLocation.findMany({ where: { clientId }, select: { id: true, code: true } });
    const scopes: [string, string | undefined][] = [['all', undefined], ...locs.map(l => [l.code, l.id] as [string, string])];
    const bad: string[] = [];
    for (const [scopeName, locationId] of scopes) {
      for (const [name, run] of PANELS) {
        try { await run(clientId, locationId); }
        catch (e: any) { bad.push(`${name}@${scopeName}: ${e.message?.split('\n')[0]}`); }
      }
    }
    if (bad.length) { failures.push(`${clientId}: ${bad.join(' | ')}`); console.log(`FAIL ${clientId}\n   ${bad.join('\n   ')}`); }
    else console.log(`ok   ${clientId} (${scopes.length} scopes x ${PANELS.length} panels)`);
  }
  console.log(`\n${clients.length} tenants | ${failures.length} with a failing panel`);
  // Said out loud, so this can be run from anything that reads an exit code rather than a
  // human reading the last line.
  if (failures.length) process.exitCode = 1;
  await prisma.$disconnect();
})().catch(error => {
  // Without this the sweep could die partway -- a dropped connection is enough -- and the
  // rejection would be all that was left of it. A check that cannot finish has not passed,
  // and must not be able to look like it did.
  console.error('\nSweep did not finish:', error?.message ?? error);
  process.exitCode = 1;
});
