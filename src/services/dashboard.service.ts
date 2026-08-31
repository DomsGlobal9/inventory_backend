import { prisma } from '../lib/prisma';

export class DashboardService {
  
  async getSummary(clientId: string) {
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
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId} 
          AND p.status != 'TRASHED' 
          AND COALESCE(s.qty, 0) <= v.reorder_level
      `.then((res: any) => res?.[0]?.count || 0),
      prisma.inventoryStock.aggregate({
        where: { clientId, variant: { product: { status: { notIn: ['TRASHED'] } } } },
        _sum: { quantity: true }
      }),
      prisma.inventoryTransaction.findMany({
        where: { variant: { clientId } },
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
      // Open Purchase Orders
      prisma.purchaseOrder.count({
        where: {
          clientId,
          status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] }
        }
      }),
      // Total Suppliers
      prisma.supplier.count({
        where: { clientId, isActive: true }
      }),
      // Pending Receipts
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
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} GROUP BY variant_id) s ON s.variant_id = v.id
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
