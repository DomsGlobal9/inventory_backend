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
   * Inventory value broken down by product category.
   *
   * Honours the location filter, like every other stock figure on the reports page. It used
   * not to, which meant that with a location selected this table quietly reported the whole
   * company while the cards above it reported one branch -- two different totals for the same
   * stock, side by side, with nothing saying why.
   *
   * When scoped to a location the value is that location's quantity times the company-wide
   * weighted average cost, because average cost is not tracked per location. That is the same
   * convention the summary and dashboard figures already use, so the numbers reconcile.
   *
   * Raw SQL because grouping by a relation's column is not expressible in Prisma's group-by.
   */
  async getCategoryValue(clientId: string, locationId?: string) {
    const stockFilter = locationId ? Prisma.sql`AND location_id = ${locationId}` : Prisma.empty;
    const valueExpr = locationId
      ? Prisma.sql`SUM(COALESCE(s.qty, 0) * v.average_cost)`
      : Prisma.sql`SUM(v.inventory_value)`;

    const result = await prisma.$queryRaw<any[]>`
      SELECT 
        p.category,
        ${valueExpr} as total_value,
        SUM(COALESCE(s.qty, 0)) as total_units
      FROM "inventory_product_variants" v
      JOIN "inventory_products" p ON v.product_id = p.id
      LEFT JOIN (
        SELECT variant_id, SUM(quantity) as qty 
        FROM inventory_stocks 
        WHERE client_id = ${clientId} ${stockFilter}
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
  /**
   * Sets what the stock already on hand cost.
   *
   * The repair every inventory system has and this one did not: Odoo calls it Inventory
   * Revaluation, ERPNext calls it Stock Reconciliation, Zoho and QuickBooks call it a value
   * adjustment. They all exist because an opening cost is often a guess, and a guess has to be
   * correctable without inventing a fake purchase order.
   *
   * It is needed here for a specific reason. Adding a product asks for quantity and never for
   * cost, so stock has been arriving unvalued -- across this platform, hundreds of units are
   * held with no cost figure of any kind. Those units cannot be repaired by buying more: a
   * purchase adds to the average, it does not restate what is already on the shelf.
   *
   * This does not move any stock. The quantity before and after are identical and the movement
   * rows are written with a delta of zero -- what changes is only what those units are said to
   * be worth. Recorded as movements anyway, because restating the value of stock is exactly
   * the kind of thing someone needs to be able to find later.
   */
  async setCostOfStockOnHand(
    clientId: string,
    variantId: string,
    unitCost: number,
    options: { performedBy?: string; notes?: string } = {}
  ) {
    if (!Number.isFinite(unitCost) || unitCost <= 0) {
      throw Object.assign(
        new Error('Enter what one unit cost. It has to be more than zero -- if the stock really was free, leave the cost blank instead.'),
        { statusCode: 400 }
      );
    }

    return prisma.$transaction(async (tx) => {
      // Same lock discipline as applyMovement: a revaluation rewrites averageCost and
      // inventoryValue from a sum across every location, so it must not run beside a
      // receipt doing the same.
      await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${variantId} FOR UPDATE`;

      const variant = await tx.productVariant.findUnique({
        where: { id: variantId },
        include: { stocks: true, product: { select: { title: true } } }
      });
      if (!variant || variant.clientId !== clientId) {
        throw Object.assign(new Error('Variant not found.'), { statusCode: 404 });
      }

      const previousAverageCost = Number(variant.averageCost);
      const totalQty = variant.stocks.reduce((sum, st) => sum + st.quantity, 0);

      await tx.productVariant.update({
        where: { id: variantId },
        data: {
          averageCost: unitCost,
          inventoryValue: totalQty * unitCost,
          // Kept in step on purpose. costPrice is the figure a merchant typed and the one the
          // variant table falls back to; leaving it disagreeing with a cost they just
          // corrected is how the two drift apart and nobody knows which is true.
          costPrice: unitCost,
          lastCostUpdatedAt: new Date()
        }
      });

      // One row per location holding stock, so the ledger for each place shows the restatement
      // rather than it appearing only on whichever location happened to be first.
      for (const st of variant.stocks) {
        if (st.quantity === 0) continue;
        await tx.inventoryTransaction.create({
          data: {
            clientId,
            variantId,
            locationId: st.locationId,
            type: 'ADJUSTMENT',
            reason: 'MANUAL_CORRECTION',
            sku: variant.sku,
            variantCode: variant.variantCode,
            productTitle: variant.product?.title ?? null,
            // Zero: nothing physically moved.
            quantity: 0,
            balanceBefore: st.quantity,
            balanceAfter: st.quantity,
            unitCost,
            totalCost: st.quantity * unitCost,
            referenceType: 'REVALUATION',
            notes: options.notes
              ?? `Cost of stock on hand set to ${unitCost} (was ${previousAverageCost || 'not recorded'}).`,
            createdBy: options.performedBy ?? null
          }
        });
      }

      return {
        variantId,
        sku: variant.sku,
        unitsRevalued: totalQty,
        previousAverageCost,
        averageCost: unitCost,
        inventoryValue: totalQty * unitCost
      };
    }, { timeout: 30000 });
  }

}

export const valuationService = new ValuationService();
