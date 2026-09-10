import { variantRepository } from '../repositories/variant.repository';
import { productRepository } from '../repositories/product.repository';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateUniqueCode, generateSequentialCode } from '../utils/codeGenerator';
import { inventoryMutationService } from './inventory-mutation.service';
import { valuationService } from './valuation.service';
import { notFound } from '../utils/httpError';
import { conflict } from '../utils/httpError';
import { isLive, notLiveReason } from '../utils/product-state-machine';

/**
 * How many rows of a bulk import are worked on at once.
 *
 * Each row is several database round trips inside its own transaction, and this database is
 * about a second away, so the limit that matters is connections rather than CPU. Eight keeps a
 * large import moving without occupying the whole pool -- which is shared with every other
 * tenant on the instance, and is the reason this is bounded at all.
 */
const BULK_UPDATE_CONCURRENCY = 8;

/**
 * A product has to be in the shop before it can grow new sizes and colours.
 *
 * Both creation paths checked only that the product EXISTED. It could be in the bin waiting out
 * its seven days, or archived and withdrawn from sale, and a new variant went on anyway -- along
 * with its opening stock, because `quantity` on a new variant puts units on the shelf. That put
 * real units into the shop's valuation under a product that appears on no screen, and it blocked
 * the deletion the bin exists for, since stock on hand is one of the things that refuses a hard
 * delete. Neither would have been easy to explain afterwards.
 */
