/**
 * Verifies where one business day stops and the next begins.
 *
 * The question this answers: a movement recorded at 23:59:59 belongs to yesterday and one at
 * 00:00:00 belongs to today -- does the code actually draw the line there, and does stock that
 * existed BEFORE the day get carried in as the opening rather than counted again as if it
 * arrived today?
 *
 * It is tested with real movements whose timestamps are pinned to the exact edges, because
 * the failure being guarded against is an off-by-one in a comparison, and only a movement
 * sitting precisely on the boundary can catch that. Everything created here is removed again.
 *
 *   npx ts-node src/scripts/verify-day-boundary.ts
 */
import { prisma } from '../lib/prisma';
import { SnapshotService } from '../services/snapshot.service';
import { DayBookService } from '../services/daybook.service';
import { startOfLocalDay, todayKey, previousDayKey } from '../utils/businessDay';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

async function main() {
  const owner = await prisma.user.findFirst({
    where: { email: 'e2e1788452461634@example.com' }, select: { clientId: true }
  });
  if (!owner) throw new Error('Test tenant not found');
  const clientId = owner.clientId;

  const snapshots = new SnapshotService();
  const daybook = new DayBookService();
  const tz = await snapshots.getTimezone(clientId);
  const today = todayKey(tz);
  const yesterday = previousDayKey(today);

  const todayStart = startOfLocalDay(today, tz);           // 00:00:00.000 today == end of yesterday
  const lastMomentOfYesterday = new Date(todayStart.getTime() - 1); // 23:59:59.999 yesterday

  console.log(`\nshop timezone ${tz}`);
  console.log(`today begins at   ${todayStart.toISOString()} UTC`);
  console.log(`yesterday ends at ${lastMomentOfYesterday.toISOString()} UTC\n`);

  const location = await prisma.stockLocation.findFirst({
    where: { clientId }, select: { id: true }
  });
  if (!location) throw new Error('Tenant has no stock location');

  const baselineLive = (await prisma.inventoryStock.aggregate({
    where: { clientId }, _sum: { quantity: true }
  }))._sum.quantity || 0;
  const baselineClosing = (await snapshots.closingForDay(clientId, yesterday)).units;

  // Today's figures BEFORE the probe, so the assertions below can measure what the probe
  // added rather than assert a total. Asserting "today's stock in is 5" only held while the
  // tenant was idle; the moment anything else moved stock today -- which is the normal state
  // of a shop -- the test failed for a reason that had nothing to do with day boundaries.
  const dayBefore = await daybook.getDay(clientId, today);
  const stockInBefore = dayBefore.stockIn.totalUnits;

  // A throwaway product and variant, so nothing here touches real catalogue rows.
  const stamp = Date.now();
  const product = await prisma.product.create({
    data: {
      clientId, productCode: `BOUND-${stamp}`, slug: `bound-${stamp}`,
      title: 'Day boundary probe', status: 'DRAFT',
      category: 'WOMEN', productType: 'READY_TO_WEAR', basePrice: 0
    },
    select: { id: true }
  });

  const variant = await prisma.productVariant.create({
    data: {
      clientId, productId: product.id,
      variantCode: `BOUNDV-${stamp}`, sku: `BOUND-${stamp}-A`,
      barcode: `BOUND${stamp}`, size: 'M', colorName: 'Probe'
    },
    select: { id: true }
  });

  try {
    // 12 units land in the final millisecond of yesterday, 5 in the first of today. Written
    // directly so the timestamps sit exactly on the edge; stock is set to match, so live
    // stock and the ledger stay consistent, which is what closingForDay relies on.
    await prisma.inventoryTransaction.createMany({
      data: [
        {
          clientId, variantId: variant.id, locationId: location.id,
          type: 'IN', reason: 'PURCHASE', quantity: 12,
          balanceBefore: 0, balanceAfter: 12,
          createdBy: 'boundary-probe', createdAt: lastMomentOfYesterday
        },
        {
          clientId, variantId: variant.id, locationId: location.id,
          type: 'IN', reason: 'PURCHASE', quantity: 5,
          balanceBefore: 12, balanceAfter: 17,
          createdBy: 'boundary-probe', createdAt: todayStart
        }
      ]
    });
    await prisma.inventoryStock.create({
      data: { clientId, variantId: variant.id, locationId: location.id, quantity: 17 }
    });

    console.log('THE LINE IS DRAWN AT MIDNIGHT');

    const live = (await prisma.inventoryStock.aggregate({
      where: { clientId }, _sum: { quantity: true }
    }))._sum.quantity || 0;
    check('both movements are on the books', live === baselineLive + 17,
      `${live} vs ${baselineLive} + 17`);

    // Yesterday's closing must contain the 23:59:59.999 arrival and not the 00:00:00.000 one.
    const closing = await snapshots.closingForDay(clientId, yesterday);
    check('a movement at 23:59:59.999 counts towards the day that is ending',
      closing.units === baselineClosing + 12,
      `${closing.units} vs ${baselineClosing} + 12`);
    check('a movement at 00:00:00.000 does not',
      closing.units !== baselineClosing + 17, `${closing.units}`);

    console.log('\nWHAT CAME BEFORE IS CARRIED IN, NOT COUNTED AGAIN');

    const day = await daybook.getDay(clientId, today);
    check('yesterday\'s 12 units arrive as today\'s opening balance',
      day.opening.units === baselineClosing + 12,
      `opening ${day.opening.units} vs ${baselineClosing} + 12`);
    // The 12 from last night must NOT appear in today's arrivals, and the 5 from midnight
    // must. Both are one statement about the same number, so it is asserted once: today's
    // stock in grew by exactly the 5 that landed after midnight.
    check('yesterday\'s units are not also counted as arriving today, and midnight\'s are',
      day.stockIn.totalUnits === stockInBefore + 5,
      `today's stock in went ${stockInBefore} -> ${day.stockIn.totalUnits}, expected +5`);
    check('opening + in - out still equals closing',
      day.closing !== null &&
        day.opening.units + day.stockIn.totalUnits - day.stockOut.totalUnits === day.closing.units,
      `${day.opening.units} + ${day.stockIn.totalUnits} - ${day.stockOut.totalUnits} != ${day.closing?.units}`);
    check('today\'s closing equals the stock actually held',
      day.closing?.units === live, `${day.closing?.units} vs ${live}`);

    console.log('\nAND THE DAY BEFORE SEES ONLY ITS OWN');

    const yday = await daybook.getDay(clientId, yesterday);
    check('yesterday counts the 23:59:59.999 arrival',
      yday.stockIn.totalUnits >= 12, `${yday.stockIn.totalUnits}`);
    check('yesterday does not reach into today',
      yday.closing !== null && yday.closing.units === baselineClosing + 12,
      `${yday.closing?.units} vs ${baselineClosing} + 12`);
    check('yesterday\'s closing is today\'s opening, exactly',
      yday.closing?.units === day.opening.units,
      `${yday.closing?.units} vs ${day.opening.units}`);

  } finally {
    await prisma.inventoryTransaction.deleteMany({ where: { variantId: variant.id } });
    await prisma.inventoryStock.deleteMany({ where: { variantId: variant.id } });
    await prisma.productVariant.delete({ where: { id: variant.id } });
    await prisma.product.delete({ where: { id: product.id } });

    const after = (await prisma.inventoryStock.aggregate({
      where: { clientId }, _sum: { quantity: true }
    }))._sum.quantity || 0;
    console.log(`\n(probe removed; stock back to ${after}, was ${baselineLive} before)`);
    if (after !== baselineLive) {
      console.log('  WARNING: the tenant was not left as it was found');
    }
  }

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
