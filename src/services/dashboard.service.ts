import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';

export class DashboardService {

  async getSummary(clientId: string, locationId?: string) {
    const stockJoinFilter = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;

    const [
      totalProducts,
      activeProducts,
      lowStockVariants, // Deprecated in favor of criticalStockItems
      totalInventoryAgg,
      recentTransactions,
      openPurchaseOrders,
      totalSuppliers,
      pendingReceiptsAgg,
      inventoryValueResult
    ] = await Promise.all([
      prisma.product.count({
        where: { clientId, status: { notIn: ['TRASHED'] } }
      }),
      prisma.product.count({
        where: { clientId, status: 'ACTIVE' }
      }),
      prisma.$queryRaw`
        SELECT COUNT(*)::int as count
        FROM inventory_product_variants v
        JOIN inventory_products p ON v.product_id = p.id
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId}
          AND p.status != 'TRASHED'
          AND COALESCE(s.qty, 0) <= v.reorder_level
      `.then((res: any) => res?.[0]?.count || 0),
      prisma.inventoryStock.aggregate({
        where: { clientId, variant: { product: { status: { notIn: ['TRASHED'] } } }, ...(locationId ? { locationId } : {}) },
        _sum: { quantity: true }
      }),
      prisma.inventoryTransaction.findMany({
        where: { variant: { clientId }, ...(locationId ? { locationId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          variant: {
            include: {
              product: { select: { title: true, productCode: true } }
            }
          }
        }
      }),
      // Open Purchase Orders - not location-scoped (a PO isn't "at" a location until received)
      prisma.purchaseOrder.count({
        where: {
          clientId,
          status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] }
        }
      }),
      // Total Suppliers - not location-scoped (catalog-level entity)
      prisma.supplier.count({
        where: { clientId, isActive: true }
      }),
      // Pending Receipts - not location-scoped (POs aren't location-specific pre-receipt)
      prisma.purchaseOrderItem.aggregate({
        where: {
          po: {
            clientId,
            status: { in: ['SENT', 'PARTIALLY_RECEIVED'] }
          }
        },
        _sum: {
          orderedQty: true,
          receivedQty: true
        }
      }),
      // Inventory Value
      prisma.$queryRaw`
        SELECT SUM(COALESCE(s.qty, 0) * COALESCE(v.last_purchase_cost, v.cost_price, v.compare_at_price, 0)) as "totalValue"
        FROM inventory_product_variants v
        JOIN inventory_products p ON v.product_id = p.id
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId} AND p.status != 'TRASHED'
      `
    ]);

    const inventoryValue = inventoryValueResult && Array.isArray(inventoryValueResult) && inventoryValueResult[0]?.totalValue
      ? Number(inventoryValueResult[0].totalValue)
      : 0;

    const ordered = pendingReceiptsAgg?._sum?.orderedQty || 0;
    const received = pendingReceiptsAgg?._sum?.receivedQty || 0;
    const pendingReceipts = Math.max(0, ordered - received);

    return {
      totalProducts,
      activeProducts,
      criticalStockItems: lowStockVariants,
      totalUnits: totalInventoryAgg._sum.quantity || 0,
      inventoryValue,
      openPurchaseOrders,
      pendingReceipts,
      totalSuppliers,
      recentTransactions
    };
  }
}

export const dashboardService = new DashboardService();
