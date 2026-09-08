/**
 * The alert engine — the thing that tells a shopkeeper they are running out.
 *
 * It had no test. It runs inside the stock-change transaction, so it is invisible: nothing
 * calls it directly, nothing returns its result, and a shop only discovers it is broken by not
 * being warned about something. That is the worst way to find out.
 *
 * The behaviours that matter, in the order they happen to a real shop:
 *
 *   selling down to the reorder level raises a warning
 *   selling the last one escalates it rather than raising a second alert
 *   an escalation is unread again, because the shopkeeper needs to see it worsened
 *   restocking resolves it, without leaving a stale warning behind
 *   it never accumulates duplicates for the same variant in the same place
 *
 *   npx ts-node src/scripts/verify-alert-engine.ts
 */
import { prisma } from '../lib/prisma';
import { inventoryMutationService } from '../services/inventory-mutation.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `alert-e2e-${Date.now()}`;
const OTHER = `alert-other-${Date.now()}`;

async function alertsFor(clientId: string, variantId?: string) {
  return prisma.inventoryAlert.findMany({
    where: { clientId, ...(variantId ? { variantId } : {}) },
    orderBy: { createdAt: 'asc' }
  });
}

async function main() {
  try {
    const location = await prisma.stockLocation.create({
      data: { clientId: CLIENT, code: 'MAIN-STORE', name: 'Main Store', type: 'STORE' }
    });
    const product = await prisma.product.create({
      data: {
        clientId: CLIENT, productCode: 'PRD-ALERT-1', slug: `alert-${Date.now()}`,
        title: 'Alert Test Saree', category: 'WOMEN', productType: 'READY_TO_WEAR',
        status: 'ACTIVE', basePrice: 1000
      }
    });
    const variant = await prisma.productVariant.create({
      data: {
        clientId: CLIENT, productId: product.id, sku: `ALERT-${Date.now()}`,
        variantCode: 'VAR-A1', barcode: `BC-${Date.now()}`, size: 'M', colorName: 'Red',
        reorderLevel: 5, sellingPrice: 1200
      }
    });

    const move = (qty: number, reason: any) => inventoryMutationService.applyMovement({
      clientId: CLIENT, variantId: variant.id, locationId: location.id,
      movementType: qty >= 0 ? 'IN' : 'OUT',
      quantityDelta: qty, reason, createdBy: 'alert-suite'
    });

    // ─── HEALTHY STOCK IS QUIET ─────────────────────────────────────────────
    console.log('HEALTHY STOCK RAISES NOTHING');
    await move(20, 'INITIAL_STOCK');
    check('a well-stocked variant has no alert', (await alertsFor(CLIENT)).length === 0);

    // ─── FALLING TO THE REORDER LEVEL WARNS ─────────────────────────────────
    console.log('\nSELLING DOWN TO THE REORDER LEVEL RAISES A WARNING');
    await move(-15, 'SALE'); // 20 -> 5, exactly the reorder level
    let alerts = await alertsFor(CLIENT);
    check('an alert is raised', alerts.length === 1, `${alerts.length} alerts`);
    check('it is a low-stock warning', alerts[0]?.type === 'LOW_STOCK', String(alerts[0]?.type));
    check('with warning severity', alerts[0]?.severity === 'WARNING', String(alerts[0]?.severity));
    // At the level, not below it: a shopkeeper ordering when they hit the level has time; one
    // warned after they are already under it does not.
    check('it fires AT the reorder level, not one below', alerts[0]?.currentQuantity === 5,
      String(alerts[0]?.currentQuantity));
    check('and it records the threshold it fired against', alerts[0]?.threshold === 5,
      String(alerts[0]?.threshold));

    // ─── SELLING MORE DOES NOT PILE UP ──────────────────────────────────────
    console.log('\nSELLING MORE UPDATES THE SAME ALERT RATHER THAN ADDING ANOTHER');
    await move(-2, 'SALE'); // 5 -> 3
    alerts = await alertsFor(CLIENT);
    check('there is still exactly one alert', alerts.length === 1, `${alerts.length} alerts`);
    check('and it now shows the lower quantity', alerts[0]?.currentQuantity === 3,
      String(alerts[0]?.currentQuantity));

    // ─── RUNNING OUT ESCALATES ──────────────────────────────────────────────
    console.log('\nRUNNING OUT ESCALATES THE SAME ALERT');
    // Mark it read first, so the escalation's effect on read state is observable.
    await prisma.inventoryAlert.update({ where: { id: alerts[0].id }, data: { isRead: true } });

    await move(-3, 'SALE'); // 3 -> 0
    alerts = await alertsFor(CLIENT);
    check('still one alert, not a second', alerts.length === 1, `${alerts.length} alerts`);
    check('it becomes out-of-stock', alerts[0]?.type === 'OUT_OF_STOCK', String(alerts[0]?.type));
    check('and critical', alerts[0]?.severity === 'CRITICAL', String(alerts[0]?.severity));
    // The point of escalation: a shopkeeper who dismissed "getting low" must be told again
    // when it becomes "gone", or the dismissal silently swallows the worse news.
    check('and is unread again, because it got worse', alerts[0]?.isRead === false,
      String(alerts[0]?.isRead));

    // ─── RESTOCKING RESOLVES IT ─────────────────────────────────────────────
    console.log('\nRESTOCKING RESOLVES IT');
    await move(30, 'PURCHASE_RECEIPT'); // 0 -> 30
    alerts = await alertsFor(CLIENT);
    check('the alert is resolved', alerts[0]?.isResolved === true, String(alerts[0]?.isResolved));
    check('and no new alert was raised', alerts.length === 1, `${alerts.length} alerts`);
    // A resolved alert keeps the healthy quantity, so the history reads sensibly rather than
    // ending on the number that caused the panic.
    check('it records the quantity it recovered to', alerts[0]?.currentQuantity === 30,
      String(alerts[0]?.currentQuantity));

    // ─── AND CAN FIRE AGAIN AFTERWARDS ──────────────────────────────────────
    console.log('\nIT CAN FIRE AGAIN AFTER RESOLVING');
    await move(-28, 'SALE'); // 30 -> 2
    alerts = await alertsFor(CLIENT);
    const unresolved = alerts.filter(a => !a.isResolved);
    check('a fresh alert is raised', unresolved.length === 1, `${unresolved.length} open of ${alerts.length}`);
    check('rather than reopening the resolved one', alerts.length === 2, `${alerts.length} total`);

    // ─── TENANT ISOLATION ───────────────────────────────────────────────────
    console.log('\nONE SHOP\'S ALERTS ARE ITS OWN');
    check('another tenant sees none of them', (await alertsFor(OTHER)).length === 0);

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    await prisma.inventoryAlert.deleteMany({ where: { clientId: { in: [CLIENT, OTHER] } } }).catch(() => {});
    await prisma.inventoryTransaction.deleteMany({ where: { clientId: { in: [CLIENT, OTHER] } } }).catch(() => {});
    await prisma.inventoryStock.deleteMany({ where: { clientId: { in: [CLIENT, OTHER] } } }).catch(() => {});
    await prisma.productVariant.deleteMany({ where: { clientId: { in: [CLIENT, OTHER] } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { clientId: { in: [CLIENT, OTHER] } } }).catch(() => {});
    await prisma.stockLocation.deleteMany({ where: { clientId: { in: [CLIENT, OTHER] } } }).catch(() => {});
    console.log('\n(test tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
