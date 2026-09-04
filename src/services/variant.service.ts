import { variantRepository } from '../repositories/variant.repository';
import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateUniqueCode, generateSequentialCode } from '../utils/codeGenerator';
import { inventoryMutationService } from './inventory-mutation.service';

export class VariantService {
  
  // Resolves the location(s) that should receive a variant's initial stock quantity.
  // Falls back to MAIN-STORE when no location is selected/passed, matching the
  // fallback chain used by the manual Stock In/Out/Adjust endpoints.
  private async resolveInitialStockLocationIds(clientId: string, locationId?: string, applyToAllLocations?: boolean): Promise<string[]> {
    if (applyToAllLocations) {
      const locations = await prisma.stockLocation.findMany({ where: { clientId, active: true }, select: { id: true } });
      return locations.map(l => l.id);
    }
    if (locationId) return [locationId];
    const defaultLoc = await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
    return defaultLoc ? [defaultLoc.id] : [];
  }

  private async applyInitialStock(clientId: string, variantId: string, quantity: number, locationIds: string[], createdBy: string) {
    if (quantity <= 0) return;

    // An empty locationIds list used to mean this loop ran zero times: the caller asked to
    // stock N units, no movement was made, and nothing anywhere said so -- the product and
    // variant were created, the UI reported success, and the opening stock simply
    // evaporated. Stock quietly disappearing is the worst failure mode an inventory system
    // has, so refuse loudly instead. 400, not 500: it is a setup problem the user can fix.
    if (locationIds.length === 0) {
      throw Object.assign(
        new Error(
          'No stock location exists to receive this opening stock. ' +
          'Create one under Settings -> Stock Locations, then add the quantity.'
        ),
        { statusCode: 400 }
      );
    }
    for (const targetLocationId of locationIds) {
      await inventoryMutationService.applyMovement({
        clientId,
        locationId: targetLocationId,
        variantId,
        movementType: 'IN',
        quantityDelta: quantity,
        reason: 'INITIAL_STOCK',
        referenceType: 'VARIANT_CREATION',
        createdBy
      });
    }
  }

  async createVariant(productId: string, clientId: string, data: any, locationId?: string) {
    // Ensure product exists and belongs to client
    const product = await productRepository.findById(productId, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };

    const variantCode = await generateSequentialCode(clientId, 'VAR', 'VARIANT');
    const barcode = await generateUniqueCode('SVM', 8, async (code) => variantRepository.barcodeExists(code));

    const variantData: Prisma.ProductVariantUncheckedCreateInput = {
      productId,
      clientId,
      sku: data.sku,
      variantCode,
      barcode,
      barcodeType: 'INTERNAL_CODE128',
      size: data.size,
      colorName: data.colorName,
      hexCode: data.hexCode,
      reorderLevel: data.reorderLevel,
      sellingPrice: data.sellingPrice,
      costPrice: data.costPrice
    };

    const created = await variantRepository.create(variantData);

    if (data.quantity > 0) {
      const locationIds = await this.resolveInitialStockLocationIds(clientId, locationId);
      await this.applyInitialStock(clientId, created.id, data.quantity, locationIds, clientId);
    }

    return created;
  }

  async bulkCreateVariants(productId: string, clientId: string, variants: any[], locationId?: string, applyToAllLocations?: boolean) {
    const product = await productRepository.findById(productId, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };

    const locationIds = await this.resolveInitialStockLocationIds(clientId, locationId, applyToAllLocations);

    const results = await Promise.allSettled(
      variants.map(async (v) => {
        try {
          const variantCode = await generateSequentialCode(clientId, 'VAR', 'VARIANT');
          const barcode = await generateUniqueCode('SVM', 8, async (code) => variantRepository.barcodeExists(code));

          const created = await variantRepository.create({
            productId,
            clientId,
            variantCode,
            barcode,
            barcodeType: 'INTERNAL_CODE128',
            sku: v.sku,
            size: v.size,
            colorName: v.colorName,
            hexCode: v.hexCode,
            reorderLevel: v.reorderLevel
          });

          if (v.quantity > 0) {
            await this.applyInitialStock(clientId, created.id, v.quantity, locationIds, clientId);
          }

          return created;
        } catch (error: any) {
          throw { sku: v.sku, reason: error.message || 'Variant already exists or invalid data' };
        }
      })
    );

    const created = results.filter((r) => r.status === 'fulfilled').length;
    const skipped = results.filter((r) => r.status === 'rejected').length;
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);

