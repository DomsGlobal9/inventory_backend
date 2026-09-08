import { getShopSettings } from '../lib/clientSettings';
import { InventoryReason, SalesOrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  localDayRange, previousDayKey, isDayInProgress, todayKey, DEFAULT_TIMEZONE
} from '../utils/businessDay';
import { SnapshotService } from './snapshot.service';

/**
 * The day book: what happened on one business day, and whether the books balance.
 *
 * READ ONLY. Nothing here writes. A report that can alter stock is a report nobody should
 * trust, and this one is built to be trusted -- so every method only queries.
 *
 * The shape follows how a shop owner actually closes a day:
 *
 *   opening + everything in - everything out = closing
 *
 * That identity is checked and reported. If it ever fails the page says so rather than
 * showing a total that looks authoritative and is not.
 */

/** Human wording, because InventoryReason values are not for customers to read. */
const REASON_LABELS: Record<string, string> = {
  PURCHASE: 'Goods purchased',
  PURCHASE_RECEIPT: 'Purchase received',
  SUPPLIER_DELIVERY: 'Supplier delivery',
  CUSTOMER_RETURN: 'Customer returns',
  RETURN: 'Returned to stock',
  INITIAL_STOCK: 'Opening stock added',
  SALE: 'Sold and dispatched',
  DAMAGE: 'Damaged or written off',
  RETURN_TO_VENDOR: 'Sent back to supplier',
  SAMPLE: 'Given as samples',
  TRANSFER: 'Moved between locations',
  ADJUSTMENT: 'Stock corrections',
  MANUAL_ADJUSTMENT: 'Manual corrections',
  AUDIT: 'Stock count corrections',
  AUDIT_CORRECTION: 'Stock count corrections',
  MANUAL_CORRECTION: 'Manual corrections'
};

const label = (reason: string) => REASON_LABELS[reason] || reason.replace(/_/g, ' ').toLowerCase();

export interface DayBookLine {
  reason: string;
  label: string;
  units: number;
  value: number;
}

export class DayBookService {
  // Shares the snapshot engine's arithmetic for "what did a day close at", so the two cannot
  // give different answers for the same day.
  private snapshots = new SnapshotService();

  /**
   * The shop's own settings. Timezone defaults to India so no tenant needs setting up before
   * the day book works; the business name is optional and only used for printed output, which
   * falls back to the account name when it is not set.
   */
  /**
   * The shop's timezone and name, cached briefly.
   *
   * Read on almost every report, every day-boundary calculation and every snapshot, and it is
   * the same two values every time -- a shop's timezone changes approximately never. Against a
   * database on another continent each of those reads costs about a second, so the day book
   * alone was paying two seconds to look up a string it had already looked up.
   *
   * A minute of staleness, and no invalidation to keep in step with anything: the worst case
   * is that a timezone change takes up to a minute to apply, which nobody will notice, and the
   * alternative -- hooks in every place settings can be written -- is a bug waiting to happen.
   */
  async getShop(clientId: string): Promise<{ timezone: string; businessName: string | null }> {
    const { timezone, businessName } = await getShopSettings(clientId);
    return { timezone, businessName };
  }

  /** Kept for the callers that only need the timezone. */
  async getTimezone(clientId: string): Promise<string> {
    return (await this.getShop(clientId)).timezone;
  }

  /**
   * Opening stock for a day: the previous day's closing, derived from the ledger.
   *
   * This used to read the stored snapshot for the previous day, which is faster but goes
   * stale. A movement recorded INTO a day that has already been snapshotted -- yesterday's
   * delivery entered this morning, a correction to last week, an import carrying its own
   * dates -- leaves that row describing a day that no longer happened, and nothing ever
   * recomputed it. Today's opening was then wrong, permanently, and since closing is
   * opening + in - out, so was every figure built on it.
   *
   * Deriving it from the ledger cannot drift: the ledger is what actually happened, and a
   * backdated entry is included the moment it is written. It costs no extra round trip in
   * practice -- the snapshot read was one query, this is one batch of parallel ones -- and it
   * is the same arithmetic closingForDay uses, so the day book and the snapshot table cannot
   * disagree about what a day closed at.
   *
   * The snapshots remain the durable record for trends and history, and the hourly job keeps
   * them true; they are simply no longer what the balance line leans on.
   */
  private async getOpening(clientId: string, dayKey: string, dayStart: Date, locationId?: string) {
    const previous = previousDayKey(dayKey);
    const closing = await this.snapshots.closingForDay(clientId, previous);

    if (locationId) {
      const forLocation = closing.byLocation.get(locationId);
      // A location with no entry held nothing that day -- it did not exist yet, or was empty.
      return {
        units: forLocation?.units ?? 0,
        value: Number((forLocation?.value ?? 0).toFixed(2)),
        source: 'derived' as const,
        asOf: dayStart
      };
    }

    return {
      units: closing.units,
      // Exact in units. Value uses each variant's average cost as it stands today, because
      // cost history is not stored -- an approximation, and labelled as one.
      value: Number(closing.value.toFixed(2)),
      source: 'derived' as const,
      asOf: dayStart
    };
  }

