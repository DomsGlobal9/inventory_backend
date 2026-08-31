import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';

export class ValuationService {
  /**
   * Returns the total inventory value for the entire tenant.
   */
  async getTenantValue(clientId: string) {
    const variantResult = await prisma.productVariant.aggregate({
      where: { clientId },
      _sum: { inventoryValue: true },
      _count: { id: true }
    });

    const stockResult = await prisma.inventoryStock.aggregate({
      where: { clientId },
      _sum: { quantity: true }
    });

    return {
      totalValue: Number(variantResult._sum.inventoryValue || 0),
      totalUnits: Number(stockResult._sum.quantity || 0),
      totalVariants: variantResult._count.id
    };
  }

  /**
   * Returns the inventory value broken down by product category.
   */
  async getCategoryValue(clientId: string) {
    // Prisma group-by doesn't support relation fields directly without raw queries
    // if we want to group by Product.category.
    const result = await prisma.$queryRaw<any[]>`
      SELECT 
        p.category,
        SUM(v.inventory_value) as total_value,
        SUM(COALESCE(s.qty, 0)) as total_units
      FROM "inventory_product_variants" v
      JOIN "inventory_products" p ON v.product_id = p.id
      LEFT JOIN (
        SELECT variant_id, SUM(quantity) as qty 
        FROM inventory_stocks 
        WHERE client_id = ${clientId} 
        GROUP BY variant_id
      ) s ON s.variant_id = v.id
      WHERE v.client_id = ${clientId}
      GROUP BY p.category
      ORDER BY total_value DESC;
    `;

    return result.map(r => ({
      category: r.category,
      totalValue: Number(r.total_value),
      totalUnits: Number(r.total_units)
    }));
  }

  /**
   * Takes an end-of-day snapshot of the current inventory value.
   */
  async generateDailySnapshot(clientId: string, date: Date = new Date()) {
    const stats = await this.getTenantValue(clientId);

    // Ensure we only store one snapshot per day
    const snapshotDate = new Date(date);
    snapshotDate.setUTCHours(0, 0, 0, 0);

    return prisma.dailyInventorySnapshot.upsert({
      where: {
        clientId_snapshotDate: {
          clientId,
          snapshotDate
        }
      },
      update: {
        totalValue: stats.totalValue,
        totalUnits: stats.totalUnits,
        totalVariants: stats.totalVariants
      },
      create: {
        clientId,
        snapshotDate,
        totalValue: stats.totalValue,
        totalUnits: stats.totalUnits,
        totalVariants: stats.totalVariants
      }
    });
  }

  /**
   * Generates snapshots for a list of tenants, useful for a cron job.
   */
  async runDailyBatch(clientIds: string[]) {
    const results = [];
    for (const clientId of clientIds) {
      try {
        const snapshot = await this.generateDailySnapshot(clientId);
        results.push({ clientId, success: true, snapshot });
      } catch (error) {
        results.push({ clientId, success: false, error: (error as Error).message });
      }
    }
    return results;
  }

  /**
   * Reconciles inventory valuation by comparing inventoryValue with quantity * averageCost.
   * mode='report' will only log discrepancies. mode='repair' will update the database.
   */
  async reconcileValuation(clientId: string, mode: 'report' | 'repair' = 'report') {
    const variants = await prisma.productVariant.findMany({
      where: { clientId },
      include: { stocks: true }
    });

    let variantsScanned = 0;
    let variantsWithDrift = 0;
    let totalDriftAmount = 0;
    const items: any[] = [];

    for (const variant of variants) {
      variantsScanned++;
      const globalQty = variant.stocks.reduce((acc, s) => acc + s.quantity, 0);
      const expectedValue = globalQty * Number(variant.averageCost);
      const actualValue = Number(variant.inventoryValue);
      const drift = Math.abs(expectedValue - actualValue);

      // Tolerance of 0.01 to prevent false positives from floating-point rounding
      if (drift > 0.01) {
        variantsWithDrift++;
        totalDriftAmount += drift;
        
        items.push({
          variantId: variant.id,
          sku: variant.sku,
          quantity: globalQty,
          averageCost: Number(variant.averageCost),
          expectedValue,
          actualValue,
          drift
        });

        if (mode === 'repair') {
          await prisma.productVariant.update({
            where: { id: variant.id },
            data: { inventoryValue: expectedValue }
          });
        }
      }
    }

    return {
      mode,
      variantsScanned,
      variantsWithDrift,
      totalDriftAmount,
      items
    };
  }
}

export const valuationService = new ValuationService();
