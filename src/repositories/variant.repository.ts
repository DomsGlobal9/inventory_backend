import { prisma } from '../lib/prisma';
import { Prisma, ProductVariant } from '@prisma/client';

export class VariantRepository {
  
  async create(data: Prisma.ProductVariantUncheckedCreateInput): Promise<ProductVariant> {
    return prisma.productVariant.create({
      data
    });
  }

  async variantCodeExists(clientId: string, variantCode: string): Promise<boolean> {
    const count = await prisma.productVariant.count({ where: { clientId, variantCode } });
    return count > 0;
  }

  async barcodeExists(barcode: string): Promise<boolean> {
    const count = await prisma.productVariant.count({ where: { barcode } });
    return count > 0;
  }

  async findManyByProduct(productId: string, clientId: string): Promise<ProductVariant[]> {
    return prisma.productVariant.findMany({
      where: { productId, clientId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async findById(id: string, clientId: string): Promise<ProductVariant | null> {
    return prisma.productVariant.findFirst({
      where: { id, clientId }
    });
  }

  async updateSafe(id: string, clientId: string, data: Prisma.ProductVariantUpdateInput): Promise<ProductVariant> {
    const existing = await this.findById(id, clientId);
    if (!existing) throw new Error("Variant not found");

    return prisma.productVariant.update({
      where: { id },
      data
    });
  }

  async delete(id: string, clientId: string): Promise<ProductVariant> {
    const existing = await this.findById(id, clientId);
    if (!existing) throw new Error("Variant not found");

    // Check for blocking historical records before attempting deletion
    const [poItemCount, transactionCount, stockCountItemCount] = await Promise.all([
      prisma.purchaseOrderItem.count({ where: { variantId: id } }),
      prisma.inventoryTransaction.count({ where: { variantId: id } }),
      prisma.stockCountItem.count({ where: { variantId: id } })
    ]);

    if (poItemCount > 0) {
      throw new Error("Cannot delete variant: it is referenced in one or more purchase orders.");
    }
    if (transactionCount > 0) {
      throw new Error("Cannot delete variant: it has inventory transaction history.");
    }
    if (stockCountItemCount > 0) {
      throw new Error("Cannot delete variant: it appears in audit/stock count records.");
    }
    if (existing.quantity > 0) {
      throw new Error("Cannot delete variant: it still has stock on hand. Adjust stock to 0 first.");
    }

    return prisma.productVariant.delete({
      where: { id }
    });
  }
  async searchVariants(clientId: string, params: { q: string, page: number, limit: number, includeInventory?: boolean, includeCosting?: boolean }) {
    const { q, page, limit } = params;
    const skip = (page - 1) * limit;

    // 1. Exact Match Phase
    if (q) {
      const exactWhere: Prisma.ProductVariantWhereInput = {
        clientId,
        OR: [
          { barcode: q },
          { variantCode: q },
          { sku: q }
        ]
      };
      
      const exactMatches = await prisma.productVariant.findMany({
        where: exactWhere,
        include: { product: true }
      });

      if (exactMatches.length > 0) {
        return {
          data: exactMatches,
          total: exactMatches.length,
          page: 1,
          limit,
          pages: 1
        };
      }
    }

    // 2. Fallback Fuzzy Search Phase
    const fuzzyWhere: Prisma.ProductVariantWhereInput = {
      clientId,
      ...(q && {
        OR: [
          { sku: { contains: q, mode: 'insensitive' } },
          { variantCode: { contains: q, mode: 'insensitive' } },
          { barcode: { contains: q, mode: 'insensitive' } },
          { colorName: { contains: q, mode: 'insensitive' } },
          { size: { contains: q, mode: 'insensitive' } },
          { product: { title: { contains: q, mode: 'insensitive' } } }
        ]
      })
    };

    const [data, total] = await Promise.all([
      prisma.productVariant.findMany({
        where: fuzzyWhere,
        skip,
        take: limit,
        include: { product: true },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.productVariant.count({ where: fuzzyWhere })
    ]);

    return {
      data,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    };
  }
}

export const variantRepository = new VariantRepository();
