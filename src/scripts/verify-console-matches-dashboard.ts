/**
 * The merchant's dashboard and the platform console must agree about that merchant.
 *
 * These are two screens, written months apart, that answer the same questions about the same
 * shop -- how many products, how much stock is worth. Nothing forces them to agree, and when
 * this was first run they did not: 5 of 40 tenants showed one number to the merchant and a
 * different one to Scaleezy, in both directions, because each screen valued stock from a
 * different column. A support conversation where the two sides are looking at different money
 * is close to unresolvable, so this exists to make that drift fail loudly instead.
 *
 *   npx ts-node src/scripts/verify-console-matches-dashboard.ts
 */
import { prisma } from '../lib/prisma';
import { dashboardService } from '../services/dashboard.service';
import { platformAdminService } from '../services/platform-admin.service';

async function main() {
  const clients = await platformAdminService.listClients();
  console.log(`Comparing ${clients.length} clients\n`);

  const mismatches: string[] = [];
  // Rounded to the rupee: both sides sum the same Decimals, but going through
  // JavaScript numbers on either path can leave sub-paisa dust behind.
  const money = (n: number) => Math.round(n);

  for (const listRow of clients) {
    const [dash, overview] = await Promise.all([
      dashboardService.getSummary(listRow.clientId),
      platformAdminService.getClientSummary(listRow.clientId)
    ]);

    const report = (what: string, mine: unknown, theirs: unknown) => {
      if (mine === theirs) return;
      mismatches.push(`${listRow.clientId}: ${what} -- dashboard ${mine}, console ${theirs}`);
    };

    report('total products', dash.totalProducts, overview.productCount);
    report('active products', dash.activeProducts, overview.activeProductCount);
    report('inventory value', money(dash.inventoryValue), money(overview.inventoryValue));
    // The console's own list and its per-client page are two more queries that can drift
    // apart from each other, so the list row is checked against the detail as well.
    report('inventory value (console list vs console detail)',
      money(overview.inventoryValue), money(listRow.inventoryValue));
    report('products (console list vs console detail)', overview.productCount, listRow.productCount);
  }

  if (mismatches.length === 0) {
    console.log(`================ all ${clients.length} clients agree ================`);
  } else {
    console.log(`================ ${mismatches.length} MISMATCHES ================`);
    for (const m of mismatches) console.log(`  - ${m}`);
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

main().catch(error => { console.error('Suite crashed:', error); process.exitCode = 1; });
