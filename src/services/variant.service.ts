import { variantRepository } from '../repositories/variant.repository';
import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateUniqueCode, generateSequentialCode } from '../utils/codeGenerator';
import { inventoryMutationService } from './inventory-mutation.service';

export class VariantService {
  
  async createVariant(productId: string, clientId: string, data: any) {
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
      reorderLevel: data.reorderLevel
    };

    return variantRepository.create(variantData);
  }

  async bulkCreateVariants(productId: string, clientId: string, variants: any[]) {
    const product = await productRepository.findById(productId, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };

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
        const { sku, quantity, priceOverride, reorderLevel } = update;
        
        const variant = await prisma.productVariant.findFirst({
          where: { clientId, sku }
        });

        if (!variant) throw new Error(`SKU not found`);

        return prisma.$transaction(async (tx) => {
          let dataToUpdate: Prisma.ProductVariantUpdateInput = {};
          
          if (priceOverride !== undefined) dataToUpdate.compareAtPrice = priceOverride;
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
                createdBy: clientId
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
