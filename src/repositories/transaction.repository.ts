import { prisma } from '../lib/prisma';
import { Prisma, TransactionType, InventoryReason } from '@prisma/client';

export class TransactionRepository {
  
  async createTransaction(clientId: string, data: {
    variantId: string;
    type: TransactionType;
    reason: InventoryReason;
    quantity: number;
    notes?: string;
    referenceType?: string;
    referenceId?: string;
    metadata?: any;
    createdBy?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      // 1. Fetch current variant quantity
      const defaultLoc = await tx.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
      const stock = await tx.inventoryStock.findFirst({
        where: { variantId: data.variantId, locationId: defaultLoc!.id }
      });

      const balanceBefore = stock?.quantity || 0;
      let balanceAfter = balanceBefore;

      // 3. Calculate new quantity
      if (data.type === 'IN') {
        balanceAfter = balanceBefore + data.quantity;
      } else if (data.type === 'OUT') {
        balanceAfter = balanceBefore - data.quantity;
      } else if (data.type === 'ADJUSTMENT') {
        balanceAfter = balanceBefore + data.quantity;
      }

      // 4. Reject if negative
      if (balanceAfter < 0) {
        throw new Error("Insufficient inventory: Resulting quantity cannot be negative");
      }

      // 5. Create transaction record
      const transaction = await tx.inventoryTransaction.create({
        data: {
          clientId,
          locationId: defaultLoc!.id,
          variantId: data.variantId,
          type: data.type,
          reason: data.reason,
          quantity: data.quantity, // store the delta
          balanceBefore,
          balanceAfter,
          notes: data.notes,
          referenceType: data.referenceType,
          referenceId: data.referenceId,
          metadata: data.metadata || {},
          createdBy: data.createdBy
        }
      });

      // 6. Update variant quantity
      await tx.inventoryStock.update({
        where: { variantId_locationId: { variantId: data.variantId, locationId: defaultLoc!.id } },
        data: { quantity: balanceAfter }
      });

      return transaction;
    });
  }

  async getTransactions(clientId: string, filters: {
    productId?: string;
    variantId?: string;
    type?: TransactionType;
    reason?: InventoryReason;
    from?: string;
    to?: string;
    page: number;
    limit: number;
  }) {
    const where: Prisma.InventoryTransactionWhereInput = { clientId };

    if (filters.variantId) {
      where.variantId = filters.variantId;
    }
    
    if (filters.productId) {
      where.variant = { productId: filters.productId };
    }

    if (filters.type) {
      where.type = filters.type;
    }

    if (filters.reason) {
      where.reason = filters.reason;
    }

    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from);
      if (filters.to) where.createdAt.lte = new Date(filters.to);
    }

    const skip = (filters.page - 1) * filters.limit;

    const [total, data] = await Promise.all([
      prisma.inventoryTransaction.count({ where }),
      prisma.inventoryTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: filters.limit,
        include: {
          variant: {
            select: { sku: true, size: true, colorName: true }
          }
        }
      })
    ]);

    return { total, data, page: filters.page, limit: filters.limit };
  }
}

export const transactionRepository = new TransactionRepository();