  /**
   * The day's closing stock, taken from somewhere other than the day's own arithmetic.
   *
   * This is what makes the balance check real. A finished day has a snapshot recorded at the
   * time; today has no snapshot yet, so the stock actually on the shelves is used instead.
   * Either way the number arrives independently of opening + in - out, which is the only way
   * a disagreement can ever surface.
   *
   * Returns null when neither source exists -- a day too old to have a snapshot -- in which
   * case the page shows no claim rather than a false one.
   */
  private async getMeasuredClosing(
    clientId: string, dayKey: string, dayStart: Date, dayEnd: Date,
    inProgress: boolean, locationId?: string
  ): Promise<number | null> {
    if (inProgress) {
      const stocks = await prisma.inventoryStock.aggregate({
        where: { clientId, ...(locationId ? { locationId } : {}) },
        _sum: { quantity: true }
      });
      return stocks._sum.quantity ?? 0;
    }

    if (locationId) {
      const snap = await prisma.dailyLocationSnapshot.findFirst({
        where: { clientId, locationId, snapshotDate: { gte: dayStart, lt: dayEnd } },
        select: { totalUnits: true }
      });
      return snap ? snap.totalUnits : null;
    }

    const snap = await prisma.dailyInventorySnapshot.findFirst({
      where: { clientId, snapshotDate: { gte: dayStart, lt: dayEnd } },
      select: { totalUnits: true }
    });
    return snap ? snap.totalUnits : null;
  }

