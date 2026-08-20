import { prisma } from '../lib/prisma';
import { TransactionType } from '@prisma/client';

export class InventoryRepository {
  
  async createTransaction(
    clientId: string,
    variantId: string,
    type: TransactionType,
    quantityChange: number,
    reason: any, // or InventoryReason
    reference?: string,
    notes?: string,
    createdBy?: string,
    unitCost?: number
  ) {
    // We must ensure the variant belongs to the client before updating stock
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, clientId }
    });

    if (!variant) throw new Error("Variant not found or unauthorized");

    // Execute in a transaction to guarantee atomicity
    return prisma.$transaction(async (tx) => {
      // 1. Create the audit record
      const transaction = await tx.inventoryTransaction.create({
        data: {
          clientId,
          variantId,
          type,
          reason,
          balanceBefore: variant.quantity,
          balanceAfter: variant.quantity + quantityChange,
          quantity: quantityChange, // can be positive or negative
          notes,
          createdBy
        }
      });

      // WAC Calculation Logic
      let isCostAffecting = (reason === 'INITIAL_STOCK' || reason === 'STOCK_IN' || reason === 'PURCHASE_RECEIPT');
      let costToApply = unitCost || Number((variant as any).averageCost);

      if (isCostAffecting && costToApply !== undefined) {
        // Stock Increase: Recalculate WAC
        await tx.$executeRaw`
          UPDATE "inventory_product_variants"
          SET 
            "quantity" = "quantity" + ${quantityChange},
            "inventory_value" = "inventory_value" + (${quantityChange} * ${costToApply}),
            "average_cost" = CASE 
              WHEN ("quantity" + ${quantityChange}) > 0 
              THEN ("inventory_value" + (${quantityChange} * ${costToApply})) / ("quantity" + ${quantityChange})
              ELSE "average_cost" 
            END,
            "last_cost_updated_at" = NOW(),
            "updated_at" = NOW()
          WHERE "id" = ${variantId}
        `;
      } else {
        // Stock Decrease or Adjustment Up (without explicit cost): Keep WAC, deduct value proportionally
        await tx.$executeRaw`
          UPDATE "inventory_product_variants"
          SET 
            "quantity" = "quantity" + ${quantityChange},
            "inventory_value" = ("quantity" + ${quantityChange}) * "average_cost",
            "updated_at" = NOW()
          WHERE "id" = ${variantId}
        `;
      }

      const updatedVariant = await tx.productVariant.findUnique({
        where: { id: variantId }
      });

      // Prevent negative stock
      if (!updatedVariant || updatedVariant.quantity < 0) {
        throw new Error("Insufficient stock to complete this transaction");
      }

      return { transaction, variant: updatedVariant };
    });
  }

  async getTransactions(clientId: string, filters: any = {}) {
    const { variantId, page = 1, limit = 50 } = filters;
    const skip = (page - 1) * limit;

    const where: any = { clientId };
    if (variantId) where.variantId = variantId;

    const [transactions, total] = await Promise.all([
      prisma.inventoryTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
        include: {
          variant: {
            include: {
              product: {
                select: { title: true, productCode: true }
              }
            }
          }
        }
      }),
      prisma.inventoryTransaction.count({ where })
    ]);

    return {
      data: transactions,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit))
      }
    };
  }

  async getInventoryAlerts(clientId: string) {
    // We use a raw query or Prisma's filter capabilities to find low stock.
    // Since Prisma cannot directly compare two columns in a single where clause (e.g. quantity <= reorderLevel)
    // without queryRaw in older versions, we can use $queryRaw. Wait, in Prisma 5, we can use `quantity: { lte: prisma.productVariant.fields.reorderLevel }` but it's simpler to just fetch all low stock using a raw query, or fetch everything and filter (bad at scale). Let's use raw query.
    return prisma.$queryRaw`
      SELECT 
        v.id, v.sku, v.quantity, v.reorder_level as "reorderLevel", v.variant_code as "variantCode", v.barcode, v.size, v.color_name as "colorName", v.hex_code as "hexCode",
        p.title as "productTitle", p.id as "productId"
      FROM inventory_product_variants v
      JOIN inventory_products p ON v.product_id = p.id
      WHERE v.client_id = ${clientId}
        AND p.status IN ('ACTIVE', 'ARCHIVED')
        AND v.quantity <= v.reorder_level
      ORDER BY (v.quantity::float / GREATEST(v.reorder_level, 1)) ASC
    `;
  }
}

export const inventoryRepository = new InventoryRepository();
