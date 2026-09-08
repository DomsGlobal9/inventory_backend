import { prisma } from '../lib/prisma';

/** Times the reads a merchant actually waits on, so effort goes where the seconds are. */
const results: { name: string; ms: number }[] = [];
async function time<T>(name: string, fn: () => Promise<T>) {
  const t = Date.now();
  try { await fn(); } catch (e: any) { console.log(`  (${name} threw: ${String(e.message).slice(0, 60)})`); }
  results.push({ name, ms: Date.now() - t });
}

(async () => {
  const owner = await prisma.user.findFirst({
    where: { email: 'e2e1788452461634@example.com' }, select: { clientId: true, id: true }
  });
  const clientId = owner!.clientId;
  const loc = await prisma.stockLocation.findFirst({ where: { clientId }, select: { id: true } });

  const { productService } = await import('../services/product.service');
  const { inventoryService } = await import('../services/inventory.service');
  const { reportService } = await import('../services/report.service');
  const { teamService } = await import('../services/team.service');
  const salesOrder = await import('../services/sales-order.service');
  const { dayBookService } = await import('../services/daybook.service');

  // A cold measurement first -- the very first query pays connection setup too.
  await prisma.$queryRaw`SELECT 1`;

  await time('products list (page 1)', () => productService.getProducts(clientId, { page: 1, limit: 20 }));
  await time('inventory variants', () => inventoryService.getVariants(clientId, { page: 1, limit: 20 }, loc?.id));
  await time('inventory alerts', () => inventoryService.getAlerts(clientId));
  await time('inventory metadata', () => inventoryService.getMetadata());
  await time('dashboard summary', () => reportService.getDashboardSummary(clientId, loc?.id));
  await time('recent transactions', () => reportService.getRecentTransactions(clientId, 10, loc?.id));
  await time('dead stock', () => reportService.getDeadStock(clientId, 90, loc?.id));
  await time('supplier spend', () => reportService.getSupplierSpend(clientId));
  await time('stock movement chart', () => reportService.getStockMovement(clientId, 30, loc?.id));
  await time('snapshots', () => reportService.getSnapshots(clientId, 30));
  await time('team members', () => teamService.listMembers(clientId));
  await time('team activity', () => teamService.listActivity(clientId));
  await time('sales orders list', () => (salesOrder as any).salesOrderService.getOrders(clientId, {}));
  await time('day book (today)', () => (dayBookService as any).getToday(clientId, loc?.id));

  results.sort((a, b) => b.ms - a.ms);
  console.log('\nSLOWEST FIRST');
  for (const r of results) {
    const bar = '#'.repeat(Math.min(40, Math.round(r.ms / 250)));
    console.log(`  ${String(r.ms).padStart(6)}ms  ${r.name.padEnd(26)} ${bar}`);
  }
  const total = results.reduce((a, r) => a + r.ms, 0);
  console.log(`\n  total ${total}ms across ${results.length} calls`);
  await prisma.$disconnect();
})();
