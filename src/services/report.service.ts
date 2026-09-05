import { prisma } from '../lib/prisma';
import { TransactionType, Prisma } from '@prisma/client';

export class ReportService {
  /**
   * The dashboard's headline tiles.
   *
   * As with getInventorySummary, these reads do not depend on one another, so they go out
   * together rather than one per round trip -- this is the app's landing page and was costing
   * about 7.2 seconds against the production database.
   */
  async getDashboardSummary(clientId: string, locationId?: string) {
    const stockJoinFilter = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;

    // Catalog-level and pre-receipt PO figures aren't meaningful per-location, so they stay
    // tenant-wide even when a location is selected.
    const valueQuery = locationId
      ? prisma.$queryRaw<any[]>`
          SELECT SUM(s.quantity * v.average_cost) as value
          FROM "inventory_stocks" s
          JOIN "inventory_product_variants" v ON v.id = s.variant_id
          WHERE s.client_id = ${clientId} AND s.location_id = ${locationId};
        `.then(rows => Number(rows[0]?.value || 0))
      : prisma.productVariant.aggregate({
          where: { clientId }, _sum: { inventoryValue: true }
        }).then(agg => Number(agg._sum.inventoryValue || 0));

    const [products, openPos, inventoryValue, lowStockCountRes, deadStockValueRes] = await Promise.all([
      prisma.product.count({ where: { clientId, status: 'ACTIVE' } }),
      prisma.purchaseOrder.aggregate({
        where: { clientId, status: { in: ['SENT', 'PARTIALLY_RECEIVED'] } },
        _sum: { totalAmount: true }
      }),
      valueQuery,
      prisma.$queryRaw<any[]>`
        SELECT COUNT(*)::int as count
        FROM "inventory_product_variants" v
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId}
        AND COALESCE(s.qty, 0) <= v.reorder_level
        AND v.reorder_level > 0;
      `,
      prisma.$queryRaw<any[]>`
        SELECT SUM(COALESCE(s.qty, 0) * v.average_cost) as value
        FROM "inventory_product_variants" v
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId}
        AND COALESCE(s.qty, 0) > 0
        AND v.last_movement_at IS NOT NULL
        AND v.last_movement_at < NOW() - INTERVAL '90 days';
      `
    ]);

    return {
      inventoryValue,
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

  async getLowStockValue(clientId: string, locationId?: string) {
    // We fetch variants where quantity <= reorderLevel
    const lowStockVariants = await prisma.productVariant.findMany({
      where: {
        clientId,
        reorderLevel: { gt: 0 }
      },
      include: { stocks: true }
    });

    const actualLowStock = lowStockVariants.map(v => {
      const scopedStocks = locationId ? v.stocks.filter(s => s.locationId === locationId) : v.stocks;
      const qty = scopedStocks.reduce((acc, s) => acc + s.quantity, 0);
      return { ...v, quantity: qty, inventoryValue: locationId ? qty * Number(v.averageCost) : v.inventoryValue };
    }).filter((v: any) => v.quantity <= v.reorderLevel);
    
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

  async getMovementAging(clientId: string, locationId?: string) {
    const stockJoinFilter = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;
    const rows = await prisma.$queryRaw<any[]>`
      SELECT
        CASE
          WHEN v.last_movement_at >= NOW() - INTERVAL '30 days' THEN '0-30'
          WHEN v.last_movement_at >= NOW() - INTERVAL '60 days' THEN '31-60'
          WHEN v.last_movement_at >= NOW() - INTERVAL '90 days' THEN '61-90'
          ELSE '90+'
        END as "ageBracket",
        SUM(COALESCE(s.qty, 0) * v.average_cost) as "totalValue",
        COUNT(v.id) as "variantCount"
      FROM "inventory_product_variants" v
      LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
      WHERE v.client_id = ${clientId} AND COALESCE(s.qty, 0) > 0 AND v.last_movement_at IS NOT NULL
      GROUP BY "ageBracket"
    `;

    return rows.map(r => ({
      ageBracket: r.ageBracket,
      totalValue: Number(r.totalValue),
      variantCount: Number(r.variantCount)
    }));
  }

  /**
   * Headline figures for the reports page.
   *
   * The five reads are independent of each other, so they are issued together. Awaited one at
   * a time this endpoint cost five sequential round trips -- about 7.4 seconds against the
   * production database, measured warm -- for work that takes as long as its slowest single
   * query when run in parallel.
   */
  async getInventorySummary(clientId: string, locationId?: string) {
    const stockJoinFilter = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;

    // averageCost is a company-wide weighted average rather than per-location, so a scoped
    // value is this location's quantity times that average -- the same convention the
    // dashboard and category figures use, so the numbers reconcile across the page.
    const valueQuery = locationId
      ? prisma.$queryRaw<any[]>`
          SELECT SUM(s.quantity * v.average_cost) as value
          FROM "inventory_stocks" s
          JOIN "inventory_product_variants" v ON v.id = s.variant_id
          WHERE s.client_id = ${clientId} AND s.location_id = ${locationId};
        `.then(rows => Number(rows[0]?.value || 0))
      : prisma.productVariant.aggregate({
          where: { clientId }, _sum: { inventoryValue: true }
        }).then(agg => Number(agg._sum.inventoryValue || 0));

    const [products, variants, stocks, lowStockCount, totalValue] = await Promise.all([
      prisma.product.count({ where: { clientId, status: 'ACTIVE' } }),
      prisma.productVariant.aggregate({ where: { clientId }, _count: { id: true } }),
      prisma.inventoryStock.aggregate({
        where: { clientId, ...(locationId ? { locationId } : {}) },
        _sum: { quantity: true }
      }),
      prisma.$queryRaw<any[]>`
        SELECT COUNT(*)::int as count
        FROM "inventory_product_variants" v
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId}
        AND COALESCE(s.qty, 0) <= v.reorder_level
        AND v.reorder_level > 0;
      `,
      valueQuery
    ]);

    return {
      totalProducts: products,
      totalVariants: variants._count.id,
      totalUnits: Number(stocks._sum.quantity || 0),
      totalValue,
      lowStockItems: Number(lowStockCount[0].count)
    };
  }

  async getDeadStock(clientId: string, thresholdDays: number = 90, locationId?: string) {
    const stockJoinFilter = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;
    const rawRows = await prisma.$queryRaw<any[]>`
      SELECT v.id, v.sku, COALESCE(s.qty, 0) as quantity, COALESCE(s.qty, 0) * v.average_cost as inventory_value, v.last_movement_at, p.title as "productTitle", p.category
      FROM "inventory_product_variants" v
      LEFT JOIN "inventory_products" p ON v.product_id = p.id
      LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
      WHERE v.client_id = ${clientId}
      AND COALESCE(s.qty, 0) > 0
      AND v.last_movement_at IS NOT NULL
      AND v.last_movement_at < NOW() - make_interval(days => ${thresholdDays}::int)
      ORDER BY inventory_value DESC
      LIMIT 50;
    `;

    return rawRows.map((item: any) => ({
      id: item.id,
      sku: item.sku,
      productTitle: item.productTitle,
      category: item.category,
      // SUM() over an integer column comes back from Postgres as bigint, which Prisma hands
      // over as a JS BigInt and JSON.stringify refuses to serialize. Left unconverted this
      // endpoint returns 500 for exactly the tenants it is meant to help -- the ones that
      // actually have dead stock -- and 200 for the ones that have none.
      quantity: Number(item.quantity),
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
      where: { id: { in: supplierIds }, clientId },
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

  async getStockMovement(clientId: string, days: number = 30, locationId?: string) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const movements = await prisma.inventoryTransaction.groupBy({
      by: ['type'],
      where: {
        clientId,
        createdAt: { gte: startDate },
        ...(locationId ? { locationId } : {})
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

  async getRecentTransactions(clientId: string, limit: number = 10, locationId?: string) {
    const txs = await prisma.inventoryTransaction.findMany({
      where: { clientId, ...(locationId ? { locationId } : {}) },
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
