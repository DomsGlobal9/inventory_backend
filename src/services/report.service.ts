import { prisma } from '../lib/prisma';
import { TransactionType } from '@prisma/client';

export class ReportService {
  async getDashboardSummary(clientId: string) {
    const products = await prisma.product.count({ where: { clientId, status: 'ACTIVE' } });
    const variants = await prisma.productVariant.aggregate({
      where: { clientId },
      _sum: { inventoryValue: true }
    });

    const openPos = await prisma.purchaseOrder.aggregate({
      where: { clientId, status: { in: ['SENT', 'PARTIALLY_RECEIVED'] } },
      _sum: { totalAmount: true }
    });

    const lowStockCountRes = await prisma.$queryRaw<any[]>`
      SELECT COUNT(*) as count 
      FROM "inventory_product_variants" 
      WHERE "client_id" = ${clientId} 
      AND "quantity" <= "reorder_level"
      AND "reorder_level" > 0;
    `;

    const deadStockValueRes = await prisma.$queryRaw<any[]>`
      SELECT SUM(inventory_value) as value
      FROM "inventory_product_variants"
      WHERE "client_id" = ${clientId}
      AND "quantity" > 0
      AND "last_movement_at" IS NOT NULL
      AND "last_movement_at" < NOW() - INTERVAL '90 days';
    `;

    return {
      inventoryValue: Number(variants._sum.inventoryValue || 0),
      openPoValue: Number(openPos._sum.totalAmount || 0),
      lowStockCount: Number(lowStockCountRes[0].count),
      deadStockValue: Number(deadStockValueRes[0].value || 0),
      activeProducts: products
    };
  }

  async getOpenPoValue(clientId: string) {
    const openPos = await prisma.purchaseOrder.aggregate({
      where: { clientId, status: { in: ['SENT', 'PARTIALLY_RECEIVED'] } },
      _sum: { totalAmount: true }
    });
    return { openPoValue: Number(openPos._sum.totalAmount || 0) };
  }

  async getLowStockValue(clientId: string) {
    // We fetch variants where quantity <= reorderLevel
    const lowStockVariants = await prisma.productVariant.findMany({
      where: {
        clientId,
        reorderLevel: { gt: 0 }
      }
    });

    const actualLowStock = lowStockVariants.filter((v: any) => v.quantity <= v.reorderLevel);
    
    let lowStockValue = 0;
    let reorderExposure = 0;

    for (const v of actualLowStock) {
      lowStockValue += Number(v.inventoryValue);
      const avgCost = Number(v.averageCost);
      if (v.reorderQty && v.reorderQty > 0) {
        reorderExposure += v.reorderQty * avgCost;
      } else {
        reorderExposure += Math.max(v.reorderLevel - v.quantity, 0) * avgCost;
      }
    }

    return {
      lowStockCount: actualLowStock.length,
      lowStockValue,
      reorderExposure
    };
  }

