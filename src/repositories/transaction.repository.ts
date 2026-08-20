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
      const variant = await tx.productVariant.findFirst({
        where: { id: data.variantId, clientId }
      });

      if (!variant) {
        throw new Error("Variant not found");
      }

      const balanceBefore = variant.quantity;
      let balanceAfter = balanceBefore;

      // 3. Calculate new quantity
      if (data.type === 'IN') {
        balanceAfter = balanceBefore + data.quantity;
      } else if (data.type === 'OUT') {
        balanceAfter = balanceBefore - data.quantity;
      } else if (data.type === 'ADJUSTMENT') {
        // For adjustment, we usually allow positive or negative, but our schema quantity is positive
        // Let's assume adjustment can be either depending on reason, or maybe the API passes a signed quantity?
        // Wait, the user said: newQty = currentQty +/- quantity. 
        // We will assume data.quantity is positive for IN/OUT, but for ADJUSTMENT it could be positive or negative?
        // Actually, the user's validation schema says positive integer. Let's just assume ADJUSTMENT acts like IN or OUT based on some rule, 
        // OR we just use a single math rule: + for IN, - for OUT, and for ADJUSTMENT maybe it's just setting the exact quantity?
        // Let's assume ADJUSTMENT is an absolute override (setting balanceAfter = data.quantity) OR a relative offset. 
        // Let's just treat ADJUSTMENT as adding/subtracting based on signed quantity. Since Zod forces positive, maybe we just use IN/OUT for everything. 
        // But ADJUSTMENT exists. Let's assume ADJUSTMENT always ADDS the given quantity. If they want to remove stock, they use OUT.
        // Wait, "ADJUSTMENT -> MANUAL_CORRECTION". Let's assume ADJUSTMENT sets the balance directly if it's an absolute correction? 
        // Let's go with absolute override for ADJUSTMENT.
        // Actually, no, `currentQty +/- quantity` is what the user said. 
        // Let's accept signed quantity in Zod for ADJUSTMENT if needed? I'll change Zod schema to allow negative for ADJUSTMENT.
        // Wait, if it's a signed quantity, we can just do balanceAfter = balanceBefore + data.quantity.
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
      await tx.productVariant.update({
        where: { id: data.variantId },
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