  /**
   * Everything that happened on one business day.
   *
   * @param dayKey "YYYY-MM-DD" in the SHOP's timezone, not UTC.
   */
  async getDay(clientId: string, dayKey: string, locationId?: string) {
    const { timezone, businessName } = await this.getShop(clientId);
    const { start, end } = localDayRange(dayKey, timezone);
    const inProgress = isDayInProgress(dayKey, timezone);

    const movementWhere = {
      clientId,
      createdAt: { gte: start, lt: end },
      ...(locationId ? { locationId } : {})
    };

    // opening and measuredClosing depend only on the day window, not on the movements, so they
    // are issued with the rest rather than after them. Each round trip to the database costs
    // roughly 1.4s from the app's region, so a stage that waits for no reason is 1.4s the
    // report takes to load for nothing.
    const [
      movements, locations, dispatches, posRaised, posReceived, newVariants,
      opening, measured
    ] = await Promise.all([
      prisma.inventoryTransaction.findMany({
        where: movementWhere,
        select: {
          quantity: true, unitCost: true, reason: true, locationId: true,
          sku: true, productTitle: true, variantId: true, createdBy: true, createdAt: true
        }
      }),
      prisma.stockLocation.findMany({
        where: { clientId, ...(locationId ? { id: locationId } : {}) },
        select: { id: true, name: true, code: true }
      }),
      // Sales are counted when goods actually LEAVE, not when the order is written -- an
      // order taken today and shipped next week is next week's revenue in stock terms.
      // Filtered on dispatchedAt, not createdAt: a dispatch record can be prepared in advance
      // and only becomes a sale at the moment it goes out the door.
      prisma.dispatch.findMany({
        where: { clientId, dispatchedAt: { gte: start, lt: end } },
        select: {
          id: true,
          dispatchNumber: true,
          salesOrder: {
            select: { orderNumber: true, status: true, customer: { select: { name: true } } }
          },
          // Priced per line rather than from the order total. One order can be dispatched in
          // several parts, so charging the whole order total against each dispatch would count
          // the same revenue twice -- and a part-shipment would be reported as a full sale.
          items: {
            select: {
              quantity: true,
              salesOrderItem: { select: { unitPrice: true, variantId: true } }
            }
          }
        }
      }),
      prisma.purchaseOrder.count({ where: { clientId, createdAt: { gte: start, lt: end } } }),
      prisma.purchaseOrder.count({ where: { clientId, receivedAt: { gte: start, lt: end } } }),
      prisma.productVariant.count({ where: { clientId, createdAt: { gte: start, lt: end } } }),
      this.getOpening(clientId, dayKey, start, locationId),
      this.getMeasuredClosing(clientId, dayKey, start, end, inProgress, locationId)
    ]);

    // ─── IN / OUT, GROUPED BY REASON ──────────────────────────────────────────
    const inbound = new Map<string, DayBookLine>();
    const outbound = new Map<string, DayBookLine>();
    let transferUnits = 0;

    for (const m of movements) {
      const units = m.quantity;
      const value = Math.abs(units) * Number(m.unitCost || 0);

      // A transfer is the same stock in two places at once: it leaves one location and
      // arrives at another.
      //
      // Company-wide it nets to zero, so counting it as a purchase and a sale would inflate
      // both sides of the day for stock that never entered or left the business. Only the
      // outbound leg is tallied for the "moved" figure -- a transfer writes TWO rows, so
      // summing both reported 50 moved units as "100 units moved".
      //
      // For ONE location it is the opposite: the stock really did arrive or leave, and
      // excluding it made the balance nonsense -- a shop that received 50 in a transfer and
      // sold 2 reported a closing of minus 2. So when a location is selected the legs are
      // counted as ordinary movement, under their own label.
      if (m.reason === InventoryReason.TRANSFER) {
        if (units < 0) transferUnits += Math.abs(units);
        if (!locationId) continue;
      }

      const bucket = units > 0 ? inbound : outbound;
      const key = m.reason;
      const lineLabel = m.reason === InventoryReason.TRANSFER
        ? (units > 0 ? 'Moved in from another location' : 'Moved out to another location')
        : label(key);
      const line = bucket.get(key) || { reason: key, label: lineLabel, units: 0, value: 0 };
      line.units += Math.abs(units);
      line.value += value;
      bucket.set(key, line);
    }

    const round = (n: number) => Number(n.toFixed(2));
    const inLines = [...inbound.values()].map(l => ({ ...l, value: round(l.value) }))
      .sort((a, b) => b.units - a.units);
    const outLines = [...outbound.values()].map(l => ({ ...l, value: round(l.value) }))
      .sort((a, b) => b.units - a.units);

    const totalIn = inLines.reduce((s, l) => s + l.units, 0);
    const totalOut = outLines.reduce((s, l) => s + l.units, 0);
    const totalInValue = round(inLines.reduce((s, l) => s + l.value, 0));
    const totalOutValue = round(outLines.reduce((s, l) => s + l.value, 0));

    // ─── OPENING AND CLOSING ──────────────────────────────────────────────────
    // Both views balance now: company-wide from DailyInventorySnapshot, a single location
    // from DailyLocationSnapshot.

    // Closing is CALCULATED from the day's movements.
    const closing = opening
      ? { units: opening.units + totalIn - totalOut, value: round(opening.value + totalInValue - totalOutValue) }
      : null;

    // ...and then checked against something that did not come from that calculation.
    //
    // The check used to compare `opening + in - out` with `closing`, which is how closing was
    // produced in the first place -- so it could never fail, and reported "the books balance"
    // no matter how wrong the figures were. A check has to have an independent source or it
    // is decoration.
    //
    // For a finished day that source is the day's own snapshot, measured at the time. For
    // today, which has no closing snapshot yet, it is the stock physically on the shelves.

    const balanced = closing && measured !== null ? closing.units === measured : null;

    // ─── SALES, MEASURED AT DISPATCH ──────────────────────────────────────────
    const soldLine = outLines.find(l => l.reason === InventoryReason.SALE);

    const countable = dispatches.filter(d => d.salesOrder?.status !== SalesOrderStatus.CANCELLED);

    const dispatchedUnits = countable.reduce(
      (s, d) => s + d.items.reduce((a, i) => a + (i.quantity || 0), 0), 0
    );

    // Revenue for exactly what left the building: dispatched quantity x that line's agreed
    // price. Cancelled orders contribute nothing.
    const revenue = round(countable.reduce(
      (s, d) => s + d.items.reduce(
        (a, i) => a + (i.quantity || 0) * Number(i.salesOrderItem?.unitPrice || 0), 0
      ), 0
    ));

    // What those goods cost, taken from the stock movements rather than the order, so profit
    // compares like with like.
    const costOfGoods = soldLine?.value || 0;

    // ─── PER LOCATION ─────────────────────────────────────────────────────────
    const byLocation = locations.map(loc => {
      const own = movements.filter(m => m.locationId === loc.id);
      const inUnits = own.filter(m => m.quantity > 0).reduce((s, m) => s + m.quantity, 0);
      const outUnits = own.filter(m => m.quantity < 0).reduce((s, m) => s + Math.abs(m.quantity), 0);
      const transferIn = own.filter(m => m.reason === InventoryReason.TRANSFER && m.quantity > 0)
        .reduce((s, m) => s + m.quantity, 0);
      const transferOut = own.filter(m => m.reason === InventoryReason.TRANSFER && m.quantity < 0)
        .reduce((s, m) => s + Math.abs(m.quantity), 0);

      return {
        locationId: loc.id, name: loc.name, code: loc.code,
        unitsIn: inUnits, unitsOut: outUnits, netChange: inUnits - outUnits,
        transferIn, transferOut,
        movementCount: own.length
      };
    }).filter(l => l.movementCount > 0 || !locationId);

    // ─── TOP MOVERS ───────────────────────────────────────────────────────────
    const moverMap = new Map<string, { sku: string; title: string; unitsOut: number; unitsIn: number }>();
    for (const m of movements) {
      if (m.reason === InventoryReason.TRANSFER) continue;
      const key = m.variantId;
      const e = moverMap.get(key) || { sku: m.sku || '', title: m.productTitle || '', unitsOut: 0, unitsIn: 0 };
      if (m.quantity < 0) e.unitsOut += Math.abs(m.quantity); else e.unitsIn += m.quantity;
      moverMap.set(key, e);
    }
    // sku and productTitle are denormalised onto the transaction at write time, and not every
    // write path fills the title in -- rows exist with a SKU and no title, which showed up as a
    // dash where the product name should be, on the page and in the printed report. The names
    // are looked up once from the variants involved, so rows already written read correctly
    // rather than only ones written after the write path is corrected.
    const needTitle = [...new Set(
      movements.filter(m => !m.productTitle).map(m => m.variantId)
    )];
    const titleByVariant = new Map<string, { title: string; sku: string }>();
    if (needTitle.length) {
      const variants = await prisma.productVariant.findMany({
        where: { id: { in: needTitle }, clientId },
        select: { id: true, sku: true, product: { select: { title: true } } }
      });
      for (const v of variants) {
        titleByVariant.set(v.id, { title: v.product?.title || '', sku: v.sku || '' });
      }
    }
    for (const [variantId, e] of moverMap) {
      const found = titleByVariant.get(variantId);
      if (!found) continue;
      if (!e.title) e.title = found.title;
      if (!e.sku) e.sku = found.sku;
    }

    const topMovers = [...moverMap.values()]
      .sort((a, b) => (b.unitsOut + b.unitsIn) - (a.unitsOut + a.unitsIn))
      .slice(0, 5);

    // ─── CORRECTIONS, WITH WHO MADE THEM ──────────────────────────────────────
    // Manual changes are the ones worth a name against them: everything else follows from a
    // document, but a correction is somebody's decision.
    const adjustmentReasons = new Set<string>([
      InventoryReason.ADJUSTMENT, InventoryReason.MANUAL_ADJUSTMENT,
      InventoryReason.MANUAL_CORRECTION, InventoryReason.AUDIT_CORRECTION, InventoryReason.AUDIT
    ]);
    const adjustments = movements
      .filter(m => adjustmentReasons.has(m.reason))
      .map(m => ({
        sku: m.sku || titleByVariant.get(m.variantId)?.sku || null,
        title: m.productTitle || titleByVariant.get(m.variantId)?.title || null,
        units: m.quantity,
        reason: label(m.reason), by: m.createdBy, at: m.createdAt
      }));

    return {
      date: dayKey,
      timezone,
      // Printed reports carry the shop's name in the header; the page ignores it.
      businessName,
      inProgress,
      quiet: movements.length === 0 && dispatches.length === 0,

      opening,
      closing,
      // What the independent source says, so a mismatch can be shown rather than just flagged.
      measuredClosing: measured,
      balanced,

      stockIn: { lines: inLines, totalUnits: totalIn, totalValue: totalInValue },
      stockOut: { lines: outLines, totalUnits: totalOut, totalValue: totalOutValue },

      transfers: { unitsMoved: transferUnits },

      sales: {
        dispatchCount: countable.length,
        unitsDispatched: dispatchedUnits,
        revenue,
        costOfGoods,
        grossProfit: round(revenue - costOfGoods),
        orders: countable
          .filter(d => d.salesOrder)
          .map(d => ({
            dispatchNumber: d.dispatchNumber,
            orderNumber: d.salesOrder!.orderNumber,
            customer: d.salesOrder!.customer?.name || null,
            units: d.items.reduce((a, i) => a + (i.quantity || 0), 0),
            // This dispatch's own value, not the parent order's.
            value: round(d.items.reduce(
              (a, i) => a + (i.quantity || 0) * Number(i.salesOrderItem?.unitPrice || 0), 0
            )),
            status: d.salesOrder!.status
          }))
      },

      byLocation,
      topMovers,
      adjustments,

      alsoToday: {
        purchaseOrdersRaised: posRaised,
        purchaseOrdersReceived: posReceived,
        newVariantsAdded: newVariants
      }
    };
  }

  /** Convenience for "today" in the shop's own timezone. */
  async getToday(clientId: string, locationId?: string) {
    const timezone = await this.getTimezone(clientId);
    return this.getDay(clientId, todayKey(timezone), locationId);
  }

  /** Yesterday -- what an evening or morning summary would send. */
  async getYesterday(clientId: string) {
    const timezone = await this.getTimezone(clientId);
    return this.getDay(clientId, previousDayKey(todayKey(timezone)));
  }
}

export const dayBookService = new DayBookService();