    return { created, skipped, errors };
  }

  async bulkUpdateVariants(clientId: string, updates: any[]) {
    const results = await Promise.allSettled(
      updates.map(async (update) => {
        const { sku, quantity, priceOverride, sellingPrice, costPrice, reorderLevel } = update;

        const variant = await prisma.productVariant.findFirst({
          where: { clientId, sku }
        });

        if (!variant) throw new Error(`SKU not found`);

        return prisma.$transaction(async (tx) => {
          let dataToUpdate: Prisma.ProductVariantUpdateInput = {};

          if (priceOverride !== undefined) dataToUpdate.compareAtPrice = priceOverride;
          if (sellingPrice !== undefined) dataToUpdate.sellingPrice = sellingPrice;
          if (costPrice !== undefined) dataToUpdate.costPrice = costPrice;
          if (reorderLevel !== undefined) dataToUpdate.reorderLevel = reorderLevel;

          if (quantity !== undefined) {
            // Find default location
            const defaultLoc = await tx.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
            
            // Get current stock
            const stock = await tx.inventoryStock.findFirst({ 
              where: { variantId: variant.id, locationId: defaultLoc!.id }
            });
            const currentQty = stock?.quantity || 0;

            if (quantity !== currentQty) {
              await inventoryMutationService.applyMovement({
                clientId,
                locationId: defaultLoc!.id,
                variantId: variant.id,
                movementType: 'ADJUSTMENT',
                reason: 'MANUAL_CORRECTION',
                quantityDelta: quantity - currentQty,
                notes: 'Bulk CSV Update',
                createdBy: clientId,
                tx
              });
            }
          }

          if (Object.keys(dataToUpdate).length > 0) {
            await tx.productVariant.update({
              where: { id: variant.id },
              data: dataToUpdate
            });
          }

          return sku;
        });
      })
    );

    const updated = results.filter((r) => r.status === 'fulfilled').length;
    const skipped = results.filter((r) => r.status === 'rejected').length;
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r, i) => ({ sku: updates[i]?.sku, reason: r.reason.message || r.reason }));

    return { updated, skipped, errors };
  }

  async getVariants(productId: string, clientId: string) {
    const variants = await variantRepository.findManyByProduct(productId, clientId);
    
    return variants.map((v: any) => {
      const stocks = v.stocks || [];
      const totalQuantity = stocks.reduce((acc: number, s: any) => acc + s.quantity, 0);
      
      const stockByLocation = stocks.map((s: any) => ({
        locationId: s.locationId,
        name: s.location?.name || s.locationId,
        quantity: s.quantity
      }));
      
      const locationSettings = (v.locationProfiles || []).map((p: any) => ({
        locationId: p.locationId,
        isAvailable: p.isAvailable,
        priceOverride: p.priceOverride ? Number(p.priceOverride) : null
      }));

      // Add missing locations to settings conceptually in the service if needed,
      // but UI can also just rely on this explicit list and fallback to global

      return {
        ...v,
        totalQuantity,
        stockByLocation,
        locationSettings
      };
    });
  }

  async updateVariant(id: string, clientId: string, data: any) {
    return variantRepository.updateSafe(id, clientId, data);
  }

  async deleteVariant(id: string, clientId: string) {
    return variantRepository.delete(id, clientId);
  }

  async searchVariants(clientId: string, params: { q: string, page: number, limit: number, includeInventory?: boolean, includeCosting?: boolean }) {
    const result = await variantRepository.searchVariants(clientId, params);
    
    // Map to procurement-friendly flattened structure
    const mappedItems = result.data.map((variant: any) => {
      const stock = variant.stocks ? variant.stocks.reduce((acc: number, s: any) => acc + s.quantity, 0) : 0;
      const reorderLevel = variant.reorderLevel || 0;
      
      return {
        id: variant.id,
        variantCode: variant.variantCode,
        sku: variant.sku,
        barcode: variant.barcode,
        productTitle: variant.product?.title || '',
        color: variant.colorName,
        size: variant.size,
        stock,
        reorderLevel,
        reorderQty: variant.reorderQty || 0,
        availableToOrder: Math.max(reorderLevel - stock, 0),
        costPrice: Number(variant.costPrice || 0),
        lastPurchaseCost: Number(variant.lastPurchaseCost || 0),
        // Needed by the Purchase Order screen to warn when an entered PO cost would
        // shrink the margin against what this variant actually sells for.
        sellingPrice: variant.sellingPrice ? Number(variant.sellingPrice) : null,
        averageCost: Number(variant.averageCost || 0),
        isLowStock: stock <= reorderLevel
      };
    });

    return {
      items: mappedItems,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        pages: result.pages
      }
    };
  }
}

export const variantService = new VariantService();
