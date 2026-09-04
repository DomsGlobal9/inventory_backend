import { prisma } from '../lib/prisma';
import { ReportService } from './report.service';
import { ValuationService } from './valuation.service';
import {
  localDayKey, startOfLocalDay, localDayKeyFromParts, todayKey, DEFAULT_TIMEZONE
} from '../utils/businessDay';

/**
 * Daily inventory snapshots.
 *
 * Two ways a row gets here, and the distinction matters:
 *
 *   takeSnapshot()          -- records the tenant's state as it is right now. This is the
 *                              only thing that should run day to day.
 *   reconstructFromLedger() -- rebuilds past days by replaying the transaction ledger.
 *
 * The previous backfill did neither. It read today's totals and wrote them back across N
 * days with `Math.random()` variance of +/-5% "for realistic backfill curves", so the
 * dashboard's Inventory Value Trend was drawing a history that never happened -- a chart a
 * merchant might reasonably use to decide what to buy. Every one of the 124 rows in this
 * table came from that. They are not approximations; they are invented.
 *
 * The replacement replays what actually occurred. Stock is fully reconstructible because
 * every movement goes through inventory-mutation.service and lands in InventoryTransaction
 * with a signed quantity and, for receipts, the unit cost -- which is exactly the input the
 * weighted-average calculation needs. Fields that genuinely cannot be recovered are left at
 * zero rather than guessed at; see reconstructFromLedger.
 */
export class SnapshotService {
  private reportService: ReportService;
  private valuationService: ValuationService;

  constructor() {
    this.reportService = new ReportService();
    this.valuationService = new ValuationService();
  }

  /** Tenants that have ever been issued a sequence -- i.e. have real activity. */
  async getActiveTenants(): Promise<string[]> {
    const clients = await prisma.clientSequence.findMany({
      distinct: ['clientId'],
      select: { clientId: true },
    });
    return clients.map(c => c.clientId);
  }

  /**
   * A snapshot is a BUSINESS day, so it is dated by the shop's own calendar rather than UTC.
   *
   * These were stored on UTC midnight, which put them out of step with anything that reports
   * by local day: for an Indian shop the UTC day for 4 September holds 10 movements while the
   * local day holds 11, so an opening balance taken from a UTC snapshot and movements counted
   * over a local day do not reconcile -- the day book's closing figure came out 8 units wrong
   * for exactly that reason.
   */
  async getTimezone(clientId: string): Promise<string> {
    const settings = await prisma.clientSettings.findUnique({
      where: { clientId }, select: { timezone: true }
    });
    return settings?.timezone || DEFAULT_TIMEZONE;
  }

  /** Next calendar day, as a "YYYY-MM-DD" key. */
  private static nextDayKey(dayKey: string): string {
    const [y, m, d] = dayKey.split('-').map(Number);
    return localDayKeyFromParts(y, m, d, 1);
  }

  /**
   * Records today's state. This is measurement, not reconstruction -- it reads the live
   * figures the dashboard shows and stores them against today's date.
   */
  async takeSnapshot(clientId: string, date: Date = new Date()) {
    const timezone = await this.getTimezone(clientId);
    const summary = await this.reportService.getDashboardSummary(clientId);
    const valuation = await this.valuationService.getTenantValue(clientId);
    // Dated by the shop's calendar, and re-run through the day so the row always holds the
    // most recent figure -- by closing time that is the day's true end state.
    const snapshotDate = startOfLocalDay(localDayKey(date, timezone), timezone);

    const values = {
      totalValue: summary.inventoryValue,
      totalUnits: valuation.totalUnits,
      totalVariants: valuation.totalVariants,
      activeProducts: summary.activeProducts,
      lowStockCount: summary.lowStockCount,
      deadStockValue: summary.deadStockValue,
      openPoValue: summary.openPoValue
    };

    const snapshot = await prisma.dailyInventorySnapshot.upsert({
      where: { clientId_snapshotDate: { clientId, snapshotDate } },
      update: values,
      create: { clientId, snapshotDate, ...values }
    });

    await this.takeLocationSnapshots(clientId, snapshotDate);
    return snapshot;
  }