function assertCanTakeVariants(product: { status?: string | null }) {
  if (isLive(product.status)) return;
  // Asked of the state machine rather than re-listed here, so "which states are on their way
  // out" has one answer in the codebase instead of one per caller.
  throw conflict(notLiveReason(product.status as string) + ' Then you can add sizes and colours.');
}

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

  /**
   * Where a CSV row's quantity should land.
   *
   * The location the user is working in first, then a location coded MAIN-STORE, then the
   * tenant's first active location. Only that last fallback is new: the previous code looked
   * for MAIN-STORE alone and dereferenced the result without checking, so a tenant whose
   * locations are named anything else could not import quantities at all.
   *
   * If a tenant genuinely has nowhere to put stock, that is said plainly rather than thrown
   * as a null dereference the user has to interpret.
   */
  private async resolveUpdateLocationId(
    clientId: string,
    preferredLocationId: string | undefined,
    tx: Prisma.TransactionClient | typeof prisma
  ): Promise<string> {
    // Asked for by name: honour it or refuse. Falling back would put the stock somewhere
    // other than where the user said, which is worse than not importing at all -- and the
    // tenant check is what stops one tenant writing into another's location.
    if (preferredLocationId) {
      const chosen = await tx.stockLocation.findFirst({
        where: { id: preferredLocationId, clientId }, select: { id: true }
      });
      if (!chosen) {
        throw new Error('That stock location does not exist for this account.');
      }
      return chosen.id;
    }

    const main = await tx.stockLocation.findFirst({
      where: { clientId, code: 'MAIN-STORE' }, select: { id: true }
    });
    if (main) return main.id;

    const first = await tx.stockLocation.findFirst({
      where: { clientId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true }
    });
    if (first) return first.id;

    throw new Error(
      'No stock location exists to apply this quantity to. ' +
      'Create one under Settings -> Stock Locations, then import again.'
    );
  }

  /**
   * Books the quantity a variant is created with.
   *
   * unitCost is what makes this opening stock VALUED rather than merely counted. Without it
   * the units land with no cost at all, and the first real purchase gets averaged against
   * them -- 50 sarees at "no cost" plus one at 4,999 used to come out at 98 rupees each.
   * Every serious inventory system refuses an opening quantity without an opening rate for
   * exactly this reason; this passes on whatever cost the merchant did give.
   */
  private async applyInitialStock(clientId: string, variantId: string, quantity: number, locationIds: string[], createdBy: string, unitCost?: number | null) {
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
        // Only when it is a real figure. Passing 0 would assert that the stock cost nothing,
        // which is the very thing this is here to avoid saying.
        unitCost: unitCost && unitCost > 0 ? Number(unitCost) : undefined,
        createdBy
      });
    }
  }

  async createVariant(productId: string, clientId: string, data: any, locationId?: string) {
    // Ensure product exists and belongs to client
    const product = await productRepository.findById(productId, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };
    assertCanTakeVariants(product);

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
      await this.applyInitialStock(clientId, created.id, data.quantity, locationIds, clientId, data.costPrice);
    }

    return created;
  }

  async bulkCreateVariants(productId: string, clientId: string, variants: any[], locationId?: string, applyToAllLocations?: boolean, supplierId?: string) {
    const product = await productRepository.findById(productId, clientId);
    if (!product) throw { statusCode: 404, message: "Product not found" };
    assertCanTakeVariants(product);

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
            reorderLevel: v.reorderLevel,
            // Accepted by bulkCreateVariantSchema and then silently dropped here, so a
            // catalogue imported with costs and prices arrived with neither.
            sellingPrice: v.sellingPrice,
            costPrice: v.costPrice
          });

          if (v.quantity > 0) {
            try {
              await this.applyInitialStock(clientId, created.id, v.quantity, locationIds, clientId, v.costPrice);
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
    // Record who supplies these, if the merchant said.
    //
    // The same link createPO makes when an order is raised, made at the point the merchant
    // actually knows the answer instead of waiting until they order. skipDuplicates for the
    // same reason it uses it: an existing link carries negotiated terms -- agreed price, lead
    // time, the supplier's own SKU -- and must not be overwritten by whatever a later screen
    // happened to know.
    //
    // Deliberately non-fatal. Failing to record a relationship must never lose the variants
    // the merchant just created.
    const madeVariants = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map(r => r.value?.variant)
      .filter(Boolean);

    if (supplierId && madeVariants.length > 0) {
      try {
        // Checked, not trusted: a supplierId from another tenant would otherwise write rows
        // linking this shop's variants to a supplier it cannot see.
        const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, clientId } });
        if (supplier) {
          await prisma.supplierProduct.createMany({
            data: madeVariants.map((v: any) => ({
              clientId,
              supplierId,
              variantId: v.id,
              costPrice: v.costPrice ?? null,
              notes: 'Linked when the product was added.'
            })),
            skipDuplicates: true
          });
        }
      } catch (error) {
        console.error('[bulkCreateVariants] could not link the new variants to their supplier', error);
      }
    }

    return { created, skipped, errors, adjusted, stockNotApplied };
  }

  async bulkUpdateVariants(clientId: string, updates: any[], locationId?: string) {
    // Resolved once, outside the per-row transactions. It is the same answer for every row,
    // and each round trip to this database costs over a second -- doing the lookup inside the
    // transaction pushed it past Prisma's 5s limit and every row failed with "Transaction
    // already closed", which is a confusing way to say "your import did nothing".
    // A tenant with nowhere to put stock fails here, once, with a sentence that says so.
    let targetLocationId: string | null = null;
    if (updates.some(u => u.quantity !== undefined)) {
      targetLocationId = await this.resolveUpdateLocationId(clientId, locationId, prisma);
    }

    // ONE BATCH AT A TIME, not the whole file at once.
    //
    // This was Promise.allSettled over every row, so a 1,000-row import opened a thousand
    // transactions simultaneously -- about five database operations each -- against a
    // connection pool in single digits, on a database roughly a second away. That pool is
    // shared by the whole instance, so one merchant's large import did not merely run slowly:
    // it starved every other tenant's requests until it finished or timed out.
    //
    // Bounded concurrency keeps the pool usable and makes a large import simply take longer,
    // which is the right failure mode for a bulk job on a shared service. The width is small
    // on purpose: each row is several round trips, not one.
    const results: PromiseSettledResult<any>[] = [];
    for (let start = 0; start < updates.length; start += BULK_UPDATE_CONCURRENCY) {
      const batch = updates.slice(start, start + BULK_UPDATE_CONCURRENCY);
      const settled = await Promise.allSettled(
      batch.map(async (update) => {
        const { sku, quantity, priceOverride, sellingPrice, costPrice, reorderLevel } = update;

        const variant = await prisma.productVariant.findFirst({
          where: { clientId, sku }
        });

        if (!variant) throw notFound(`SKU not found`);

        return prisma.$transaction(async (tx) => {
          let dataToUpdate: Prisma.ProductVariantUpdateInput = {};

          if (priceOverride !== undefined) dataToUpdate.compareAtPrice = priceOverride;
          if (sellingPrice !== undefined) dataToUpdate.sellingPrice = sellingPrice;
          if (costPrice !== undefined) dataToUpdate.costPrice = costPrice;
          if (reorderLevel !== undefined) dataToUpdate.reorderLevel = reorderLevel;

          if (quantity !== undefined) {
            // Resolved above precisely because at least one row carries a quantity, so this
            // cannot be null here -- but say so rather than asserting past the type.
            if (!targetLocationId) throw new Error('No stock location resolved for this import');

            // Get current stock
            const stock = await tx.inventoryStock.findFirst({
              where: { variantId: variant.id, locationId: targetLocationId }
            });
            const currentQty = stock?.quantity || 0;

            if (quantity !== currentQty) {
              await inventoryMutationService.applyMovement({
                clientId,
                locationId: targetLocationId,
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
        }, {
          // Prisma's defaults are 2s to acquire and 5s to run. A stock movement is several
          // round trips and each one costs over a second against this database, so every row
          // that changed a quantity died with "Transaction already closed" -- reported as
          // "skipped", which is why the CSV import appeared to do nothing. The work inside is
          // bounded (one variant, one location), so a longer ceiling is safe.
          maxWait: 15000,
          timeout: 30000
        });
      })
      );
      results.push(...settled);
    }

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

  /**
   * Updates a variant, and treats a cost typed onto unvalued stock as what it plainly means.
   *
   * A merchant with fifty sarees on the shelf who types 3,000 into the cost box is saying
   * "these cost me three thousand each". Storing that in costPrice alone left the stock itself
   * still carrying no value, so the shop's inventory was worth nothing until the next purchase
   * -- and the next purchase then had nothing to average against.
   *
   * Only when no cost is known yet. A variant with a real averageCost has been costed by
   * actual receipts, and a typed figure must not quietly overwrite what was really paid;
   * correcting that is a deliberate revaluation (valuationService.setCostOfStockOnHand),
   * not a side effect of editing a field.
   */
  async updateVariant(id: string, clientId: string, data: any) {
    const updated = await variantRepository.updateSafe(id, clientId, data);

    const typedCost = Number(data?.costPrice ?? 0);
    if (typedCost > 0) {
      const current = await prisma.productVariant.findFirst({
        where: { id, clientId },
        select: { averageCost: true, lastPurchaseCost: true, stocks: { select: { quantity: true } } }
      });
      const neverCosted =
        Number(current?.averageCost ?? 0) === 0 && Number(current?.lastPurchaseCost ?? 0) === 0;
      const qty = (current?.stocks ?? []).reduce((sum, st) => sum + st.quantity, 0);

      if (neverCosted && qty > 0) {
        await valuationService.setCostOfStockOnHand(clientId, id, typedCost, {
          notes: `Cost of stock on hand set from the variant's cost price.`
        });
      }
    }

    return updated;
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
        // What it ACTUALLY sells for, which is the variant's own price when it has one and
        // otherwise the product's. Adding a product asks for a single Base Price and never
        // for a per-variant price, so 282 of the 344 variants on this platform have no
        // sellingPrice of their own -- and every margin warning that read sellingPrice alone
        // stayed silent for them. That included a saree costing 45,000 being bought against a
        // 45,666 price, which is the exact case the warning exists for.
        effectiveSellingPrice:
          variant.sellingPrice ? Number(variant.sellingPrice)
          : variant.product?.basePrice ? Number(variant.product.basePrice)
          : null,
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
