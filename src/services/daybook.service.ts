import { getShopSettings } from '../lib/clientSettings';
import { InventoryReason, SalesOrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  localDayRange, localDayKey, localDayKeyFromParts, previousDayKey, isDayInProgress, todayKey, DEFAULT_TIMEZONE
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

/** The longest range one book may cover. A month is what an accountant asks for. */
export const MAX_RANGE_DAYS = 31;

/** Every day key from the first to the last, both included; stops after `limit` keys. */
export function dayKeysBetween(fromKey: string, toKey: string, limit: number): string[] {
  const keys: string[] = [];
  const [y, m, d] = fromKey.split('-').map(Number);
  for (let i = 0; i < limit; i++) {
    const k = localDayKeyFromParts(y, m, d, i);
    if (k > toKey) break;
    keys.push(k);
  }
  return keys;
}

export interface DayBookDayRow {
  date: string;
  unitsIn: number;
  unitsOut: number;
  /** Null when the opening count is unknown. */
  closingUnits: number | null;
  dispatchCount: number;
  unitsDispatched: number;
  revenue: number;
  costOfGoods: number;
  grossProfit: number;
}

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
  ): Promise<{ units: number; value: number | null } | null> {
    if (inProgress) {
      // Today has no snapshot, so the shelves themselves are the independent record. Value is
      // summed per variant because it is quantity x that variant's average cost, which no
      // single aggregate can express.
      const variants = await prisma.productVariant.findMany({
        where: { product: { clientId } },
        select: { averageCost: true, stocks: { select: { locationId: true, quantity: true } } }
      });
      let units = 0;
      let value = 0;
      for (const v of variants) {
        for (const st of v.stocks) {
          if (locationId && st.locationId !== locationId) continue;
          units += st.quantity;
          value += st.quantity * Number(v.averageCost);
        }
      }
      return { units, value: Number(value.toFixed(2)) };
    }

    if (locationId) {
      const snap = await prisma.dailyLocationSnapshot.findFirst({
        where: { clientId, locationId, snapshotDate: { gte: dayStart, lt: dayEnd } },
        select: { totalUnits: true, totalValue: true }
      });
      return snap ? { units: snap.totalUnits, value: Number(snap.totalValue) } : null;
    }

    const snap = await prisma.dailyInventorySnapshot.findFirst({
      where: { clientId, snapshotDate: { gte: dayStart, lt: dayEnd } },
      select: { totalUnits: true, totalValue: true }
    });
    return snap ? { units: snap.totalUnits, value: Number(snap.totalValue) } : null;
  }

  /**
   * Everything that happened on one business day.
   *
   * @param dayKey "YYYY-MM-DD" in the SHOP's timezone, not UTC.
   */
  async getDay(clientId: string, dayKey: string, locationId?: string) {
    return this.build(clientId, dayKey, dayKey, locationId);
  }

  /**
   * The same book over several days: opening on the first morning, closing on the last night,
   * everything between added up, and one row per day.
   *
   * It is the SAME arithmetic as one day over a longer window, not a sum of daily reports, so a
   * range and its days cannot disagree: the opening of the range is the opening of its first
   * day and its closing is the closing of its last day, by construction.
   */
  async getRange(clientId: string, fromKey: string, toKey: string, locationId?: string) {
    if (fromKey > toKey) throw Object.assign(new Error('The first day must not be after the last day.'), { statusCode: 400 });
    const timezone = await this.getTimezone(clientId);
    if (toKey > todayKey(timezone)) throw Object.assign(new Error('The last day cannot be after today.'), { statusCode: 400 });
    if (dayKeysBetween(fromKey, toKey, MAX_RANGE_DAYS + 1).length > MAX_RANGE_DAYS) {
      throw Object.assign(new Error(`Choose ${MAX_RANGE_DAYS} days or fewer.`), { statusCode: 400 });
    }
    return this.build(clientId, fromKey, toKey, locationId);
  }

  private async build(clientId: string, fromKey: string, toKey: string, locationId?: string) {
    const { timezone, businessName } = await this.getShop(clientId);
    const { start } = localDayRange(fromKey, timezone);
    const { start: lastDayStart, end } = localDayRange(toKey, timezone);
    const inProgress = isDayInProgress(toKey, timezone);
    const isRange = fromKey !== toKey;
    const dayKey = toKey;

    const movementWhere = {
      clientId,
      createdAt: { gte: start, lt: end },
      // A move between shelves is a ledger row with quantity 0: nothing came in or went out that day.
      reason: { not: 'SHELF_MOVE' as const },
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
          dispatchedAt: true,
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
      this.getOpening(clientId, fromKey, start, locationId),
      this.getMeasuredClosing(clientId, toKey, lastDayStart, end, inProgress, locationId)
    ]);

    // ─── IN / OUT, GROUPED BY REASON ──────────────────────────────────────────
    const inbound = new Map<string, DayBookLine>();
    const outbound = new Map<string, DayBookLine>();
    let transferUnits = 0;
    // Units sold whose movement carried no cost, because none was ever recorded for that
    // stock. They contribute nothing to cost of goods, so the profit below counts their whole
    // selling price as profit. That is not a wrong sum, it is an undisclosed assumption -- and
    // "you made 5,000 profit on a 5,000 sale" is a sentence a merchant will believe.
    let unitsSoldWithoutCost = 0;

    const perDay = new Map<string, DayBookDayRow>();
    if (isRange) {
      for (const k of dayKeysBetween(fromKey, toKey, MAX_RANGE_DAYS)) {
        perDay.set(k, { date: k, unitsIn: 0, unitsOut: 0, closingUnits: null, dispatchCount: 0, unitsDispatched: 0, revenue: 0, costOfGoods: 0, grossProfit: 0 });
      }
    }

    for (const m of movements) {
      const units = m.quantity;
      const value = Math.abs(units) * Number(m.unitCost || 0);

      if (m.reason === InventoryReason.SALE && units < 0 && !(Number(m.unitCost || 0) > 0)) {
        unitsSoldWithoutCost += Math.abs(units);
      }

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

      // One row per day for a range, under the same transfer rule as the totals above, so the
      // rows add up to them.
      const dayRow = perDay.get(localDayKey(m.createdAt, timezone));
      if (dayRow) {
        if (units > 0) dayRow.unitsIn += units; else dayRow.unitsOut += Math.abs(units);
        if (m.reason === InventoryReason.SALE && units < 0) dayRow.costOfGoods += value;
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

    // Count and value are checked SEPARATELY, because they can disagree for entirely
    // different reasons and only one of them means the books are broken.
    //
    // The count either matches or something is genuinely lost. The value can differ even when
    // every movement is right: this shop values stock at a weighted average, so when goods
    // arrive at a new price the units already on the shelf are re-valued too -- and that
    // re-valuation is not a movement, so it appears nowhere in what came in or went out.
    // Measured on a real day: 61 units on both sides, and a value 3,087.57 apart, entirely
    // from re-valuation.
    //
    // The old check compared units alone and then printed "the books balance", full stop --
    // which told the owner their closing VALUE had been verified when nothing had looked at
    // it. A closing stock figure is what somebody writes down as what their stock is worth.
    const balanced = closing && measured !== null ? closing.units === measured.units : null;

    // Only meaningful when the count agrees; a units mismatch is the headline on its own.
    const measuredValue = measured?.value ?? null;
    const valueGap = (closing && measuredValue !== null)
      ? round(measuredValue - closing.value)
      : null;
    const valueMatches = valueGap === null ? null : Math.abs(valueGap) < 0.01;

    // ─── SALES, MEASURED AT DISPATCH ──────────────────────────────────────────
    const soldLine = outLines.find(l => l.reason === InventoryReason.SALE);

    const countable = dispatches.filter(d => d.salesOrder?.status !== SalesOrderStatus.CANCELLED);

    const dispatchedUnits = countable.reduce(
      (s, d) => s + d.items.reduce((a, i) => a + (i.quantity || 0), 0), 0
    );

    /*
     * Revenue, read from the sales ledger rather than worked out again here.
     *
     * This used to be `dispatched quantity x that line's unit price`, which was exact while
     * every line was sold at its list price. It is not any more: a line of three sold for
     * ₹7,458.32 has no whole-paisa unit price, so multiplying up recognises ₹7,458.33 -- and the
     * day book would then disagree with the sales ledger about the same shipment, by a paisa,
     * for no reason a shop owner could ever discover.
     *
     * dispatch.service already computes this once, at the moment goods leave, using a cumulative
     * split that adds up to the line exactly however it is shipped. One number, computed once,
     * read everywhere. A dispatch with no ledger row earned nothing -- a wholly free shipment --
     * and contributes nothing.
     */
    const ledgerByDispatch = new Map<string, number>();
    if (countable.length > 0) {
      const rows = await prisma.salesLedger.findMany({
        where: { clientId, dispatchId: { in: countable.map(d => d.id) } },
        select: { dispatchId: true, revenue: true }
      });
      for (const row of rows) {
        if (row.dispatchId) {
          ledgerByDispatch.set(row.dispatchId, (ledgerByDispatch.get(row.dispatchId) || 0) + Number(row.revenue));
        }
      }
    }

    const revenue = round(countable.reduce((s, d) => s + (ledgerByDispatch.get(d.id) || 0), 0));

    // What those goods cost, taken from the stock movements rather than the order, so profit
    // compares like with like.
    const costOfGoods = soldLine?.value || 0;

    // The daily rows: sales by the day the goods left, and a running closing count.
    for (const d of countable) {
      const row = d.dispatchedAt ? perDay.get(localDayKey(d.dispatchedAt, timezone)) : undefined;
      if (!row) continue;
      row.dispatchCount += 1;
      row.unitsDispatched += d.items.reduce((a, i) => a + (i.quantity || 0), 0);
      row.revenue += ledgerByDispatch.get(d.id) || 0;
    }
    let running = opening ? opening.units : null;
    for (const row of perDay.values()) {
      if (running !== null) { running += row.unitsIn - row.unitsOut; row.closingUnits = running; }
      row.revenue = round(row.revenue);
      row.costOfGoods = round(row.costOfGoods);
      row.grossProfit = round(row.revenue - row.costOfGoods);
    }

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

    // ─── MONEY AT THE COUNTER ─────────────────────────────────────────────────
    // What was taken and what was paid back, by how -- so the cash drawer can be checked against it.
    // Points and store credit are listed but are not money in the drawer.
    const payRows = await prisma.salesOrderPayment.groupBy({
      by: ['kind', 'method'],
      where: { clientId, receivedAt: { gte: start, lt: end }, ...(locationId ? { locationId } : {}) },
      _sum: { amount: true },
      _count: { _all: true }
    });
    const moneyOf = (kind: 'PAYMENT' | 'REFUND') => Object.fromEntries(
      payRows.filter(r => r.kind === kind).map(r => [r.method, { amount: round(Number(r._sum.amount ?? 0)), count: r._count._all }])
    ) as Record<string, { amount: number; count: number }>;
    const taken = moneyOf('PAYMENT'), paidBack = moneyOf('REFUND');
    const money = {
      taken,
      paidBack,
      // Cash that should be in the drawer from today's counter: taken in cash less paid back in cash.
      cashInDrawer: round((taken.CASH?.amount ?? 0) - (paidBack.CASH?.amount ?? 0))
    };

    return {
      date: dayKey,
      money,
      // Set for a range only: the days it covers, first and last included, and a row for each.
      range: isRange ? { from: fromKey, to: toKey, dayCount: perDay.size } : null,
      days: isRange ? [...perDay.values()] : null,
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
      // Reported alongside, not folded into `balanced`, so the page can tell the owner which
      // of the two agrees. A count that is out means stock is missing; a value that is out by
      // the re-valuation amount means nothing is wrong at all.
      valueMatches,
      valueGap,
      measuredClosingValue: measuredValue,

      stockIn: { lines: inLines, totalUnits: totalIn, totalValue: totalInValue },
      stockOut: { lines: outLines, totalUnits: totalOut, totalValue: totalOutValue },

      transfers: { unitsMoved: transferUnits },

      sales: {
        dispatchCount: countable.length,
        unitsDispatched: dispatchedUnits,
        revenue,
        costOfGoods,
        grossProfit: round(revenue - costOfGoods),
        // How much of that profit is a guess. Nonzero means some of what was sold had no cost
        // recorded, so its full selling price is sitting in the profit figure above.
        unitsSoldWithoutCost,
        orders: countable
          .filter(d => d.salesOrder)
          .map(d => ({
            dispatchNumber: d.dispatchNumber,
            orderNumber: d.salesOrder!.orderNumber,
            customer: d.salesOrder!.customer?.name || null,
            units: d.items.reduce((a, i) => a + (i.quantity || 0), 0),
            // This dispatch's own value, not the parent order's -- and from the same ledger the
            // day's total above is summed from, so the rows add up to the figure beside them.
            value: round(ledgerByDispatch.get(d.id) || 0),
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