  /**
   * The same measurement, per location.
   *
   * Kept alongside the company-wide row because a transfer is invisible in the company total
   * -- moving 40 units from the warehouse to the shop changes nothing overall, and without a
   * per-location record there is no way to see it happened at all.
   *
   * Value uses the variant's average cost, which is a single figure across every location:
   * the same item is not valued differently depending on which shelf it sits on. That matches
   * how inventoryValue is calculated everywhere else.
   */
  async takeLocationSnapshots(clientId: string, snapshotDate: Date) {
    const stocks = await prisma.inventoryStock.findMany({
      where: { clientId },
      select: { locationId: true, quantity: true, variant: { select: { averageCost: true } } }
    });

    const byLocation = new Map<string, { units: number; value: number }>();
    for (const row of stocks) {
      const acc = byLocation.get(row.locationId) || { units: 0, value: 0 };
      acc.units += row.quantity;
      acc.value += row.quantity * Number(row.variant?.averageCost || 0);
      byLocation.set(row.locationId, acc);
    }

    // Locations holding nothing still get a row. A location that emptied out today would
    // otherwise keep yesterday's figure as its most recent snapshot and read as still full.
    const locations = await prisma.stockLocation.findMany({
      where: { clientId }, select: { id: true }
    });
    for (const loc of locations) {
      if (!byLocation.has(loc.id)) byLocation.set(loc.id, { units: 0, value: 0 });
    }

    for (const [locationId, totals] of byLocation) {
      await prisma.dailyLocationSnapshot.upsert({
        where: { uq_location_snapshot_day: { locationId, snapshotDate } },
        update: { totalUnits: totals.units, totalValue: totals.value },
        create: { clientId, locationId, snapshotDate, totalUnits: totals.units, totalValue: totals.value }
      });
    }

    return byLocation.size;
  }

  /** Runs today's snapshot for every tenant. One failure must not stop the rest. */
  async runDailyBatch() {
    const clients = await this.getActiveTenants();
    const results = [];

    for (const clientId of clients) {
      try {
        const snapshot = await this.takeSnapshot(clientId);
        results.push({ clientId, success: true, id: snapshot.id });
      } catch (error) {
        console.error(`[SnapshotService] Failed for ${clientId}:`, error);
        results.push({ clientId, success: false, error: (error as Error).message });
      }
    }
    return results;
  }

