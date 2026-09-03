import { inventoryRepository } from '../repositories/inventory.repository';
import { TransactionType, InventoryReason, Prisma } from '@prisma/client';
import { inventoryMutationService } from './inventory-mutation.service';
import { prisma } from '../lib/prisma';

export class InventoryService {
  
  async stockIn(clientId: string, locationId: string, variantId: string, quantity: number, reason?: string, referenceType?: string, reference?: string, unitCost?: number, notes?: string) {
    return inventoryMutationService.applyMovement({
      clientId, 
      locationId,
      variantId, 
      movementType: 'IN', 
      quantityDelta: Math.abs(quantity), // Stock In is always positive
      reason: (reason as InventoryReason) || 'PURCHASE',
      referenceId: reference,
      referenceType: referenceType || 'MANUAL', 
      unitCost,
      notes,
      createdBy: clientId // Simulating the createdBy field
    });
  }

  async stockOut(clientId: string, locationId: string, variantId: string, quantity: number, reason?: string, referenceType?: string, reference?: string, notes?: string) {
    return inventoryMutationService.applyMovement({
      clientId, 
      locationId,
      variantId, 
      movementType: 'OUT', 
      quantityDelta: -Math.abs(quantity), // Stock Out is always negative
      reason: (reason as InventoryReason) || 'SALE',
      referenceId: reference,
      referenceType: referenceType || 'MANUAL', 
      notes,
      createdBy: clientId
    });
  }

  async adjustment(clientId: string, locationId: string, variantId: string, quantityChange: number, reason?: string, referenceType?: string, reference?: string, notes?: string) {
    // Adjustment can be positive or negative
    return inventoryMutationService.applyMovement({
      clientId, 
      locationId,
      variantId, 
      movementType: 'ADJUSTMENT', 
      quantityDelta: quantityChange,
      reason: (reason as InventoryReason) || 'MANUAL_ADJUSTMENT',
      referenceId: reference, 
      referenceType: referenceType || 'MANUAL',
      notes,
      createdBy: clientId
    });
  }

  async getTransactions(clientId: string, filters: any = {}) {
    return inventoryRepository.getTransactions(clientId, filters);
  }

