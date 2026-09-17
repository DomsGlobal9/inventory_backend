import { prisma } from '../lib/prisma';
import { isLowStock, lowStockSql, outOfStockSql } from '../lib/lowStock';
import { UNIT_COST, PRICED_NOT_COSTED, inventoryValueFor } from '../lib/inventoryValuation';
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
    //
    // What a unit is worth, in order of how well we know it:
    //
    //   average_cost        the weighted average of what was actually paid, kept by
    //                       inventory-mutation.service. Only written when a stock-in carried a
    //                       unit cost -- and that field is optional in the Stock In form.
    //   last_purchase_cost  what the most recent purchase order paid.
    //   cost_price          what the shopkeeper typed on the product itself.
    //   selling_price       the variant's own price.
    //   base_price          the product's price, which the Add Product wizard always asks for
    //                       and so is the one figure that is effectively never missing.
    //
    // Only average_cost used to count, so a shop that received stock without filling in the
    // optional cost box saw INVENTORY VALUE ₹0 on the dashboard while holding real, costed
    // stock -- one live tenant had ₹45,000 cost recorded on the product and a ₹0 headline.
    // That reads as a broken app, and it is the first number a shopkeeper looks at. NULLIF
    // is what makes the fallback work: average_cost defaults to 0 rather than NULL, so a
    // plain COALESCE would stop at the zero and never reach the figures below it.
    //
    // The last two entries are PRICES, not costs, so a shop that has never recorded a cost is
    // valued at what it sells for rather than at nothing. That overstates the figure by the
    // margin, which is why unitsValuedAtPrice is reported alongside and the tile says so --
    // an unexplained number is the thing to avoid, in either direction.
    // The ONE definition, imported rather than repeated. A copy here is what let this chain
    // and the console's drift apart until five tenants saw two different inventory values
    // depending on which screen they opened. See lib/inventoryValuation.ts.
    const unitCost = UNIT_COST;
    /*
     * FOURTH TIME, and the same shape as the other three.
     *
     * UNIT_COST was moved into lib/inventoryValuation so the console and the dashboard could not
     * drift -- but the CAVEAT beside it was left as a local copy, and it drifted anyway. The
     * copy dropped NULLIF from last_purchase_cost and cost_price (so a column holding 0 rather
     * than NULL counted as "a cost was recorded") and left out compare_at_price entirely. On
     * demo-client the two screens reported 501 and 509 units valued at a price.
     *
     * Imported now, like UNIT_COST, so there is one definition of each.
     */
    const pricedNotCosted = PRICED_NOT_COSTED;

    /*
     * Trashed products are not stock.
     *
     * inventoryValueFor ends `AND p.status != 'TRASHED'`; these queries joined the products
     * table and never filtered on it. So a merchant's own dashboard valued goods they had
     * thrown away while the platform console did not -- demo-client differed by ₹1,98,700 across
     * 8 units, which is exactly the "two screens, two numbers" failure lib/inventoryValuation
     * exists to prevent.
     *
     * One fragment, used by every query below, so the next one added cannot forget it.
     */
    const notTrashed = Prisma.sql`AND p.status != 'TRASHED'`;

    const valueQuery = locationId
      ? prisma.$queryRaw<any[]>`
          SELECT SUM(s.quantity * ${unitCost}) as value
          FROM "inventory_stocks" s
          JOIN "inventory_product_variants" v ON v.id = s.variant_id
          JOIN "inventory_products" p ON p.id = v.product_id
          WHERE s.client_id = ${clientId} AND s.location_id = ${locationId} ${notTrashed};
        `.then(rows => Number(rows[0]?.value || 0))
      : prisma.$queryRaw<any[]>`
          SELECT SUM(COALESCE(s.qty, 0) * ${unitCost}) as value
          FROM "inventory_product_variants" v
          JOIN "inventory_products" p ON p.id = v.product_id
          LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} GROUP BY variant_id) s ON s.variant_id = v.id
          WHERE v.client_id = ${clientId} ${notTrashed};
        `.then(rows => Number(rows[0]?.value || 0));

    const [products, openPos, inventoryValue, lowStockCountRes, deadStockValueRes, uncostedRes] =
      await Promise.all([
      prisma.product.count({ where: { clientId, status: 'ACTIVE' } }),
      prisma.purchaseOrder.aggregate({
        where: { clientId, status: { in: ['SENT', 'PARTIALLY_RECEIVED'] } },
        _sum: { totalAmount: true }
      }),
      valueQuery,
      /*
       * Low and out, counted together but never summed.
       *
       * Scoped to ACTIVE and DRAFT products -- the same set the Inventory Overview's Low Stock and
       * Out of Stock filters show, since that is where the tile sends you. This count used to
       * include trashed and archived products, so the tile could say 195 and the list it opened
       * show a different number.
       */
      prisma.$queryRaw<any[]>`
        SELECT
          COUNT(*) FILTER (WHERE ${lowStockSql(Prisma.sql`COALESCE(s.qty, 0)`)})::int as count,
          COUNT(*) FILTER (WHERE ${outOfStockSql(Prisma.sql`COALESCE(s.qty, 0)`)})::int as "outOfStock"
        FROM "inventory_product_variants" v
        JOIN "inventory_products" p ON p.id = v.product_id
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId}
        AND p.status IN ('ACTIVE', 'DRAFT');
      `,
      // Same valuation basis as the headline figure above -- two different answers to "what is
      // this stock worth" on the same screen is worse than either answer alone.
      prisma.$queryRaw<any[]>`
        SELECT SUM(COALESCE(s.qty, 0) * ${unitCost}) as value
        FROM "inventory_product_variants" v
        JOIN "inventory_products" p ON p.id = v.product_id
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId} ${notTrashed}
        AND COALESCE(s.qty, 0) > 0
        AND v.last_movement_at IS NOT NULL
        AND v.last_movement_at < NOW() - INTERVAL '90 days';
      `,
      // Two ways the headline can mislead, counted so the tile can say which applies:
      //   units       -- nothing at all was known, so they count as ₹0 and the total is low.
      //   pricedUnits -- only a selling price was known, so they are valued at what they sell
      //                  for and the total is high by the margin.
      // Either way the shopkeeper is told, rather than left to work out why the number does
      // not match what is on the shelf.
      prisma.$queryRaw<any[]>`
        SELECT
          COALESCE(SUM(CASE WHEN ${unitCost} = 0 THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::int as units,
          COALESCE(SUM(CASE WHEN ${pricedNotCosted} THEN COALESCE(s.qty, 0) ELSE 0 END), 0)::int as "pricedUnits"
        FROM "inventory_product_variants" v
        JOIN "inventory_products" p ON p.id = v.product_id
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId} ${notTrashed}
        AND COALESCE(s.qty, 0) > 0;
      `
    ]);

    // What the WHOLE business holds, when a location is selected and there is more than one.
    //
    // The headline above is scoped to the chosen location, which is right for a shopkeeper
    // standing in that shop. But there is no "all locations" to choose, so a merchant with two
    // shops could never see their own total -- while the platform console, which is not scoped
    // to a location, showed it. sphl's dashboard read 20,73,986 and the console 41,47,972, and
    // both were correct. That is the worst kind of disagreement: nothing is broken, so there is
    // nothing to find, and the merchant is left believing one of their screens is lying.
    //
    // Null when it would only repeat the headline, so the extra line appears solely for shops
    // it tells something new.
    let companyWideValue: number | null = null;
    if (locationId) {
      const locationCount = await prisma.stockLocation.count({ where: { clientId } });
      if (locationCount > 1) {
        companyWideValue = await inventoryValueFor(clientId);
      }
    }

    return {
      inventoryValue,
      companyWideValue,
      unitsWithoutCost: Number(uncostedRes[0]?.units || 0),
      unitsValuedAtPrice: Number(uncostedRes[0]?.pricedUnits || 0),
      openPoValue: Number(openPos._sum.totalAmount || 0),
      lowStockCount: Number(lowStockCountRes[0].count),
      outOfStockCount: Number(lowStockCountRes[0].outOfStock),
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

    const scoped = lowStockVariants.map(v => {
      const scopedStocks = locationId ? v.stocks.filter(s => s.locationId === locationId) : v.stocks;
      const qty = scopedStocks.reduce((acc, s) => acc + s.quantity, 0);
      return { ...v, quantity: qty, inventoryValue: locationId ? qty * Number(v.averageCost) : v.inventoryValue };
    });

    // Tracked variants that need buying: low ones AND sold-out ones. Reorder exposure covers
    // both -- an item that has run out needs reordering more than one that is merely low -- but
    // the COUNT and VALUE of low stock are only the low ones, so this figure and the dashboard
    // tile say the same thing.
    const needsReorder = scoped.filter((v: any) => v.quantity <= v.reorderLevel);
    const actualLowStock = scoped.filter((v: any) => isLowStock(v.quantity, v.reorderLevel));
    const outOfStockCount = scoped.filter((v: any) => v.quantity <= 0).length;

    let lowStockValue = 0;
    let reorderExposure = 0;

    for (const v of actualLowStock) {
      lowStockValue += Number(v.inventoryValue);
    }

    for (const v of needsReorder) {
      const avgCost = Number(v.averageCost);
      if (v.reorderQty && v.reorderQty > 0) {
        reorderExposure += v.reorderQty * avgCost;
      } else {
        reorderExposure += Math.max(v.reorderLevel - v.quantity, 0) * avgCost;
      }
    }

    return {
      lowStockCount: actualLowStock.length,
      outOfStockCount,
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
        JOIN "inventory_products" p ON p.id = v.product_id
        LEFT JOIN (SELECT variant_id, SUM(quantity) as qty FROM inventory_stocks WHERE client_id = ${clientId} ${stockJoinFilter} GROUP BY variant_id) s ON s.variant_id = v.id
        WHERE v.client_id = ${clientId}
        AND p.status IN ('ACTIVE', 'DRAFT')
        AND ${lowStockSql(Prisma.sql`COALESCE(s.qty, 0)`)};
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
        // Moves between shelves carry quantity 0 and would only inflate the count of movements.
        reason: { not: 'SHELF_MOVE' },
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
      // Stock that came in or went out; tidying shelves would push real movements off the list.
      where: { clientId, reason: { not: 'SHELF_MOVE' }, ...(locationId ? { locationId } : {}) },
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
