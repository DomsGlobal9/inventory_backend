import { PurchaseOrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { purchaseOrderService } from './purchase-order.service';

/**
 * Turns "what is running out" into "what to order from whom".
 *
 * Both halves already existed and never met: reports could list low stock, and the alert
 * centre could prefill a purchase order for a single item, but restocking a shop meant
 * working down that list one variant at a time, remembering who supplies each and opening a
 * separate order for every vendor. With supplier_products in place the grouping is finally
 * derivable, which is the whole point of having built it.
 *
 * Deliberately produces DRAFTs and never sends anything. Ordering stock costs real money;
 * the system's job is to remove the clerical work of assembling the order, not to decide on
 * its own that it should be placed.
 */

export interface ReorderLine {
  variantId: string;
  sku: string;
  productTitle: string;
  size: string | null;
  colorName: string | null;
  /** On the shelf at the store the suggestions are for (every store when none is given). */
  currentStock: number;
  /** Still to arrive on open orders for that store, drafts included. */
  onOrder: number;
  reorderLevel: number;
  suggestedQty: number;
  unitPrice: number;
  lineTotal: number;
  supplierSku: string | null;
  leadTimeDays: number | null;
  minOrderQty: number | null;
  /** True when the quantity was lifted to satisfy the supplier's minimum order. */
  raisedToMinimum: boolean;
}

export class ReorderService {
  /**
   * How many to order.
   *
   * reorderQty is what the merchant said they buy at a time, so it wins outright. Otherwise
   * bring stock back to the reorder level -- the shortfall, never less than one, because a
   * suggestion to order nothing is not a suggestion. A supplier's minimum order then acts as
   * a floor: ordering under it gets the order rejected or quietly rounded up at their end,
   * so it is better to show the real number now.
   */
  private suggestQty(
    currentStock: number,
    reorderLevel: number,
    reorderQty: number | null,
    minOrderQty: number | null
  ): { qty: number; raisedToMinimum: boolean } {
    const base = reorderQty && reorderQty > 0
      ? reorderQty
      : Math.max(reorderLevel - currentStock, 1);

    if (minOrderQty && base < minOrderQty) {
      return { qty: minOrderQty, raisedToMinimum: true };
    }
    return { qty: base, raisedToMinimum: false };
  }

  /**
   * Everything below its reorder level at one store, grouped by the supplier we would buy it from.
   *
   * Items with no supplier recorded are returned separately rather than dropped: they are
   * exactly the ones that would otherwise run out silently, and hiding them would make the
   * feature quietly incomplete.
   *
   * Per store, because low-stock alerts are per store and a delivery goes to one store. Adding
   * every store's stock together said an item was fine while the store that had run out stayed
   * empty -- 10 in the warehouse hides 0 on the shop floor.
   *
   * What is already on order for the store counts towards it. Without that, pressing "Create
   * Draft Orders" and coming back showed the same items again, asking to order them twice.
   * Orders with no store chosen are not counted -- where they will arrive is unknown -- but are
   * reported so the screen can say so.
   */
  async getSuggestions(clientId: string, locationId?: string | null) {
    const location = locationId
      ? await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true, name: true, code: true } })
      : null;

    const openLines = await prisma.purchaseOrderItem.findMany({
      where: {
        po: {
          clientId,
          status: { in: [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.SENT, PurchaseOrderStatus.PARTIALLY_RECEIVED] },
          ...(location ? { locationId: location.id } : {})
        }
      },
      select: { variantId: true, orderedQty: true, receivedQty: true }
    });
    const onOrderBy = new Map<string, number>();
    for (const l of openLines) {
      onOrderBy.set(l.variantId, (onOrderBy.get(l.variantId) ?? 0) + Math.max(l.orderedQty - l.receivedQty, 0));
    }
    const ordersWithoutStore = location
      ? await prisma.purchaseOrder.count({
          where: { clientId, locationId: null, status: { in: [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.SENT, PurchaseOrderStatus.PARTIALLY_RECEIVED] } }
        })
      : 0;

    const variants = await prisma.productVariant.findMany({
      // reorderLevel 0 means "not tracked for reordering" -- the default for a variant
      // nobody has configured. Including those would suggest ordering every item with no
      // stock, which is most of a new catalogue.
      where: { clientId, reorderLevel: { gt: 0 } },
      select: {
        id: true, sku: true, size: true, colorName: true,
        reorderLevel: true, reorderQty: true, averageCost: true, lastPurchaseCost: true, costPrice: true,
        product: { select: { title: true, status: true } },
        stocks: { where: location ? { locationId: location.id } : {}, select: { quantity: true } },
        // Whether it has been held anywhere at all, and whether it is switched off for this
        // store: together they tell "run out here" from "never carried here". See below.
        _count: { select: { stocks: true } },
        locationProfiles: {
          where: location ? { locationId: location.id } : { locationId: { in: [] } },
          select: { isAvailable: true }
        },
        supplierLinks: {
          select: {
            id: true, supplierId: true, supplierSku: true, costPrice: true,
            leadTimeDays: true, minOrderQty: true, isPreferred: true,
            supplier: { select: { id: true, name: true, supplierCode: true, phone: true, isActive: true } }
          }
        }
      }
    });

    const grouped = new Map<string, {
      supplier: { id: string; name: string; supplierCode: string; phone: string | null; isActive: boolean };
      lines: ReorderLine[];
      estimatedTotal: number;
    }>();
    const unassigned: (ReorderLine & { productTitle: string })[] = [];
    let coveredByOpenOrders = 0;
    // Low or out here, but deliberately not suggested -- counted so the screen never calls the
    // store healthy while leaving them out.
    let notSoldHere = 0;
    let neverStockedHere = 0;

    for (const variant of variants) {
      // Trashed and archived products should not generate purchase suggestions -- nobody
      // wants an order for something they have deliberately taken out of the catalogue.
      if (variant.product?.status === 'TRASHED' || variant.product?.status === 'ARCHIVED') continue;

      const currentStock = variant.stocks.reduce((sum, s) => sum + s.quantity, 0);
      if (currentStock > variant.reorderLevel) continue;
      const onOrder = onOrderBy.get(variant.id) ?? 0;
      const profile = variant.locationProfiles[0];
      // Switched off for this store in the item's store settings: not sold here, so not bought for it.
      if (location && profile?.isAvailable === false) {
        notSoldHere++;
        continue;
      }
      /*
       * A store is asked to reorder only what it carries. Otherwise a new branch, or a warehouse
       * that never takes saris, was told the whole catalogue had run out -- 236 items at a store
       * that had never stocked one of them.
       *
       * But "no stock row here" alone was the wrong test: an item never received anywhere has no
       * row at any store, so a shop's out-of-stock item vanished from Reorder while the Dashboard
       * counted it as out, and the screen said "Inventory is Healthy". Carried here means: held
       * here before, on order for here, switched on for here, or not yet held anywhere at all.
       * Only an item stocked at other stores and never at this one is left out.
       */
      const carriedHere = variant.stocks.length > 0 || onOrder > 0
        || profile?.isAvailable === true || variant._count.stocks === 0;
      if (location && !carriedHere) {
        neverStockedHere++;
        continue;
      }
      // Low now, but enough is already coming. Reaching the level counts once something is on
      // order: a suggestion brings stock up to the level, so ordering exactly what was suggested
      // must clear it -- with ">" it came straight back asking for one more, and one more after that.
      if (currentStock + onOrder > variant.reorderLevel || (onOrder > 0 && currentStock + onOrder >= variant.reorderLevel)) {
        coveredByOpenOrders++;
        continue;
      }

      // Preferred first; otherwise the only link there is. An inactive supplier is skipped
      // over rather than used, since ordering from them is exactly what "inactive" rules out.
      const usable = variant.supplierLinks.filter(l => l.supplier?.isActive !== false);
      const link = usable.find(l => l.isPreferred) || usable[0] || null;

      const { qty, raisedToMinimum } = this.suggestQty(
        currentStock + onOrder, variant.reorderLevel, variant.reorderQty, link?.minOrderQty ?? null
      );

      // The supplier's agreed price is the right basis for a purchase order. averageCost is
      // a blend of everything ever paid across every source, and lastPurchaseCost is
      // whatever the last receipt happened to cost -- neither is what this vendor charges.
      // A 0 anywhere in the chain means "never recorded", not "free" -- stopping at it priced the
      // line at ₹0, and receiving that order would drag the average cost down.
      // Rounded to the paisa: the average cost carries six decimals, and a purchase order is money.
      const known = (v: unknown) => (v != null && Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null);
      const unitPrice =
        known(link?.costPrice) ?? known(variant.lastPurchaseCost)
        ?? known(variant.costPrice) ?? known(variant.averageCost) ?? 0;

      const line: ReorderLine & { productTitle: string } = {
        variantId: variant.id,
        sku: variant.sku,
        productTitle: variant.product?.title || 'Unknown product',
        size: variant.size,
        colorName: variant.colorName,
        currentStock,
        onOrder,
        reorderLevel: variant.reorderLevel,
        suggestedQty: qty,
        unitPrice,
        lineTotal: Math.round(qty * unitPrice * 100) / 100,
        supplierSku: link?.supplierSku ?? null,
        leadTimeDays: link?.leadTimeDays ?? null,
        minOrderQty: link?.minOrderQty ?? null,
        raisedToMinimum
      };

      if (!link?.supplier) {
        unassigned.push(line);
        continue;
      }

      const existing = grouped.get(link.supplier.id);
      if (existing) {
        existing.lines.push(line);
        existing.estimatedTotal += line.lineTotal;
      } else {
        grouped.set(link.supplier.id, {
          supplier: link.supplier,
          lines: [line],
          estimatedTotal: line.lineTotal
        });
      }
    }

    // Biggest spend first: that is the order that needs the most attention before sending.
    const suppliers = [...grouped.values()].sort((a, b) => b.estimatedTotal - a.estimatedTotal);

    return {
      location,
      suppliers,
      unassigned,
      summary: {
        coveredByOpenOrders,
        notSoldHere,
        neverStockedHere,
        ordersWithoutStore,
        supplierCount: suppliers.length,
        lineCount: suppliers.reduce((n, s) => n + s.lines.length, 0) + unassigned.length,
        unassignedCount: unassigned.length,
        estimatedTotal: suppliers.reduce((sum, s) => sum + s.estimatedTotal, 0)
      }
    };
  }

  /**
   * Creates one DRAFT purchase order per supplier from the chosen lines.
   *
   * Quantities and prices come from the request, not recalculated here: the user has seen
   * the suggestion and may well have adjusted it, and silently overriding their edit with a
   * freshly computed number would be worse than useless.
   */
  async createDraftOrders(
    clientId: string,
    groups: { supplierId: string; items: { variantId: string; orderedQty: number; unitPrice: number }[] }[],
    locationId?: string | null,
    selectedLocationId?: string
  ) {
    if (!groups.length) {
      throw Object.assign(new Error('Select at least one item to order.'), { statusCode: 400 });
    }

    const supplierIds = [...new Set(groups.map(g => g.supplierId))];
    const owned = await prisma.supplier.findMany({
      where: { id: { in: supplierIds }, clientId },
      select: { id: true }
    });
    if (owned.length !== supplierIds.length) {
      throw Object.assign(new Error('One or more suppliers could not be found.'), { statusCode: 404 });
    }

    const created: { poNumber: string; id: string; supplierId: string; itemCount: number }[] = [];
    const failed: { supplierId: string; message: string }[] = [];

    // Sequential, and a failure for one supplier does not abandon the rest. Each purchase
    // order is independent; losing four good orders because the fifth had a stale variant
    // would be a poor trade.
    for (const group of groups) {
      if (!group.items?.length) continue;
      try {
        // For the store the suggestions were worked out for, so what arrives lands where it ran out.
        const po = await purchaseOrderService.createPO(clientId, {
          supplierId: group.supplierId,
          locationId,
          notes: 'Created from reorder suggestions.',
          items: group.items.map(i => ({
            variantId: i.variantId,
            orderedQty: i.orderedQty,
            unitPrice: i.unitPrice
          }))
        }, selectedLocationId);
        created.push({ poNumber: po.poNumber, id: po.id, supplierId: group.supplierId, itemCount: group.items.length });
      } catch (error: any) {
        failed.push({ supplierId: group.supplierId, message: error?.message || 'Could not create the order' });
      }
    }

    if (!created.length && failed.length) {
      throw Object.assign(
        new Error(`No purchase orders could be created. ${failed[0].message}`),
        { statusCode: 400 }
      );
    }

    return { created, failed, status: PurchaseOrderStatus.DRAFT };
  }
}

export const reorderService = new ReorderService();
