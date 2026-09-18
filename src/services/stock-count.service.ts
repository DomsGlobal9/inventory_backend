import { prisma } from '../lib/prisma';
import { StockCountStatus, TransactionType, InventoryReason, Prisma } from '@prisma/client';
import { inventoryMutationService } from './inventory-mutation.service';
import { inventoryRepository } from '../repositories/inventory.repository';
import { notFound } from '../utils/httpError';
import { conflict, badRequest } from '../utils/httpError';

export class StockCountService {
  async getCounts(clientId: string) {
    return prisma.stockCount.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { items: true }
        }
      }
    });
  }

  async getCountById(clientId: string, id: string) {
    const count = await prisma.stockCount.findFirst({
      where: { id, clientId },
      include: {
        items: {
          include: {
            variant: {
              select: {
                stocks: { select: { locationId: true, quantity: true } },
                product: {
                  select: { title: true }
                }
              }
            }
          }
        }
      }
    });

    if (!count) throw notFound('Stock count not found');

    // The audit is scoped to a single location, but `stocks` above returns every
    // location's row for the variant -- flatten to the one this audit actually cares
    // about so the frontend's `item.variant.quantity` reflects current on-hand stock
    // at THIS location, not an arbitrary/undefined value.
    const items = count.items.map(item => {
      const stockAtLocation = item.variant.stocks.find(s => s.locationId === count.locationId);
      return {
        ...item,
        variant: {
          ...item.variant,
          quantity: stockAtLocation?.quantity ?? 0
        }
      };
    });

    return { ...count, items };
  }

  async createCount(clientId: string, name: string, locationId: string, categoryId?: string, createdBy?: string) {
    // The store is this shop's and still open. An id from another shop created an audit that could
    // only fail when it was completed, after somebody had counted a whole store for it.
    const store = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { active: true, name: true } });
    if (!store) throw notFound('That store was not found.');
    if (!store.active) throw badRequest(`${store.name} is switched off, so it cannot be counted.`);

    // Determine variants to snapshot for this specific location. Retired and binned products are
    // left out: nobody should be asked to count what the shop no longer sells.
    const variants = await prisma.productVariant.findMany({
      where: {
        clientId,
        product: {
          trashedAt: null,
          status: { notIn: ['ARCHIVED', 'TRASHED'] },
          ...(categoryId ? { category: categoryId as any } : {})
        }
      },
      include: {
        stocks: {
          where: { locationId },
          select: { quantity: true }
        }
      }
    });

    if (variants.length === 0) {
      throw badRequest('There is nothing to count yet: this shop has no products on sale. Add products first.');
    }

    const count = await prisma.stockCount.create({
      data: {
        clientId,
        name,
        locationId,
        createdBy,
        status: StockCountStatus.DRAFT,
      }
    });

    // Bulk insert items for large catalogs (1000+ variants)
    await prisma.stockCountItem.createMany({
      data: variants.map(v => ({
        stockCountId: count.id,
        variantId: v.id,
        sku: v.sku,
        variantCode: v.variantCode,
        barcode: v.barcode,
        // Since we filtered stocks by locationId, there's at most 1 element
        expectedQty: v.stocks.length > 0 ? v.stocks[0].quantity : 0
      }))
    });

    return prisma.stockCount.findUnique({
      where: { id: count.id },
      include: {
        _count: { select: { items: true } }
      }
    });
  }

  async startCount(clientId: string, id: string) {
    const count = await prisma.stockCount.findFirst({ where: { id, clientId } });
    if (!count) throw notFound('Stock count not found');
    // Bare Errors here meant a second press of Start answered 500 -- "the server broke" for
    // something the server refused on purpose -- and, because errorHandler persists only 5xx,
    // every double-click was written onto the Platform Console's Errors page.
    if (count.status !== StockCountStatus.DRAFT) throw conflict(this.cannotStart(count.status));

    // Only from DRAFT, in the same statement: a count cancelled a moment ago must not be started.
    const started = await prisma.stockCount.updateMany({
      where: { id, clientId, status: StockCountStatus.DRAFT },
      data: { status: StockCountStatus.IN_PROGRESS, startedAt: new Date() }
    });
    if (started.count === 0) throw conflict(this.cannotStart(await this.statusOf(clientId, id)));
    return prisma.stockCount.findUnique({ where: { id } });
  }

  private cannotStart(status: StockCountStatus | null) {
    if (status === StockCountStatus.IN_PROGRESS) return 'This audit is already under way. Refresh to see where it got to.';
    if (status === StockCountStatus.CANCELLED) return 'This count was cancelled, so it cannot be started. Start a new count instead.';
    return 'This audit has already been completed, so it cannot be started again.';
  }

  /** Why a count that is no longer open refuses to be changed, in the words the person needs. */
  private closedMessage(status: StockCountStatus | null) {
    if (status === StockCountStatus.CANCELLED) return 'This count was cancelled, so nothing on it can be changed. Start a new count instead.';
    return 'This audit has already been completed. Start a new one to count again.';
  }

  private async statusOf(clientId: string, id: string) {
    return (await prisma.stockCount.findFirst({ where: { id, clientId }, select: { status: true } }))?.status ?? null;
  }

  /**
   * Called off. Only DRAFT or IN_PROGRESS: a completed count has already corrected the stock,
   * and undoing that is a new count's job, not this one's.
   *
   * No stock moves, and nothing typed is thrown away: a cancelled count keeps its lines, so the
   * owner can still see what was counted before somebody called it off -- often the very thing
   * they want to check. Those lines no longer stop a binned product being deleted for good: the
   * delete ignores lines of cancelled counts and removes them itself (see product.repository).
   *
   * completedAt / completedBy hold when and by whom it was CLOSED -- for a cancelled count, the
   * cancelling. There is no separate column, and the schema is not changing for this.
   */
  async cancelCount(clientId: string, id: string, cancelledBy?: string) {
    const count = await prisma.stockCount.findFirst({ where: { id, clientId }, select: { status: true, _count: { select: { items: true } } } });
    if (!count) throw notFound('Stock count not found');
    if (count.status === StockCountStatus.COMPLETED) {
      throw conflict('This count is already completed and its corrections are in your stock, so it cannot be cancelled. To fix a number, start a new count or correct that item’s stock.');
    }
    if (count.status === StockCountStatus.CANCELLED) throw conflict('This count has already been cancelled.');

    // One statement decides it. Completing claims the count the same way (see completeCount), so
    // when both are pressed at once exactly one of them finds it still open, and the other is told.
    const claimed = await prisma.stockCount.updateMany({
      where: { id, clientId, status: { in: [StockCountStatus.DRAFT, StockCountStatus.IN_PROGRESS] } },
      data: { status: StockCountStatus.CANCELLED, completedAt: new Date(), completedBy: cancelledBy, totalItems: count._count.items }
    });
    const cancelled = claimed.count > 0;

    if (!cancelled) {
      const now = await this.statusOf(clientId, id);
      throw conflict(now === StockCountStatus.COMPLETED
        ? 'This count was completed a moment ago, so it cannot be cancelled. Its corrections are in your stock.'
        : 'This count has already been cancelled.');
    }
    return prisma.stockCount.findUnique({ where: { id } });
  }

  async updateItemCount(clientId: string, id: string, itemId: string, countedQty: number | null) {
    // Validate count exists and is still open
    const count = await prisma.stockCount.findFirst({ where: { id, clientId } });
    if (!count) throw notFound('Stock count not found');
    if (count.status === StockCountStatus.COMPLETED || count.status === StockCountStatus.CANCELLED) {
      throw conflict(this.closedMessage(count.status));
    }

    /*
     * What the system held at the moment this line was counted.
     *
     * The expected figure used to be the one taken when the audit was CREATED, and completion
     * adjusted by counted minus that. A count takes hours while the shop keeps selling: 10 expected,
     * 3 sold during the count, 7 counted -- and completion took off another 3, leaving 4 on the
     * books for 7 on the shelf. Recording the system figure as each line is counted makes the
     * correction counted minus what the books said at that moment, so sales before AND after the
     * count are both left alone.
     */
    const item = await prisma.stockCountItem.findFirst({ where: { id: itemId, stockCountId: id }, select: { variantId: true } });
    if (!item) throw notFound('That line is not on this audit.');
    let expectedNow: number | undefined;
    if (countedQty !== null && count.locationId) {
      const stock = await prisma.inventoryStock.findFirst({ where: { variantId: item.variantId, locationId: count.locationId }, select: { quantity: true } });
      expectedNow = stock?.quantity ?? 0;
    }

    // Only while the count is still open, checked in the same statement: a line typed on one
    // screen while the count is being cancelled or completed on another must not land after it.
    const saved = await prisma.stockCountItem.updateMany({
      where: { id: itemId, stockCountId: id, stockCount: { status: { in: [StockCountStatus.DRAFT, StockCountStatus.IN_PROGRESS] } } },
      data: { countedQty, ...(expectedNow !== undefined ? { expectedQty: expectedNow } : {}) }
    });
    if (saved.count === 0) {
      const now = await this.statusOf(clientId, id);
      // Still open, yet nothing matched: the line itself is gone, not the count closed.
      if (now === StockCountStatus.DRAFT || now === StockCountStatus.IN_PROGRESS) throw notFound('That line is not on this audit.');
      throw conflict(this.closedMessage(now));
    }
    return prisma.stockCountItem.findUnique({ where: { id: itemId } });
  }

  async completeCount(clientId: string, id: string, completedBy?: string) {
    const count = await prisma.stockCount.findFirst({
      where: { id, clientId },
      include: { items: true }
    });

    if (!count) throw notFound('Stock count not found');
    if (count.status === StockCountStatus.COMPLETED || count.status === StockCountStatus.CANCELLED) {
      throw conflict(this.closedMessage(count.status));
    }
    if (!count.locationId) throw new Error('Legacy stock count without a location cannot be completed in multi-location mode.');

    // Filter items with discrepancies
    const itemsWithDifferences = count.items.filter(
      item => item.countedQty !== null && item.countedQty !== item.expectedQty
    );

    const totalItems = count.items.length;
    const adjustedItems = itemsWithDifferences.length;
    const matchedItems = count.items.filter(item => item.countedQty !== null && item.countedQty === item.expectedQty).length;
    const itemsWithoutCount = totalItems - (adjustedItems + matchedItems);

    // Calculate accuracy (only based on counted items)
    const itemsCounted = matchedItems + adjustedItems;
    const accuracy = itemsCounted > 0 ? (matchedItems / itemsCounted) * 100 : null;

    // Execute completion atomically
    try {
      await prisma.$transaction(async (tx) => {
        // Claimed FIRST, and only if still open. Cancelling claims it the same way, so of a
        // complete and a cancel pressed together exactly one finds it open; the loser changes
        // nothing. It used to be marked completed last, after the corrections, with nothing to stop
        // a second completion -- or a cancel -- getting in between.
        const claimed = await tx.stockCount.updateMany({
          where: { id, clientId, status: { in: [StockCountStatus.DRAFT, StockCountStatus.IN_PROGRESS] } },
          data: {
            status: StockCountStatus.COMPLETED,
            completedAt: new Date(),
            completedBy,
            totalItems,
            matchedItems,
            adjustedItems,
            accuracy: accuracy !== null ? accuracy : undefined
          }
        });
        if (claimed.count === 0) throw conflict(this.closedMessage(await this.statusOf(clientId, id)));

        for (const item of itemsWithDifferences) {
          const difference = item.countedQty! - item.expectedQty;

          await inventoryMutationService.applyMovement({
            clientId,
            locationId: count.locationId!,
            variantId: item.variantId,
            movementType: 'ADJUSTMENT',
            reason: 'AUDIT_CORRECTION',
            quantityDelta: difference,
            notes: `Audit Correction (Count: ${count.name})`,
            createdBy: completedBy,
            tx
          });
        }
      }, {
        timeout: 30000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error: any) {
      // Serializable turns "somebody closed it at the same instant" into a write conflict. Say
      // what actually happened to the count rather than "somebody saved this at the same moment".
      if (error?.code === 'P2034' || /could not serialize access/i.test(String(error?.message))) {
        const now = await this.statusOf(clientId, id);
        if (now === StockCountStatus.COMPLETED || now === StockCountStatus.CANCELLED) throw conflict(this.closedMessage(now));
      }
      throw error;
    }

    return prisma.stockCount.findUnique({ where: { id } });
  }
}

export const stockCountService = new StockCountService();
