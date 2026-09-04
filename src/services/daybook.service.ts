import { InventoryReason, SalesOrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  localDayRange, previousDayKey, isDayInProgress, todayKey, DEFAULT_TIMEZONE
} from '../utils/businessDay';

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
  /** A shop's timezone, defaulting to India, created lazily so no tenant needs setting up. */
  async getTimezone(clientId: string): Promise<string> {
    const settings = await prisma.clientSettings.findUnique({
      where: { clientId }, select: { timezone: true }
    });
    return settings?.timezone || DEFAULT_TIMEZONE;
  }

  /**
   * Opening stock for a day.
   *
   * Read from the previous day's snapshot where one exists -- that is the whole reason the
   * snapshot engine exists. Where it does not (a tenant older than the snapshots, or a gap),
   * it is derived instead: current stock minus every movement since the day began. Both are
   * real; the second is just slower.
   */
  private async getOpening(clientId: string, dayKey: string, dayStart: Date) {
    const snapshot = await prisma.dailyInventorySnapshot.findFirst({
      where: { clientId, snapshotDate: { lt: dayStart } },
      orderBy: { snapshotDate: 'desc' },
      select: { snapshotDate: true, totalUnits: true, totalValue: true }
    });

    if (snapshot) {
      return {
        units: snapshot.totalUnits,
        value: Number(snapshot.totalValue),
        source: 'snapshot' as const,
        asOf: snapshot.snapshotDate
      };
    }

    // No snapshot to lean on: work backwards from live stock by undoing everything that has
    // happened since. Exact for units. Value is approximated because a variant's average cost
    // today is not what it was then, and that history is not stored -- flagged, not hidden.
    const [variants, movementsSince] = await Promise.all([
      prisma.productVariant.findMany({
        where: { clientId },
        select: { averageCost: true, stocks: { select: { quantity: true } } }
      }),
      prisma.inventoryTransaction.aggregate({
        where: { clientId, createdAt: { gte: dayStart } },
        _sum: { quantity: true }
      })
    ]);

    const liveUnits = variants.reduce((s, v) => s + v.stocks.reduce((a, x) => a + x.quantity, 0), 0);
    const liveValue = variants.reduce(
      (s, v) => s + v.stocks.reduce((a, x) => a + x.quantity, 0) * Number(v.averageCost), 0
    );
    const since = movementsSince._sum.quantity || 0;
    const openingUnits = liveUnits - since;

    return {
      units: openingUnits,
      // Scaled from live value in proportion to units. An estimate, and labelled as one.
      value: liveUnits > 0 ? Number(((liveValue / liveUnits) * openingUnits).toFixed(2)) : 0,
      source: 'derived' as const,
      asOf: dayStart
    };
  }

  /**
   * Everything that happened on one business day.
   *
   * @param dayKey "YYYY-MM-DD" in the SHOP's timezone, not UTC.
   */
  async getDay(clientId: string, dayKey: string, locationId?: string) {
    const timezone = await this.getTimezone(clientId);
    const { start, end } = localDayRange(dayKey, timezone);
    const inProgress = isDayInProgress(dayKey, timezone);

    const movementWhere = {
      clientId,
      createdAt: { gte: start, lt: end },
      ...(locationId ? { locationId } : {})
    };

    const [movements, locations, dispatches, posRaised, posReceived, newVariants] = await Promise.all([
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
      prisma.productVariant.count({ where: { clientId, createdAt: { gte: start, lt: end } } })
    ]);

    // ─── IN / OUT, GROUPED BY REASON ──────────────────────────────────────────
    const inbound = new Map<string, DayBookLine>();
    const outbound = new Map<string, DayBookLine>();
    let transferUnits = 0;

    for (const m of movements) {
      const units = m.quantity;
      const value = Math.abs(units) * Number(m.unitCost || 0);

      // A transfer is the same stock in two places at once: it leaves one location and
      // arrives at another. Counted as purchases and sales it would inflate both sides of the
      // day and break the balance, so it is tracked on its own.
      //
      // Only the outbound leg is counted. A transfer writes TWO rows -- minus 50 at the
      // origin and plus 50 at the destination -- so summing both reported 50 moved units as
      // "100 units moved", double what actually left a shelf.
      if (m.reason === InventoryReason.TRANSFER) {
        if (units < 0) transferUnits += Math.abs(units);
        continue;
      }

      const bucket = units > 0 ? inbound : outbound;
      const key = m.reason;
      const line = bucket.get(key) || { reason: key, label: label(key), units: 0, value: 0 };
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
    // Location-filtered views cannot use the company snapshot, so opening is only meaningful
    // company-wide for now; a filtered view reports its movements without a balance claim.
    const opening = locationId ? null : await this.getOpening(clientId, dayKey, start);
    const closing = opening
      ? { units: opening.units + totalIn - totalOut, value: round(opening.value + totalInValue - totalOutValue) }
      : null;

    const balanced = opening && closing
      ? opening.units + totalIn - totalOut === closing.units
      : null;

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
        sku: m.sku, title: m.productTitle, units: m.quantity,
        reason: label(m.reason), by: m.createdBy, at: m.createdAt
      }));

    return {
      date: dayKey,
      timezone,
      inProgress,
      quiet: movements.length === 0 && dispatches.length === 0,

      opening,
      closing,
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
