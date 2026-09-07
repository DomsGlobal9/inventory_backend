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

    // SKUs are derived client-side as productCode-FIRST3OFCOLOUR-size, so two genuinely
    // different colours whose names begin with the same three letters -- "Purple" and
    // "Purple Blue", or "Light Blue" and "Light Green", which both reduce to LIG -- produce
    // the same SKU. [clientId, sku] is unique, so the second insert failed, was counted as
    // "skipped", and the variant the user asked for simply did not exist. It cost a real
    // customer a variant on the first product they ever created.
    //
    // The user's intent is not ambiguous in that case -- two distinct colour/size pairs --
    // only the derived label collided, so the label is disambiguated rather than the variant
    // dropped. Resolved up front, against both the batch and what the tenant already has,
    // because the creates below run concurrently and cannot see each other's SKUs.
    const existing = await prisma.productVariant.findMany({
      where: { clientId }, select: { sku: true }
    });
    const taken = new Set(existing.map(v => v.sku));
    const adjusted: { requested: string; used: string }[] = [];

    const prepared = variants.map((v) => {
      let sku = v.sku;
      if (taken.has(sku)) {
        let n = 2;
        while (taken.has(`${sku}-${n}`)) n++;
        sku = `${sku}-${n}`;
        adjusted.push({ requested: v.sku, used: sku });
      }
      taken.add(sku);
      return { ...v, sku };
    });

    const results = await Promise.allSettled(
      prepared.map(async (v) => {
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
            try {
              await this.applyInitialStock(clientId, created.id, v.quantity, locationIds, clientId);
            } catch (stockError: any) {
              // The variant row is already committed at this point -- the create and the
              // movement are not one transaction -- so this is NOT the same failure as "the
              // variant could not be made". Reporting it as one told the user to add the
              // variant again, which re-submits a SKU that now exists and gets renamed to
              // SKU-2, leaving them with a duplicate. It is flagged separately so the advice
              // can be the true one: the variant is there, its opening quantity is not.
              return {
                variant: created,
                stockFailed: {
                  sku: created.sku,
                  quantity: v.quantity,
                  reason: stockError.message || 'opening stock could not be added'
                }
              };
            }
          }

          return { variant: created, stockFailed: null };
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

    // Variants that exist but did not get the quantity that was asked for. Kept apart from
    // `errors` because the remedy is different: set the quantity, do not create it again.
    const stockNotApplied = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map(r => r.value?.stockFailed)
      .filter(Boolean);

    // `adjusted` is returned so the caller can say which SKU it actually used. A variant that
    // silently carries a different code than the one the user watched it be given is the same
    // class of problem as losing it -- smaller, but the same kind.
    return { created, skipped, errors, adjusted, stockNotApplied };
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

    // Paired with its original index BEFORE filtering. Mapping over the filtered array and
    // indexing `updates` with its position named the wrong row: with row 0 succeeding and row
    // 1 failing, the error was reported against row 0's SKU -- the one that worked -- sending
    // anyone correcting their spreadsheet to the wrong line.
    const errors = results
      .map((r, i) => ({ result: r, index: i }))
      .filter((x): x is { result: PromiseRejectedResult; index: number } => x.result.status === 'rejected')
      .map(({ result, index }) => ({
        sku: updates[index]?.sku,
        reason: result.reason?.message || String(result.reason)
      }));

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