  /**
   * Rebuilds historical snapshots by replaying the transaction ledger.
   *
   * Every stock movement passes through inventory-mutation.service, which writes an
   * InventoryTransaction carrying a signed quantity and the unit cost of a receipt. Replaying
   * those in order, applying the same weighted-average rule the live code uses, reproduces
   * each variant's quantity and average cost at any past moment -- so the totals are
   * reconstructed, not estimated.
   *
   * WHAT CANNOT BE RECONSTRUCTED, and is therefore left at zero rather than invented:
   *
   *   activeProducts  Product.status has no history. A product archived last week has always
   *                   been archived as far as the database is concerned.
   *   openPoValue     Purchase order status has no history either; a PO received yesterday
   *                   looks received for all of time.
   *   lowStockCount   Derivable from replayed quantities, but only against TODAY's reorder
   *                   levels, which are themselves not versioned. Counting yesterday's stock
   *                   against today's thresholds would be a different number pretending to be
   *                   a historical one.
   *
   * Leaving them at zero is visibly missing data. Filling them with today's value would be
   * indistinguishable from a real measurement, which is the mistake this replaces.
   *
   * Verification is not optional here: the replay is only trustworthy if replaying the whole
   * ledger lands on the state the database actually holds now. That comparison is returned,
   * and `apply` writes nothing when it fails.
   */
  async reconstructFromLedger(clientId: string, options: { apply?: boolean } = {}) {
    const { apply = false } = options;

    // Days are bucketed by the shop's calendar, so the reconstructed rows line up exactly
    // with the windows the day book counts movements over.
    const timezone = await this.getTimezone(clientId);

    const [transactions, variants] = await Promise.all([
      prisma.inventoryTransaction.findMany({
        where: { clientId },
        select: { variantId: true, locationId: true, quantity: true, unitCost: true, createdAt: true },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.productVariant.findMany({
        where: { clientId },
        select: {
          id: true, createdAt: true, averageCost: true,
          // locationId is needed so the replay can be checked location by location, not just
          // in total.
          stocks: { select: { quantity: true, locationId: true } }
        }
      })
    ]);

    if (transactions.length === 0) {
      return {
        clientId, days: 0, snapshots: [], applied: false,
        verification: { ok: true, reason: 'No ledger to replay.' }
      };
    }

    // Running state per variant, mirroring inventory-mutation.service: value is always
    // quantity x averageCost, and averageCost only moves on a receipt that carries a cost.
    const state = new Map<string, { qty: number; avgCost: number }>();

    // The same replay split by location. Average cost stays global -- an item is not worth
    // more because of which shelf it is on -- so only quantities are tracked per place, and
    // valued against the variant's cost at that moment.
    const locationState = new Map<string, Map<string, number>>(); // locationId -> variantId -> qty

    const snapshots: {
      snapshotDate: Date; totalValue: number; totalUnits: number; totalVariants: number;
      locations: { locationId: string; totalUnits: number; totalValue: number }[];
    }[] = [];

    // Days are the SHOP's days, not UTC ones -- see getTimezone. Day keys are compared as
    // "YYYY-MM-DD" strings, which sort correctly and sidestep the arithmetic traps of adding
    // 24 hours across a daylight-saving change.
    const totalsAt = (dayKey: string) => {
      let totalValue = 0;
      let totalUnits = 0;
      for (const [, s] of state) {
        totalUnits += s.qty;
        totalValue += s.qty * s.avgCost;
      }
      // Each row is the state at the END of its day -- every movement dated that day has
      // already been applied above. The variant count has to use the same boundary or it
      // contradicts the units beside it: counting against start-of-day reported 0 variants
      // on a day that closed holding 265 units, because the variants were created later that
      // same morning.
      const endOfDay = startOfLocalDay(SnapshotService.nextDayKey(dayKey), timezone);

      const locations = [...locationState.entries()].map(([locationId, held]) => {
        let units = 0, value = 0;
        for (const [variantId, qty] of held) {
          units += qty;
          value += qty * (state.get(variantId)?.avgCost || 0);
        }
        return { locationId, totalUnits: units, totalValue: Number(value.toFixed(2)) };
      });

      return {
        snapshotDate: startOfLocalDay(dayKey, timezone),
        totalValue: Number(totalValue.toFixed(2)),
        totalUnits,
        totalVariants: variants.filter(v => v.createdAt < endOfDay).length,
        locations
      };
    };

    let cursorKey = localDayKey(transactions[0].createdAt, timezone);
    const lastKey = todayKey(timezone);

    for (const tx of transactions) {
      const txKey = localDayKey(tx.createdAt, timezone);

      // Close off every day between the last transaction and this one. Days with no movement
      // still need a row, or the chart would join across gaps and imply a change that never
      // happened.
      while (cursorKey < txKey) {
        snapshots.push(totalsAt(cursorKey));
        cursorKey = SnapshotService.nextDayKey(cursorKey);
      }

      const current = state.get(tx.variantId) || { qty: 0, avgCost: 0 };
      const delta = tx.quantity;
      const newQty = current.qty + delta;

      if (delta > 0 && tx.unitCost != null) {
        // Same weighted average the live path applies. Guarded against a zero denominator,
        // which cannot occur for a positive delta but would be silent if it did.
        const incomingValue = delta * Number(tx.unitCost);
        const currentValue = current.qty * current.avgCost;
        current.avgCost = newQty > 0 ? (currentValue + incomingValue) / newQty : 0;
      }

      current.qty = newQty;
      state.set(tx.variantId, current);

      // Same movement, applied to the location it happened at.
      if (!locationState.has(tx.locationId)) locationState.set(tx.locationId, new Map());
      const held = locationState.get(tx.locationId)!;
      held.set(tx.variantId, (held.get(tx.variantId) || 0) + delta);
    }

    // Carry forward to today so the series ends where the dashboard does.
    while (cursorKey <= lastKey) {
      snapshots.push(totalsAt(cursorKey));
      cursorKey = SnapshotService.nextDayKey(cursorKey);
    }

    // ─── VERIFY AGAINST REALITY ───────────────────────────────────────────────
    const actualUnits = variants.reduce(
      (sum, v) => sum + v.stocks.reduce((s, st) => s + st.quantity, 0), 0
    );
    const actualValue = variants.reduce((sum, v) => {
      const qty = v.stocks.reduce((s, st) => s + st.quantity, 0);
      return sum + qty * Number(v.averageCost);
    }, 0);

    const replayedUnits = [...state.values()].reduce((s, v) => s + v.qty, 0);
    const replayedValue = [...state.values()].reduce((s, v) => s + v.qty * v.avgCost, 0);

    const unitsMatch = replayedUnits === actualUnits;
    // A cent or two of drift is expected: averageCost is stored rounded, so replaying in
    // full precision lands fractionally away from what was persisted at each step.
    const valueDrift = Math.abs(replayedValue - actualValue);
    const valueMatch = valueDrift < Math.max(1, actualValue * 0.001);

    // Locations are verified the same way as the company total. A per-location series that
    // drifts is worse than none: the company figure would still look right while the
    // breakdown underneath it quietly disagreed.
    const actualByLocation = new Map<string, number>();
    for (const v of variants) {
      for (const st of v.stocks) {
        actualByLocation.set(st.locationId, (actualByLocation.get(st.locationId) || 0) + st.quantity);
      }
    }
    const locationMismatches: string[] = [];
    for (const [locationId, held] of locationState) {
      const replayed = [...held.values()].reduce((a, b) => a + b, 0);
      const actual = actualByLocation.get(locationId) || 0;
      if (replayed !== actual) locationMismatches.push(`${locationId}: replayed ${replayed} vs actual ${actual}`);
    }

    const verification = {
      ok: unitsMatch && valueMatch && locationMismatches.length === 0,
      locationMismatches,
      replayedUnits, actualUnits,
      replayedValue: Number(replayedValue.toFixed(2)),
      actualValue: Number(actualValue.toFixed(2)),
      valueDrift: Number(valueDrift.toFixed(2)),
      reason: unitsMatch && valueMatch && locationMismatches.length === 0
        ? 'Replay reproduces the current state.'
        : locationMismatches.length && unitsMatch && valueMatch
          ? `Company totals match but ${locationMismatches.length} location(s) do not.`
        : !unitsMatch
          ? 'Replayed units do not match current stock -- the ledger is incomplete, so history cannot be trusted.'
          : 'Replayed value diverges beyond tolerance from current stock value.'
    };

    if (!apply || !verification.ok) {
      return { clientId, days: snapshots.length, snapshots, applied: false, verification };
    }

    for (const snap of snapshots) {
      await prisma.dailyInventorySnapshot.upsert({
        where: { clientId_snapshotDate: { clientId, snapshotDate: snap.snapshotDate } },
        // Today's row is owned by takeSnapshot, which measures rather than reconstructs;
        // updating is still correct because the replay should agree with it, and the
        // verification above is what establishes that.
        update: {
          totalValue: snap.totalValue,
          totalUnits: snap.totalUnits,
          totalVariants: snap.totalVariants
        },
        create: {
          clientId,
          snapshotDate: snap.snapshotDate,
          totalValue: snap.totalValue,
          totalUnits: snap.totalUnits,
          totalVariants: snap.totalVariants
          // activeProducts, lowStockCount, deadStockValue and openPoValue keep their zero
          // defaults -- see the note above on what history does not exist.
        }
      });

      for (const loc of snap.locations) {
        await prisma.dailyLocationSnapshot.upsert({
          where: { uq_location_snapshot_day: { locationId: loc.locationId, snapshotDate: snap.snapshotDate } },
          update: { totalUnits: loc.totalUnits, totalValue: loc.totalValue },
          create: {
            clientId, locationId: loc.locationId, snapshotDate: snap.snapshotDate,
            totalUnits: loc.totalUnits, totalValue: loc.totalValue
          }
        });
      }
    }

    return { clientId, days: snapshots.length, snapshots, applied: true, verification };
  }
}
