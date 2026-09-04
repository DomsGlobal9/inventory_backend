import { prisma } from '../lib/prisma';
import { ReportService } from './report.service';
import { ValuationService } from './valuation.service';

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

  private static startOfUtcDay(date: Date): Date {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Records today's state. This is measurement, not reconstruction -- it reads the live
   * figures the dashboard shows and stores them against today's date.
   */
  async takeSnapshot(clientId: string, date: Date = new Date()) {
    const summary = await this.reportService.getDashboardSummary(clientId);
    const valuation = await this.valuationService.getTenantValue(clientId);
    const snapshotDate = SnapshotService.startOfUtcDay(date);

    const values = {
      totalValue: summary.inventoryValue,
      totalUnits: valuation.totalUnits,
      totalVariants: valuation.totalVariants,
      activeProducts: summary.activeProducts,
      lowStockCount: summary.lowStockCount,
      deadStockValue: summary.deadStockValue,
      openPoValue: summary.openPoValue
    };

    return prisma.dailyInventorySnapshot.upsert({
      where: { clientId_snapshotDate: { clientId, snapshotDate } },
      update: values,
      create: { clientId, snapshotDate, ...values }
    });
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

    const [transactions, variants] = await Promise.all([
      prisma.inventoryTransaction.findMany({
        where: { clientId },
        select: { variantId: true, quantity: true, unitCost: true, createdAt: true },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.productVariant.findMany({
        where: { clientId },
        select: { id: true, createdAt: true, stocks: { select: { quantity: true } }, averageCost: true }
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

    const snapshots: {
      snapshotDate: Date; totalValue: number; totalUnits: number; totalVariants: number;
    }[] = [];

    const totalsAt = (date: Date) => {
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
      const endOfDay = new Date(date.getTime() + 86400000);
      return {
        snapshotDate: date,
        totalValue: Number(totalValue.toFixed(2)),
        totalUnits,
        totalVariants: variants.filter(v => v.createdAt < endOfDay).length
      };
    };

    let cursor = SnapshotService.startOfUtcDay(transactions[0].createdAt);
    const today = SnapshotService.startOfUtcDay(new Date());

    for (const tx of transactions) {
      const txDay = SnapshotService.startOfUtcDay(tx.createdAt);

      // Close off every day between the last transaction and this one. Days with no movement
      // still need a row, or the chart would join across gaps and imply a change that never
      // happened.
      while (cursor < txDay) {
        snapshots.push(totalsAt(new Date(cursor)));
        cursor = new Date(cursor.getTime() + 86400000);
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
    }

    // Carry forward to today so the series ends where the dashboard does.
    while (cursor <= today) {
      snapshots.push(totalsAt(new Date(cursor)));
      cursor = new Date(cursor.getTime() + 86400000);
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

    const verification = {
      ok: unitsMatch && valueMatch,
      replayedUnits, actualUnits,
      replayedValue: Number(replayedValue.toFixed(2)),
      actualValue: Number(actualValue.toFixed(2)),
      valueDrift: Number(valueDrift.toFixed(2)),
      reason: unitsMatch && valueMatch
        ? 'Replay reproduces the current state.'
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
    }

    return { clientId, days: snapshots.length, snapshots, applied: true, verification };
  }
}
