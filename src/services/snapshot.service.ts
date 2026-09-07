import { prisma } from '../lib/prisma';
import { ReportService } from './report.service';
import { ValuationService } from './valuation.service';
import {
  localDayKey, startOfLocalDay, localDayKeyFromParts, todayKey, previousDayKey, DEFAULT_TIMEZONE
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
   * The closing state at the end of a business day, worked back from live stock.
   *
   *     closing(D) = what is on the shelves now  -  everything that moved after D ended
   *
   * Done per variant, so units are exact at both company and location level. Value uses each
   * variant's average cost as it stands today, because cost history is not stored -- the same
   * caveat the day book already carries, stated rather than hidden. Per-variant rather than
   * scaling one total keeps the approximation confined to cost drift on each item.
   *
   * Deriving it this way rather than reading live stock at midnight is the point: the answer
   * does not depend on WHEN this runs. A tick at 00:05, or at 09:00 the next morning after
   * the host slept all night, both produce the same figure for that day. Reading live stock
   * only gives a day's closing if the job happens to fire in the last moments before
   * midnight, and silently gives a partial day if it does not.
   */
  async closingForDay(clientId: string, dayKey: string) {
    const timezone = await this.getTimezone(clientId);
    const dayEnd = startOfLocalDay(SnapshotService.nextDayKey(dayKey), timezone);
    const after = { clientId, createdAt: { gte: dayEnd } };

    const [stocks, afterByVariant, afterByVariantLocation, locations] = await Promise.all([
      prisma.inventoryStock.findMany({
        where: { clientId },
        select: {
          variantId: true, locationId: true, quantity: true,
          variant: { select: { averageCost: true } }
        }
      }),
      prisma.inventoryTransaction.groupBy({
        by: ['variantId'], where: after, _sum: { quantity: true }
      }),
      prisma.inventoryTransaction.groupBy({
        by: ['variantId', 'locationId'], where: after, _sum: { quantity: true }
      }),
      prisma.stockLocation.findMany({ where: { clientId }, select: { id: true } })
    ]);

    const costOf = new Map<string, number>();
    const liveByVariant = new Map<string, number>();
    const liveByVariantLocation = new Map<string, number>();
    for (const row of stocks) {
      costOf.set(row.variantId, Number(row.variant?.averageCost || 0));
      liveByVariant.set(row.variantId, (liveByVariant.get(row.variantId) || 0) + row.quantity);
      const k = `${row.variantId}|${row.locationId}`;
      liveByVariantLocation.set(k, (liveByVariantLocation.get(k) || 0) + row.quantity);
    }

    // Company-wide: undo, per variant, everything that moved after the day ended.
    let units = 0, value = 0;
    const variantIds = new Set<string>([
      ...liveByVariant.keys(),
      ...afterByVariant.map(g => g.variantId)
    ]);
    for (const variantId of variantIds) {
      const movedAfter = afterByVariant.find(g => g.variantId === variantId);
      const qty = (liveByVariant.get(variantId) || 0) - Number(movedAfter?._sum.quantity || 0);
      units += qty;
      value += qty * (costOf.get(variantId) || 0);
    }

    // Per location, the same subtraction against that location's own movements. A location
    // that has since emptied still gets a row, or its previous snapshot stands as its most
    // recent reading and it reads as still full.
    const byLocation = new Map<string, { units: number; value: number }>();
    for (const loc of locations) byLocation.set(loc.id, { units: 0, value: 0 });

    const pairs = new Set<string>([
      ...liveByVariantLocation.keys(),
      ...afterByVariantLocation.filter(g => g.locationId).map(g => `${g.variantId}|${g.locationId}`)
    ]);
    for (const key of pairs) {
      const [variantId, locationId] = key.split('|');
      const movedAfter = afterByVariantLocation.find(
        g => g.variantId === variantId && g.locationId === locationId
      );
      const qty = (liveByVariantLocation.get(key) || 0) - Number(movedAfter?._sum.quantity || 0);
      const acc = byLocation.get(locationId) || { units: 0, value: 0 };
      acc.units += qty;
      acc.value += qty * (costOf.get(variantId) || 0);
      byLocation.set(locationId, acc);
    }

    return { units, value, byLocation };
  }

  /**
   * Writes the closing snapshot for a day that has FINISHED.
   *
   * A snapshot dated D means "this is how day D ended". Writing one for the day in progress
   * would file a half-finished number under a label that reads as final -- and the day book
   * takes the previous day's snapshot as today's opening balance, so a partial figure there
   * becomes a wrong opening tomorrow and the books stop balancing.
   *
   * Today therefore has no row, deliberately. The day book shows live figures for it and
   * says the day is still running.
   */
  async snapshotDay(clientId: string, dayKey: string) {
    const timezone = await this.getTimezone(clientId);
    if (dayKey >= todayKey(timezone)) {
      throw new Error(`${dayKey} has not finished in ${timezone}; a snapshot would be a partial day`);
    }

    const snapshotDate = startOfLocalDay(dayKey, timezone);

    // Product status, purchase-order status and reorder levels are not versioned, so for any
    // day older than the one just gone there is no honest way to state them. They are left at
    // zero -- visibly missing -- rather than filled with today's value, which would be
    // indistinguishable from a real measurement. For the day that just closed, today's values
    // are still the truth, so they are recorded.
    const justClosed = dayKey === previousDayKey(todayKey(timezone));

    // None of these depend on each other, and a round trip here costs over a second.
    const [closing, variantCount, live] = await Promise.all([
      this.closingForDay(clientId, dayKey),
      prisma.productVariant.count({ where: { clientId } }),
      justClosed ? this.reportService.getDashboardSummary(clientId) : Promise.resolve(null)
    ]);

    const values = {
      totalValue: closing.value,
      totalUnits: closing.units,
      totalVariants: variantCount,
      activeProducts: live?.activeProducts ?? 0,
      lowStockCount: live?.lowStockCount ?? 0,
      deadStockValue: live?.deadStockValue ?? 0,
      openPoValue: live?.openPoValue ?? 0
    };

    const snapshot = await prisma.dailyInventorySnapshot.upsert({
      where: { clientId_snapshotDate: { clientId, snapshotDate } },
      update: values,
      create: { clientId, snapshotDate, ...values }
    });

    // Together rather than one at a time: they are independent rows, and each round trip to
    // the database costs over a second from the app's region, so a shop with five locations
    // was paying five seconds a day for writes that could all be in flight at once.
    await Promise.all([...closing.byLocation].map(([locationId, totals]) =>
      prisma.dailyLocationSnapshot.upsert({
        where: { uq_location_snapshot_day: { locationId, snapshotDate } },
        update: { totalUnits: totals.units, totalValue: totals.value },
        create: { clientId, locationId, snapshotDate, totalUnits: totals.units, totalValue: totals.value }
      })
    ));

    return snapshot;
  }

  /**
   * Fills in every finished day this tenant has no snapshot for.
   *
   * This is what lets the engine survive a host that sleeps. Nothing has to happen at
   * midnight: each day's closing is derived from the ledger, so a run at any later hour
   * writes exactly the same rows. A machine that was off for three days catches all three up
   * the next time it wakes.
   *
   * @param maxDays how far back one pass reaches, so a tenant with a long untouched history
   *                cannot make a single tick run for minutes.
   */
  async catchUpTenant(clientId: string, maxDays = 14) {
    const timezone = await this.getTimezone(clientId);
    const yesterday = previousDayKey(todayKey(timezone));

    const latest = await prisma.dailyInventorySnapshot.findFirst({
      where: { clientId },
      orderBy: { snapshotDate: 'desc' },
      select: { snapshotDate: true }
    });

    // Resume the morning after the last snapshot. With none, start at the first movement, so
    // a tenant's recorded history begins where its trading did.
    let cursor: string;
    if (latest) {
      cursor = SnapshotService.nextDayKey(localDayKey(latest.snapshotDate, timezone));
    } else {
      const first = await prisma.inventoryTransaction.findFirst({
        where: { clientId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true }
      });
      if (!first) return { clientId, written: [] as string[] };
      cursor = localDayKey(first.createdAt, timezone);
    }

    const written: string[] = [];
    while (cursor <= yesterday && written.length < maxDays) {
      await this.snapshotDay(clientId, cursor);
      written.push(cursor);
      cursor = SnapshotService.nextDayKey(cursor);
    }
    return { clientId, written };
  }

  /**
   * Catches every tenant up. One tenant failing must not stop the others: they are unrelated
   * businesses, and a bad row in one is no reason to leave the rest unrecorded.
   */
  async catchUpAll() {
    const clients = await this.getActiveTenants();
    const results = [];

    for (const clientId of clients) {
      try {
        const r = await this.catchUpTenant(clientId);
        results.push({ clientId, success: true, written: r.written });
      } catch (error) {
        console.error(`[SnapshotService] Catch-up failed for ${clientId}:`, error);
        results.push({ clientId, success: false, error: (error as Error).message, written: [] as string[] });
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
