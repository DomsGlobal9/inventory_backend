import { prisma } from '../lib/prisma';
import { StockCountStatus, TransactionType, InventoryReason } from '@prisma/client';
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
                quantity: true,
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
    return count;
  }

  async createCount(clientId: string, name: string, categoryId?: string, createdBy?: string) {
    // Determine variants to snapshot
    const variants = await prisma.productVariant.findMany({
      where: { 
        clientId,
        ...(categoryId ? { product: { category: categoryId as any } } : {})
      },
    });

    if (variants.length === 0) {
      throw new Error('No variants found to audit.');
    }

    const count = await prisma.stockCount.create({
      data: {
        clientId,
        name,
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
        expectedQty: v.quantity
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

  async updateItemCount(clientId: string, id: string, itemId: string, countedQty: number) {
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

    // Execute completion
    // 1. Process all discrepancies
    for (const item of itemsWithDifferences) {
        const difference = item.countedQty! - item.expectedQty;
        
        // Use central mutation service for adjustments
        // Note: we can't use `tx` easily with `inventoryMutationService`, but `applyMovement`
        // manages its own atomic CTEs and ledger inserts. It's safe to call here.
        await inventoryMutationService.applyMovement({
          clientId,
          variantId: item.variantId,
          movementType: 'ADJUSTMENT',
          reason: 'AUDIT_CORRECTION',
          quantityDelta: difference,
          notes: `Audit Correction (Count: ${count.name})`,
          createdBy: completedBy
        });
      }

      // 2. Mark count as completed
      await prisma.stockCount.update({
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

    return prisma.stockCount.findUnique({ where: { id } });
  }
}

export const stockCountService = new StockCountService();
