import { prisma } from '../lib/prisma';
import { StockCountStatus, TransactionType, InventoryReason, Prisma } from '@prisma/client';
import { inventoryMutationService } from './inventory-mutation.service';
import { inventoryRepository } from '../repositories/inventory.repository';

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

    if (!count) throw new Error('Stock count not found');

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
    // Determine variants to snapshot for this specific location
    const variants = await prisma.productVariant.findMany({
      where: { 
        clientId,
        ...(categoryId ? { product: { category: categoryId as any } } : {})
      },
      include: {
        stocks: {
          where: { locationId },
          select: { quantity: true }
        }
      }
    });

    if (variants.length === 0) {
      throw new Error('No variants found to audit for this location.');
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
    if (!count) throw new Error('Stock count not found');
    if (count.status !== StockCountStatus.DRAFT) throw new Error(`Cannot start audit from status: ${count.status}`);

    return prisma.stockCount.update({
      where: { id },
      data: { 
        status: StockCountStatus.IN_PROGRESS,
        startedAt: new Date()
      }
    });
  }

  async updateItemCount(clientId: string, id: string, itemId: string, countedQty: number | null) {
    // Validate count exists and is in progress
    const count = await prisma.stockCount.findFirst({ where: { id, clientId } });
    if (!count) throw new Error('Stock count not found');
    if (count.status === StockCountStatus.COMPLETED) throw new Error('Audit is already completed');
    
    return prisma.stockCountItem.update({
      where: { id: itemId, stockCountId: id },
      data: { countedQty }
    });
  }

  async completeCount(clientId: string, id: string, completedBy?: string) {
    const count = await prisma.stockCount.findFirst({
      where: { id, clientId },
      include: { items: true }
    });

    if (!count) throw new Error('Stock count not found');
    if (count.status === StockCountStatus.COMPLETED) throw new Error('Audit is already completed');
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
    await prisma.$transaction(async (tx) => {
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

      await tx.stockCount.update({
        where: { id },
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
    }, {
      timeout: 30000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });

    return prisma.stockCount.findUnique({ where: { id } });
  }
}

export const stockCountService = new StockCountService();
