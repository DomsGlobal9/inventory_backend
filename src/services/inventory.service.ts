import { inventoryRepository } from '../repositories/inventory.repository';
import { TransactionType, InventoryReason, Prisma } from '@prisma/client';
import { inventoryMutationService } from './inventory-mutation.service';
import { prisma } from '../lib/prisma';

export class InventoryService {
  
  async stockIn(clientId: string, variantId: string, quantity: number, reason?: string, referenceType?: string, reference?: string, unitCost?: number, notes?: string) {
    return inventoryMutationService.applyMovement({
      clientId, 
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

  async stockOut(clientId: string, variantId: string, quantity: number, reason?: string, referenceType?: string, reference?: string, notes?: string) {
    return inventoryMutationService.applyMovement({
      clientId, 
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

  async adjustment(clientId: string, variantId: string, quantityChange: number, reason?: string, referenceType?: string, reference?: string, notes?: string) {
    // Adjustment can be positive or negative
    return inventoryMutationService.applyMovement({
      clientId, 
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

  async getVariants(clientId: string, filters: any = {}) {
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

    // Map inventoryStatus filter values to actual DB conditions
    if (status === 'ARCHIVED') {
      // ARCHIVED inventoryStatus = product itself is archived or trashed
      where.product = { status: { in: ['ARCHIVED', 'TRASHED'] as any } };
    } else if (status === 'OUT_OF_STOCK') {
      where.quantity = { lte: 0 };
      where.product = { status: { in: ['ACTIVE', 'DRAFT'] as any } };
    } else if (status === 'LOW_STOCK') {
      where.quantity = { gt: 0, lte: 10 };
      where.product = { status: { in: ['ACTIVE', 'DRAFT'] as any } };
    } else if (status === 'HEALTHY') {
      where.quantity = { gt: 10 };
      where.product = { status: { in: ['ACTIVE', 'DRAFT'] as any } };
    }

    if (outOfStock === 'true') {
      where.quantity = { lte: 0 };
    } else if (lowStock === 'true') {
      where.quantity = { gt: 0, lte: 10 };
    }

    const orderBy: any = {};
    if (sortBy === 'productTitle') {
      orderBy.product = { title: order };
    } else if (['sku', 'quantity', 'averageCost', 'inventoryValue', 'updatedAt'].includes(sortBy)) {
      orderBy[sortBy] = order;
    } else {
      orderBy.createdAt = 'desc';
    }

    const [variants, total] = await Promise.all([
      prisma.productVariant.findMany({
        where,
        orderBy,
        skip,
        take: Number(limit),
        include: {
          product: { select: { title: true, category: true, status: true } }
        }
      }),
      prisma.productVariant.count({ where })
    ]);

    // Map to UI-ready DTO
    const items = variants.map(v => {
      let inventoryStatus = 'HEALTHY';
      if (v.product.status === 'ARCHIVED' || v.product.status === 'TRASHED') {
        inventoryStatus = 'ARCHIVED';
      } else if (v.quantity <= 0) {
        inventoryStatus = 'OUT_OF_STOCK';
      } else if (v.quantity <= Math.max(v.reorderLevel || 0, 10)) {
        inventoryStatus = 'LOW_STOCK';
      }

      return {
        variantId: v.id,
        productId: v.productId,
        sku: v.sku,
        productTitle: v.product.title,
        category: v.product.category,
        quantity: v.quantity,
        averageCost: Number(v.averageCost),
        inventoryValue: Number(v.inventoryValue),
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