  async getVariants(clientId: string, filters: any = {}, locationId?: string) {
    const { search, status, lowStock, outOfStock, sortBy, order = 'asc', page = 1, limit = 50 } = filters;
    const skip = (page - 1) * limit;

    const where: Prisma.ProductVariantWhereInput = { clientId };

    // Search by SKU, variantCode, barcode, or product title
    if (search) {
      where.OR = [
        { sku: { contains: search, mode: 'insensitive' } },
        { variantCode: { contains: search, mode: 'insensitive' } },
        { barcode: { contains: search, mode: 'insensitive' } },
        { product: { title: { contains: search, mode: 'insensitive' } } }
      ];
    }

    // When a location is selected, all quantity-based filters/aggregates are scoped to it.
    const scopedGt0 = locationId ? { locationId, quantity: { gt: 0 } } : { quantity: { gt: 0 } };

    // LOW_STOCK / HEALTHY and "sort by quantity" can't be expressed in the database query:
    //   - on-hand quantity is a SUM over the InventoryStock rows, not a column on
    //     ProductVariant. `orderBy: { quantity: order }` therefore threw
    //     PrismaClientValidationError and 500'd the whole Inventory Overview -- picking
    //     "Lowest/Highest Stock First" emptied the table until you changed sort again.
    //   - the low-stock threshold is per-variant, `max(reorderLevel, 10)`, and Prisma
    //     can't compare a related row's quantity against the parent's reorderLevel. The
    //     filter used a hardcoded `<= 10`, so a variant with reorderLevel 25 and 20 on
    //     hand was badged "Low Stock" by this same service yet vanished from the list
    //     when you filtered by Low Stock.
    // Both are resolved in one in-memory pass below, using exactly the threshold the
    // badge uses, so the filter and the badge can no longer disagree.
    const isLowStockView = status === 'LOW_STOCK' || lowStock === 'true';
    const isHealthyView = status === 'HEALTHY';
    const needsComputedPass = sortBy === 'quantity' || isLowStockView || isHealthyView;

    if (status === 'ARCHIVED') {
      where.product = { status: { in: ['ARCHIVED', 'TRASHED'] as any } };
    } else if (status === 'OUT_OF_STOCK') {
      where.stocks = { none: scopedGt0 };
      where.product = { status: { in: ['ACTIVE', 'DRAFT'] as any } };
    } else if (isLowStockView || isHealthyView) {
      // Quantity predicate deliberately omitted -- applied in the computed pass.
      where.product = { status: { in: ['ACTIVE', 'DRAFT'] as any } };
    }

    if (outOfStock === 'true') {
      where.stocks = { none: scopedGt0 };
    }

    const orderBy: any = {};
    if (sortBy === 'productTitle') {
      orderBy.product = { title: order };
    } else if (['sku', 'averageCost', 'inventoryValue', 'updatedAt'].includes(sortBy)) {
      orderBy[sortBy] = order;
    } else {
      orderBy.createdAt = 'desc';
    }

    const onHand = (stocks: { locationId: string | null; quantity: number }[]) =>
      (locationId ? stocks.filter(s => s.locationId === locationId) : stocks)
        .reduce((acc, s) => acc + s.quantity, 0);

    const lowStockThreshold = (reorderLevel: number | null) => Math.max(reorderLevel || 0, 10);

    let variants: any[];
    let total: number;

    if (needsComputedPass) {
      // Pull just the id + the numbers needed to compute on-hand for every matching
      // variant (no `include`, no pagination), then filter/sort/paginate here and
      // re-fetch only the page's rows in full.
      const candidates = await prisma.productVariant.findMany({
        where,
        orderBy,
        select: {
          id: true,
          reorderLevel: true,
          stocks: { select: { locationId: true, quantity: true } }
        }
      });

      let computed = candidates.map(v => ({
        id: v.id,
        qty: onHand(v.stocks),
        threshold: lowStockThreshold(v.reorderLevel)
      }));

      if (isLowStockView) {
        computed = computed.filter(v => v.qty > 0 && v.qty <= v.threshold);
      } else if (isHealthyView) {
        computed = computed.filter(v => v.qty > v.threshold);
      }

      if (sortBy === 'quantity') {
        computed.sort((a, b) => (order === 'desc' ? b.qty - a.qty : a.qty - b.qty));
      }

      total = computed.length;
      const pageIds = computed.slice(skip, skip + Number(limit)).map(v => v.id);

      const rows = pageIds.length
        ? await prisma.productVariant.findMany({
            where: { id: { in: pageIds } },
            include: {
              product: { select: { title: true, category: true, status: true } },
              stocks: true
            }
          })
        : [];

      // `IN (...)` gives no ordering guarantee -- restore the order computed above.
      const byId = new Map(rows.map(r => [r.id, r]));
      variants = pageIds.map(id => byId.get(id)).filter(Boolean) as any[];
    } else {
      [variants, total] = await Promise.all([
        prisma.productVariant.findMany({
          where,
          orderBy,
          skip,
          take: Number(limit),
          include: {
            product: { select: { title: true, category: true, status: true } },
            stocks: true
          }
        }),
        prisma.productVariant.count({ where })
      ]);
    }

    // Map to UI-ready DTO
    const items = variants.map(v => {
      // Quantity is scoped to the selected location when one is active, otherwise summed globally
      const qty = onHand(v.stocks);

      let inventoryStatus = 'HEALTHY';
      if (v.product.status === 'ARCHIVED' || v.product.status === 'TRASHED') {
        inventoryStatus = 'ARCHIVED';
      } else if (qty <= 0) {
        inventoryStatus = 'OUT_OF_STOCK';
      } else if (qty <= lowStockThreshold(v.reorderLevel)) {
        inventoryStatus = 'LOW_STOCK';
      }

      // averageCost/inventoryValue are company-wide weighted-average figures (not tracked per location);
      // when scoped to a location, inventoryValue is recomputed as scoped qty x company-wide average cost.
      const averageCost = Number(v.averageCost);
      const inventoryValue = locationId ? qty * averageCost : Number(v.inventoryValue);

      return {
        variantId: v.id,
        productId: v.productId,
        sku: v.sku,
        productTitle: v.product.title,
        category: v.product.category,
        quantity: qty,
        averageCost,
        inventoryValue,
        status: v.product.status,
        inventoryStatus,
        updatedAt: v.updatedAt
      };
    });

    return {
      items,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit))
      }
    };
  }

  async getMetadata() {
    return {
      inventoryReasons: Object.values(InventoryReason),
      transactionTypes: Object.values(TransactionType)
    };
  }

  async getAlerts(clientId: string) {
    const alerts = await inventoryRepository.getInventoryAlerts(clientId) as any[];
    
    // Process raw query results
    const outOfStock = alerts.filter(a => a.quantity <= 0);
    const lowStock = alerts.filter(a => a.quantity > 0 && a.quantity <= a.reorderLevel);

    return {
      outOfStock,
      lowStock,
      totalAlerts: alerts.length
    };
  }
}

export const inventoryService = new InventoryService();
