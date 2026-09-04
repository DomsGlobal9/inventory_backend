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
  currentStock: number;
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
   * Everything below its reorder level, grouped by the supplier we would buy it from.
   *
   * Items with no supplier recorded are returned separately rather than dropped: they are
   * exactly the ones that would otherwise run out silently, and hiding them would make the
   * feature quietly incomplete.
   */
  async getSuggestions(clientId: string) {
    const variants = await prisma.productVariant.findMany({
      // reorderLevel 0 means "not tracked for reordering" -- the default for a variant
      // nobody has configured. Including those would suggest ordering every item with no
      // stock, which is most of a new catalogue.
      where: { clientId, reorderLevel: { gt: 0 } },
      select: {
        id: true, sku: true, size: true, colorName: true,
        reorderLevel: true, reorderQty: true, averageCost: true, lastPurchaseCost: true,
        product: { select: { title: true, status: true } },
        stocks: { select: { quantity: true } },
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

    for (const variant of variants) {
      // Trashed and archived products should not generate purchase suggestions -- nobody
      // wants an order for something they have deliberately taken out of the catalogue.
      if (variant.product?.status === 'TRASHED' || variant.product?.status === 'ARCHIVED') continue;

      const currentStock = variant.stocks.reduce((sum, s) => sum + s.quantity, 0);
      if (currentStock > variant.reorderLevel) continue;

      // Preferred first; otherwise the only link there is. An inactive supplier is skipped
      // over rather than used, since ordering from them is exactly what "inactive" rules out.
      const usable = variant.supplierLinks.filter(l => l.supplier?.isActive !== false);
      const link = usable.find(l => l.isPreferred) || usable[0] || null;

      const { qty, raisedToMinimum } = this.suggestQty(
        currentStock, variant.reorderLevel, variant.reorderQty, link?.minOrderQty ?? null
      );

      // The supplier's agreed price is the right basis for a purchase order. averageCost is
      // a blend of everything ever paid across every source, and lastPurchaseCost is
      // whatever the last receipt happened to cost -- neither is what this vendor charges.
      const unitPrice =
        (link?.costPrice != null ? Number(link.costPrice) : null)
        ?? (variant.lastPurchaseCost != null ? Number(variant.lastPurchaseCost) : null)
        ?? (variant.averageCost != null ? Number(variant.averageCost) : 0);

      const line: ReorderLine & { productTitle: string } = {
        variantId: variant.id,
        sku: variant.sku,
        productTitle: variant.product?.title || 'Unknown product',
        size: variant.size,
        colorName: variant.colorName,
        currentStock,
        reorderLevel: variant.reorderLevel,
        suggestedQty: qty,
        unitPrice,
        lineTotal: qty * unitPrice,
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
      suppliers,
      unassigned,
      summary: {
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
    groups: { supplierId: string; items: { variantId: string; orderedQty: number; unitPrice: number }[] }[]
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
        const po = await purchaseOrderService.createPO(clientId, {
          supplierId: group.supplierId,
          notes: 'Created from reorder suggestions.',
          items: group.items.map(i => ({
            variantId: i.variantId,
            orderedQty: i.orderedQty,
            unitPrice: i.unitPrice
          }))
        });
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