  async getMovementAging(clientId: string) {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT 
        CASE 
          WHEN "last_movement_at" >= NOW() - INTERVAL '30 days' THEN '0-30'
          WHEN "last_movement_at" >= NOW() - INTERVAL '60 days' THEN '31-60'
          WHEN "last_movement_at" >= NOW() - INTERVAL '90 days' THEN '61-90'
          ELSE '90+'
        END as "ageBracket",
        SUM(inventory_value) as "totalValue",
        COUNT(*) as "variantCount"
      FROM "inventory_product_variants"
      WHERE "client_id" = ${clientId} AND "quantity" > 0 AND "last_movement_at" IS NOT NULL
      GROUP BY "ageBracket"
    `;

    return rows.map(r => ({
      ageBracket: r.ageBracket,
      totalValue: Number(r.totalValue),
      variantCount: Number(r.variantCount)
    }));
  }

  async getInventorySummary(clientId: string) {
    const products = await prisma.product.count({ where: { clientId, status: 'ACTIVE' } });
    const variants = await prisma.productVariant.aggregate({
      where: { clientId },
      _sum: { quantity: true, inventoryValue: true },
      _count: { id: true }
    });

    const lowStockCount = await prisma.$queryRaw<any[]>`
      SELECT COUNT(*) as count 
      FROM "inventory_product_variants" 
      WHERE "client_id" = ${clientId} 
      AND "quantity" <= "reorder_level"
      AND "reorder_level" > 0;
    `;

    return {
      totalProducts: products,
      totalVariants: variants._count.id,
      totalUnits: Number(variants._sum.quantity || 0),
      totalValue: Number(variants._sum.inventoryValue || 0),
      lowStockItems: Number(lowStockCount[0].count)
    };
  }

  async getDeadStock(clientId: string, thresholdDays: number = 90) {
    // Using last_movement_at instead of lastReceivedAt
    const rawRows = await prisma.$queryRaw<any[]>`
      SELECT v.id, v.sku, v.quantity, v.inventory_value, v.last_movement_at, p.title as "productTitle", p.category
      FROM "inventory_product_variants" v
      LEFT JOIN "inventory_products" p ON v.product_id = p.id
      WHERE v.client_id = ${clientId}
      AND v.quantity > 0
      AND v.last_movement_at IS NOT NULL
      AND v.last_movement_at < NOW() - INTERVAL '90 days'
      ORDER BY v.inventory_value DESC
      LIMIT 50;
    `;

    return rawRows.map((item: any) => ({
      id: item.id,
      sku: item.sku,
      productTitle: item.productTitle,
      category: item.category,
      quantity: item.quantity,
      inventoryValue: Number(item.inventory_value),
      daysSinceLastMovement: item.last_movement_at ? Math.floor((new Date().getTime() - new Date(item.last_movement_at).getTime()) / (1000 * 3600 * 24)) : null
    }));
  }

  async getSupplierSpend(clientId: string) {
    const spend = await prisma.purchaseOrder.groupBy({
      by: ['supplierId'],
      where: {
        clientId,
        status: { in: ['RECEIVED', 'PARTIALLY_RECEIVED'] }
      },
      _sum: {
        totalAmount: true
      }
    });

    const supplierIds = spend.map(s => s.supplierId);
    const suppliers = await prisma.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, name: true, supplierCode: true }
    });

    const supplierMap = new Map(suppliers.map(s => [s.id, s]));

    return spend.map(s => {
      const supplier = supplierMap.get(s.supplierId);
      return {
        supplierId: s.supplierId,
        supplierName: supplier?.name || 'Unknown',
        supplierCode: supplier?.supplierCode || 'N/A',
        totalSpend: Number(s._sum.totalAmount || 0)
      };
    }).sort((a, b) => b.totalSpend - a.totalSpend);
  }

  async getStockMovement(clientId: string, days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const movements = await prisma.inventoryTransaction.groupBy({
      by: ['type'],
      where: {
        clientId,
        createdAt: { gte: startDate }
      },
      _sum: {
        quantity: true
      },
      _count: {
        id: true
      }
    });

    return movements.map(m => ({
      type: m.type,
      totalQuantity: Number(m._sum.quantity || 0),
      transactionCount: m._count.id
    }));
  }

  async getRecentTransactions(clientId: string, limit: number = 10) {
    const txs = await prisma.inventoryTransaction.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        variant: {
          include: {
            product: {
              select: { title: true }
            }
          }
        }
      }
    });

    return txs.map(tx => ({
      id: tx.id,
      date: tx.createdAt,
      type: tx.type,
      product: tx.variant?.product?.title || 'Unknown Product',
      sku: tx.variant?.sku || 'N/A',
      quantity: tx.quantity
    }));
  }

  async getSnapshots(clientId: string, days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    return prisma.dailyInventorySnapshot.findMany({
      where: {
        clientId,
        snapshotDate: { gte: startDate }
      },
      orderBy: { snapshotDate: 'asc' }
    });
  }
}

export const reportService = new ReportService();
