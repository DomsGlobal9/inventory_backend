import { prisma } from '../lib/prisma';
import { Prisma, Product } from '@prisma/client';

export class ProductRepository {
  
  async create(data: Prisma.ProductUncheckedCreateInput): Promise<Product> {
    return prisma.product.create({
      data
    });
  }

  async codeExists(productCode: string): Promise<boolean> {
    const count = await prisma.product.count({
      where: { productCode }
    });
    return count > 0;
  }

  async findMany(clientId: string, skip?: number, take?: number): Promise<Product[]> {
    return prisma.product.findMany({
      where: { clientId, status: { notIn: ['TRASHED'] } },
      skip,
      take,
      orderBy: { createdAt: 'desc' }
    });
  }

  async findManyWithFilters(clientId: string, queryParams: any): Promise<{ data: Product[], meta: any }> {
    const { page, limit, search, status, category, sortBy, order } = queryParams;
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      clientId,
      ...(status ? { status } : { status: { in: ['ACTIVE', 'DRAFT'] } }),
      ...(category && { category }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { productCode: { contains: search, mode: 'insensitive' } }
        ]
      })
    };

    const [rawData, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: order },
        include: { variants: { include: { stocks: true } } }
      }),
      prisma.product.count({ where })
    ]);

    const data = rawData.map(product => {
      const variantCount = product.variants.length;
      const totalUnits = product.variants.reduce((sum, v) => sum + v.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0), 0);
      const lowStockVariants = product.variants.filter((v) => v.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0) <= v.reorderLevel).length;
      
      const { variants, ...rest } = product;
      return {
        ...rest,
        variantSummary: { variantCount, totalUnits, lowStockVariants }
      };
    });

    return {
      data,
      meta: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  async checkHardDeleteEligibility(id: string): Promise<{ canHardDelete: boolean; reason?: string }> {
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        variants: {
          include: {
            stocks: true,
            transactions: { take: 1 },
            purchaseOrderItems: {
              include: { po: true },
            },
            stockCountItems: { take: 1 }
          }
        }
      }
    });

    if (!product) {
      return { canHardDelete: false, reason: "Product not found" };
    }

    // 1. Check wait period if trashed
    if (product.status === 'TRASHED' && product.trashedAt) {
      const daysSinceTrashed = (new Date().getTime() - new Date(product.trashedAt).getTime()) / (1000 * 3600 * 24);
      if (daysSinceTrashed < 7) {
        return { canHardDelete: false, reason: "Product must remain in Trash for 7 days before permanent deletion" };
      }
    } else if (product.status !== 'TRASHED') {
      return { canHardDelete: false, reason: "Product must be Trashed before permanent deletion" };
    }

    // 2. Check variants history
    for (const variant of product.variants as any[]) {
      const globalQty = variant.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0);
      if (globalQty > 0) {
        return { canHardDelete: false, reason: "Product still has stock on hand" };
      }
      if (variant.transactions.length > 0) {
        return { canHardDelete: false, reason: "Inventory transactions exist" };
      }
      if (variant.stockCountItems.length > 0) {
        return { canHardDelete: false, reason: "Stock count audit records exist" };
      }
      if (variant.purchaseOrderItems.length > 0) {
        // Technically the user said any PO item blocks it, but also specifically mentioned open POs.
        // We will block if ANY purchase order item references this product.
        return { canHardDelete: false, reason: "Purchase orders reference this product" };
      }
    }

    return { canHardDelete: true };
  }

  async findById(id: string, clientId: string): Promise<any> {
    const product = await prisma.product.findFirst({
      where: { id, clientId },
      include: { variants: { include: { stocks: true } } }
    });
    
    if (!product) return null;

    const variantCount = product.variants.length;
    const totalUnits = product.variants.reduce((sum, v) => sum + v.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0), 0);
    const lowStockVariants = product.variants.filter((v) => v.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0) <= v.reorderLevel).length;

    // Exclude the raw variants array from the response to keep it clean, just send summary
    const { variants, ...productWithoutVariants } = product;
    
    const eligibility = await this.checkHardDeleteEligibility(id);

    return {
      ...productWithoutVariants,
      variantSummary: {
        variantCount,
        totalUnits,
        lowStockVariants
      },
      canHardDelete: eligibility.canHardDelete,
      hardDeleteReason: eligibility.reason
    };
  }

  // Workaround for Prisma update needing a unique constraint.
  // We first ensure the record exists for this client.
  async updateSafe(id: string, clientId: string, data: Prisma.ProductUpdateInput): Promise<Product> {
    const existing = await this.findById(id, clientId);
    if (!existing) throw new Error("Product not found");

    return prisma.product.update({
      where: { id },
      data
    });
  }

  async hardDelete(id: string, clientId: string): Promise<Product> {
    const existing = await this.findById(id, clientId);
    if (!existing) throw new Error("Product not found");

    const eligibility = await this.checkHardDeleteEligibility(id);
    if (!eligibility.canHardDelete) {
      throw new Error(`Cannot delete product: ${eligibility.reason}`);
    }

    // Prisma Cascade delete on Product Variant will delete variants, images.
    // Assuming schema has onDelete: Cascade for Product -> Variants and Product -> Images
    return prisma.product.delete({
      where: { id }
    });
  }
}

export const productRepository = new ProductRepository();
