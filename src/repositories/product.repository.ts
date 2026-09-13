import { prisma } from '../lib/prisma';
import { isLowStock } from '../lib/lowStock';
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
        // Only the three fields the summary below actually reads.
        //
        // This was `include: { variants: { include: { stocks: true } } }`, which fetched every
        // column of every variant and every stock row -- for a page of 20 products with ten
        // variants across three locations, six hundred full stock rows and two hundred full
        // variant rows -- to produce three integers per product. Everything else was dropped
        // on the next line. Over a link where the database is on another continent, that
        // payload is most of what the page waits for.
        include: {
          variants: {
            select: {
              reorderLevel: true,
              stocks: { select: { quantity: true } },
              // Per variant, so the list can say how many SIZES AND COLOURS have no
              // photograph rather than only whether the product has any at all. A saree with
              // three photos of the red one and none of the blue passes the coarse test and
              // still shows a customer the wrong colour.
              _count: { select: { images: true } }
            }
          },
          // A count, not the rows. Publishing in bulk has to be able to say how many of the
          // selected products would go live with no photograph of them, and scrolling the
          // list to find out is not an answer for a merchant with 123 drafts.
          _count: { select: { images: true } }
        }
      }),
      prisma.product.count({ where })
    ]);

    const data = rawData.map(product => {
      const variantCount = product.variants.length;
      const totalUnits = product.variants.reduce((sum, v) => sum + v.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0), 0);
      // isLowStock, not a comparison written out again here. This was the third definition of
      // the rule in the codebase, and the one nobody looked at: `qty <= reorderLevel` counts a
      // variant with a reorder level of 0 -- meaning "do not chase me about this one" -- as low
      // the moment it reaches zero stock, which is a different state raised separately.
      const lowStockVariants = product.variants.filter((v) =>
        isLowStock(v.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0), v.reorderLevel)
      ).length;
      
      const variantsWithoutImages = product.variants.filter((v: any) => (v._count?.images ?? 0) === 0).length;

      const { variants, _count, ...rest } = product as any;
      return {
        ...rest,
        imageCount: _count?.images ?? 0,
        variantSummary: { variantCount, totalUnits, lowStockVariants, variantsWithoutImages }
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
    const lowStockVariants = product.variants.filter((v) =>
      isLowStock(v.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0), v.reorderLevel)
    ).length;

    // Exclude the raw variants array from the response to keep it clean, just send summary
    const { variants, ...productWithoutVariants } = product;
    
    /*
     * Whether it can be deleted for good -- answered from what is already loaded when it can be.
     *
     * The full check loads the product again with its stock, transactions, purchase-order lines and
     * stock counts: several round trips to a database on another continent, on EVERY product page.
     * But it can only ever say yes for a product that has sat in the bin for a week; for anything
     * else the answer is known from the status alone. Only that case pays for the full check.
     */
    // The shortcut answers exactly as the full check would, and only where it is sure: not binned,
    // or binned less than a week ago. A binned product with no bin date skips the wait in the full
    // check, so that case -- like a week in the bin -- still asks it.
    const binnedRecently = product.status === 'TRASHED' && product.trashedAt
      && (Date.now() - new Date(product.trashedAt).getTime()) / 86_400_000 < 7;
    const eligibilityQuery: Promise<{ canHardDelete: boolean; reason?: string }> =
      product.status !== 'TRASHED'
        ? Promise.resolve({ canHardDelete: false, reason: 'Product must be Trashed before permanent deletion' })
        : binnedRecently
          ? Promise.resolve({ canHardDelete: false, reason: 'Product must remain in Trash for 7 days before permanent deletion' })
          : this.checkHardDeleteEligibility(id);

    /*
     * How many sizes and colours have no photograph of their own.
     *
     * "This product has five photos" is not the useful number for a shop selling one saree in
     * five colours -- all five could be of the red one, and the customer choosing blue sees a
     * red saree. This is the number that belongs at the top of the page, where somebody will
     * see it before they publish rather than after a customer does.
     *
     * `distinct` on variantId, so one variant with four photos counts once.
     */
    const variantIds = product.variants.map(v => v.id);
    // All three at once; none depends on another.
    const [eligibility, imageCount, photographed] = await Promise.all([
      eligibilityQuery,
      // How many photographs it has. A count, not the rows -- the page has an Images tab that
      // fetches those itself. Publishing needs to know whether there are any at all.
      prisma.productImage.count({ where: { productId: id } }),
      variantIds.length
        ? prisma.productImage.findMany({
            where: { variantId: { in: variantIds } },
            select: { variantId: true },
            distinct: ['variantId']
          })
        : Promise.resolve([] as { variantId: string | null }[])
    ]);
    const variantsWithoutImages = variantIds.length - photographed.length;

    return {
      ...productWithoutVariants,
      variantSummary: {
        variantCount,
        totalUnits,
        lowStockVariants,
        variantsWithoutImages
      },
      imageCount,
      canHardDelete: eligibility.canHardDelete,
      hardDeleteReason: eligibility.reason
    };
  }

  // Workaround for Prisma update needing a unique constraint.
  // We first ensure the record exists for this client.
  async updateSafe(id: string, clientId: string, data: Prisma.ProductUpdateInput): Promise<Product> {
    const existing = await this.findById(id, clientId);
    if (!existing) throw { statusCode: 404, message: "Product not found" };

    return prisma.product.update({
      where: { id },
      data
    });
  }

  async hardDelete(id: string, clientId: string): Promise<Product> {
    const existing = await this.findById(id, clientId);
    if (!existing) throw { statusCode: 404, message: "Product not found" };

    const eligibility = await this.checkHardDeleteEligibility(id);
    if (!eligibility.canHardDelete) {
      throw { statusCode: 400, message: `Cannot delete product: ${eligibility.reason}` };
    }

    // Prisma Cascade delete on Product Variant will delete variants, images.
    // Assuming schema has onDelete: Cascade for Product -> Variants and Product -> Images
    return prisma.product.delete({
      where: { id }
    });
  }
}

export const productRepository = new ProductRepository();
