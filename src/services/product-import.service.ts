import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { readColorMetadata } from '../lib/catalogMetadata';
import { grants } from '../config/permissions';
import { inventoryMutationService } from './inventory-mutation.service';
import { generateSequentialCode } from '../utils/codeGenerator';

/**
 * Creating and updating a whole catalogue from one file.
 *
 * The file is parsed in the browser -- the same place the existing bulk update parses its
 * CSV -- and arrives here as rows. That keeps one import pipeline for both .xlsx and .csv:
 * whichever the merchant used, the difference is gone before it reaches this service.
 *
 * Two ideas carry the whole design:
 *
 *   Nothing is written until it has been previewed. plan() answers "what would happen"
 *   with no writes at all, and apply() refuses to run against a file that differs from the
 *   one that was previewed. A merchant whose import timed out will upload the same file
 *   again -- that must be safe, and it must be visibly safe, which is why the plan reports
 *   what is UNCHANGED as well as what is new.
 *
 *   A blank cell means "leave this alone", never "erase it". Somebody who deletes a column
 *   from their spreadsheet because they do not care about it must not thereby wipe it from
 *   every product they touch.
 */

export interface ImportRow {
  rowNumber: number;
  // Identity
  productCode?: string;  // existing product, from an export
  productKey?: string;   // groups rows of a NEW product; never stored
  sku?: string;          // variant identity within the product
  // Product fields
  title?: string;
  description?: string;
  category?: string;
  dressType?: string;
  fabric?: string;
  craft?: string;
  brand?: string;
  basePrice?: number;
  // Variant fields
  size?: string;
  color?: string;
  quantity?: number;
  costPrice?: number;
  sellingPrice?: number;
  reorderLevel?: number;
  locationCode?: string;
}

export interface ImportIssue {
  rowNumber: number;
  message: string;
}

export interface ImportPlan {
  summary: {
    newProducts: number;
    newVariants: number;
    updatedProducts: number;
    updatedVariants: number;
    unchangedVariants: number;
  };
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** Binds an apply to the exact rows that were previewed. */
  fingerprint: string;
  canApply: boolean;
}

const CATEGORIES = ['WOMEN', 'MEN', 'KIDS', 'UNISEX'];
const MAX_ROWS = 2000;

/** Same ceiling and same reasoning as the bulk update: one file must not become everyone's outage. */
export const IMPORT_ROW_LIMIT = MAX_ROWS;

class ProductImportService {

  /**
   * A stable fingerprint of the rows, so apply() can prove it is applying what was shown.
   *
   * Row order is included deliberately: re-ordering a file changes which row number an error
   * refers to, and a report that points at the wrong line is worse than no report.
   */
  fingerprintOf(rows: ImportRow[]): string {
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
  }

  /**
   * The merchant's key, reduced to one spelling.
   *
   * "Kanchi" and "kanchi" are the same product to the person who typed them, and Excel
   * helpfully capitalises the first letter of a column when it feels like it. Matching on
   * the raw string meant a re-import could produce a duplicate of the very product it
   * created -- which is the failure this key exists to prevent.
   */
  private normaliseKey(v: string | undefined): string | undefined {
    const t = (v ?? '').trim().toLowerCase();
    return t || undefined;
  }

  /** Text that has to fit on a screen and in a report. */
  private readonly MAX_TEXT = 200;

  private num(v: unknown): number | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * What this file would do. Reads only.
   */
  async plan(clientId: string, rows: ImportRow[], heldPermissions: string[]): Promise<ImportPlan> {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];

    if (rows.length === 0) {
      return {
        summary: { newProducts: 0, newVariants: 0, updatedProducts: 0, updatedVariants: 0, unchangedVariants: 0 },
        errors: [{ rowNumber: 0, message: 'The file has no rows.' }],
        warnings: [], fingerprint: this.fingerprintOf(rows), canApply: false
      };
    }
    if (rows.length > MAX_ROWS) {
      return {
        summary: { newProducts: 0, newVariants: 0, updatedProducts: 0, updatedVariants: 0, unchangedVariants: 0 },
        errors: [{ rowNumber: 0, message: `This file has ${rows.length} rows. Split it into batches of ${MAX_ROWS} or fewer.` }],
        warnings: [], fingerprint: this.fingerprintOf(rows), canApply: false
      };
    }

    // ── Permissions, asked once of the whole file ────────────────────────────
    //
    // Refused whole rather than filtered quietly, exactly as the bulk update does: an import
    // that silently drops the columns you were not allowed to set leaves you believing a
    // file was applied that was not. The comment on that endpoint records why this matters
    // -- a CSV was once a way round the cost permission.
    const touchesPrice = rows.some(r => this.num(r.sellingPrice) !== undefined || this.num(r.basePrice) !== undefined);
    const touchesCost = rows.some(r => this.num(r.costPrice) !== undefined);
    const createsAnything = rows.some(r => !r.productCode);

    if (createsAnything && !grants(heldPermissions, 'product:create')) {
      errors.push({ rowNumber: 0, message: 'This file creates new products. You do not have permission to add products.' });
    }
    if (touchesPrice && !grants(heldPermissions, 'product:update')) {
      errors.push({ rowNumber: 0, message: 'This file sets selling prices. You do not have permission to change product details and prices.' });
    }
    if (touchesCost && !grants(heldPermissions, 'cost:manage')) {
      errors.push({ rowNumber: 0, message: 'This file sets cost prices. You do not have permission to change costs.' });
    }
    if (errors.length) {
      return {
        summary: { newProducts: 0, newVariants: 0, updatedProducts: 0, updatedVariants: 0, unchangedVariants: 0 },
        errors, warnings, fingerprint: this.fingerprintOf(rows), canApply: false
      };
    }

    // ── Group rows into products ────────────────────────────────────────────
    const groups = new Map<string, { key: string; isExisting: boolean; resolvedCode?: string; rows: ImportRow[] }>();
    for (const row of rows) {
      const code = row.productCode?.trim();
      const key = this.normaliseKey(row.productKey);
      if (code) {
        const id = `code:${code}`;
        if (!groups.has(id)) groups.set(id, { key: code, isExisting: true, rows: [] });
        groups.get(id)!.rows.push(row);
      } else if (key) {
        const id = `key:${key}`;
        if (!groups.has(id)) groups.set(id, { key, isExisting: false, rows: [] });
        groups.get(id)!.rows.push(row);
      } else {
        errors.push({
          rowNumber: row.rowNumber,
          message: 'No ProductCode and no ProductKey, so there is no way to tell which product this row belongs to.'
        });
      }
    }

    // ── Look up everything this file refers to ──────────────────────────────
    const codes = [...groups.values()].filter(g => g.isExisting).map(g => g.key);
    const existingProducts = codes.length
      ? await prisma.product.findMany({
          where: { clientId, productCode: { in: codes } },
          select: { id: true, productCode: true, title: true, basePrice: true }
        })
      : [];
    const productByCode = new Map(existingProducts.map(p => [p.productCode, p]));

    /*
     * A ProductKey that has been imported before is not new.
     *
     * Without this the importer could not recognise its own work: the same file uploaded
     * twice reported "2 new products" the second time, because the rows carry the
     * merchant's key and the products carry a generated code. Storing the key on import is
     * what closes that, and it is the whole basis of the promise that re-running a file is
     * safe.
     */
    const keys = [...groups.values()].filter(g => !g.isExisting).map(g => g.key);
    const byImportKey = keys.length
      ? await prisma.product.findMany({
          where: { clientId, importKey: { in: keys } },
          select: { id: true, productCode: true, importKey: true }
        })
      : [];
    const productByImportKey = new Map(byImportKey.map(p => [p.importKey!, p]));

    // Re-label: a key we have seen before behaves exactly like a known product code.
    for (const group of groups.values()) {
      if (!group.isExisting && productByImportKey.has(group.key)) {
        const found = productByImportKey.get(group.key)!;
        group.isExisting = true;
        group.resolvedCode = found.productCode;
        productByCode.set(found.productCode, { id: found.id, productCode: found.productCode, title: '', basePrice: null as any });
      }
    }

    // Explicit SKUs from the file, plus the ones a blank cell will resolve to for products
    // we already know about.
    const derived: string[] = [];
    for (const group of groups.values()) {
      const known = group.isExisting ? productByCode.get(group.resolvedCode ?? group.key) : undefined;
      if (!known) continue;
      for (const r of group.rows) {
        if (!r.sku?.trim()) derived.push(this.buildSku(known.productCode, r.color, r.size));
      }
    }
    const skus = [...rows.map(r => r.sku?.trim()).filter(Boolean) as string[], ...derived];
    const existingVariants = skus.length
      ? await prisma.productVariant.findMany({
          where: { clientId, sku: { in: skus } },
          select: { id: true, sku: true, productId: true, size: true, colorName: true, sellingPrice: true, costPrice: true, reorderLevel: true }
        })
      : [];
    const variantBySku = new Map(existingVariants.map(v => [v.sku, v]));

    let newProducts = 0, newVariants = 0, updatedVariants = 0, unchangedVariants = 0;
    const touchedExistingProducts = new Set<string>();
    const seenSkus = new Set<string>();

    /*
     * The names this shop already uses, so the file can say "you already have one of these".
     *
     * Scoped to this client, like every other lookup here. Fetched once rather than per group:
     * a file of 300 products would otherwise be 300 queries to answer a warning.
     */
    const existingTitles = new Set(
      (await prisma.product.findMany({
        where: { clientId, trashedAt: null },
        select: { title: true }
      })).map(p => this.normaliseKey(p.title)!).filter(Boolean)
    );
    /** Titles this file itself creates, so two new products with one name are caught too. */
    const newTitles = new Map<string, string>();

    for (const group of groups.values()) {
      const product = group.isExisting ? productByCode.get(group.resolvedCode ?? group.key) : undefined;
      /*
       * Within one product, size + colour IS the variant.
       *
       * A blank SKU is derived from productCode-COLOUR-SIZE, so two rows of the same product
       * with the same size and no colour resolve to the same SKU -- and [clientId, sku] is
       * unique, so the second insert would fail at apply time. The preview said "2 new
       * variants, ready to import", which is the one thing it must never do: promise
       * something that will not happen.
       *
       * Checked on the pair rather than on the derived SKU so it reads as what it is, and so
       * it holds for rows that supply a size and colour but no SKU under an existing product
       * too.
       */
      const seenPairs = new Set<string>();

      if (group.isExisting && !product) {
        // Deliberately an error, not a create. A typo in a product code must not quietly
        // produce a second product -- the merchant would end up with two of everything and
        // no obvious moment where it happened.
        for (const r of group.rows) {
          errors.push({ rowNumber: r.rowNumber, message: `ProductCode ${group.key} does not exist. Check the code, or leave it blank and use a ProductKey to create a new product.` });
        }
        continue;
      }

      if (!group.isExisting) {
        const withTitle = group.rows.find(r => r.title?.trim());
        const withCategory = group.rows.find(r => r.category?.trim());
        const withPrice = group.rows.find(r => this.num(r.basePrice) !== undefined);
        if (!withTitle) {
          errors.push({ rowNumber: group.rows[0].rowNumber, message: `New product "${group.key}" has no Title on any of its rows.` });
          continue;
        }
        if (!withCategory || !CATEGORIES.includes(withCategory.category!.trim().toUpperCase())) {
          errors.push({ rowNumber: group.rows[0].rowNumber, message: `New product "${group.key}" needs a Category, one of: ${CATEGORIES.join(', ')}.` });
          continue;
        }
        if (!withPrice) {
          errors.push({ rowNumber: group.rows[0].rowNumber, message: `New product "${group.key}" has no BasePrice on any of its rows.` });
          continue;
        }

        /*
         * A name that is already taken.
         *
         * The title is NOT identity here -- ProductKey is -- and that is the right model: a
         * shop can genuinely stock two different "Red Silk Saree". But it is also exactly what
         * happens when somebody forgets to put the ProductCode on rows meant to UPDATE an
         * existing product: the file quietly creates a second one, and the shopkeeper has two
         * of everything with no moment where it went wrong.
         *
         * So: a warning, never an error. The merchant is told and decides.
         */
        const title = withTitle.title!.trim();
        const titleKey = this.normaliseKey(title)!;
        const clash = newTitles.get(titleKey);
        if (clash) {
          warnings.push({
            rowNumber: withTitle.rowNumber,
            message: `"${title}" is created twice by this file, under ProductKey "${clash}" and "${group.key}". If these are the same saree, give both rows one ProductKey.`
          });
        } else if (existingTitles.has(titleKey)) {
          warnings.push({
            rowNumber: withTitle.rowNumber,
            message: `You already have a product called "${title}". This adds a second one. To update the one you have, export it and use its ProductCode.`
          });
        }
        newTitles.set(titleKey, group.key);

        newProducts++;
      }

      for (const row of group.rows) {
        if (!row.sku?.trim()) {
          const pair = `${(row.size || '').trim().toLowerCase()}|${(row.color || '').trim().toLowerCase()}`;
          if (seenPairs.has(pair)) {
            const describe = [row.size?.trim(), row.color?.trim()].filter(Boolean).join(' / ') || 'no size and no colour';
            errors.push({
              rowNumber: row.rowNumber,
              message: `This product already has a "${describe}" row in this file. Give the rows different sizes or colours, or set an SKU on each.`
            });
            continue;
          }
          seenPairs.add(pair);
        }

        /*
         * A blank SKU still names a specific variant.
         *
         * apply() derives it as productCode-COLOUR-SIZE, so for a product we already know,
         * the plan can derive exactly the same string and discover that the variant exists.
         * Without this the preview reported "2 new variants" for a file it would in fact
         * have updated -- the import was safe, but the report was not honest about it, and
         * a report nobody can trust is worse than no report.
         *
         * Only for known products: a brand-new one has no code yet, and everything under it
         * genuinely is new.
         */
        const sku = row.sku?.trim()
          || (product ? this.buildSku(product.productCode, row.color, row.size) : undefined);

        if (sku && seenSkus.has(sku)) {
          errors.push({ rowNumber: row.rowNumber, message: `SKU ${sku} appears more than once in this file.` });
          continue;
        }
        if (sku) seenSkus.add(sku);

        const existing = sku ? variantBySku.get(sku) : undefined;

        if (existing) {
          if (product && existing.productId !== product.id) {
            errors.push({ rowNumber: row.rowNumber, message: `SKU ${sku} already belongs to a different product.` });
            continue;
          }
          if (!product) {
            errors.push({ rowNumber: row.rowNumber, message: `SKU ${sku} already exists, so this row cannot create a new product. Use its ProductCode to update it.` });
            continue;
          }
          /*
           * Quantity is OPENING stock, and an existing variant has already opened.
           *
           * If every run posted the quantity again, re-uploading a file would not duplicate
           * products -- it would silently double the stock, which is worse, because nothing
           * on screen contradicts it until somebody counts the shelf. Changing the stock of
           * variants that already exist is what Import Updates is for, and it says so.
           */
          const changes =
            (this.num(row.sellingPrice) !== undefined && Number(existing.sellingPrice ?? NaN) !== this.num(row.sellingPrice)) ||
            (this.num(row.costPrice) !== undefined && Number(existing.costPrice ?? NaN) !== this.num(row.costPrice)) ||
            (this.num(row.reorderLevel) !== undefined && existing.reorderLevel !== this.num(row.reorderLevel));
          if (changes) { updatedVariants++; touchedExistingProducts.add(existing.productId); }
          else unchangedVariants++;

          if (this.num(row.quantity) !== undefined && this.num(row.quantity)! > 0) {
            warnings.push({
              rowNumber: row.rowNumber,
              message: `${sku} already exists, so its Quantity is ignored — importing it again would add the stock a second time. Use Import Updates to change stock.`
            });
          }
        } else {
          if (!row.size?.trim() && !row.color?.trim()) {
            errors.push({ rowNumber: row.rowNumber, message: 'A new variant needs at least a Size or a Colour.' });
            continue;
          }
          newVariants++;
          if (product) touchedExistingProducts.add(product.id);
        }

        // ── Text that is too long to be a name ──────────────────────────────
        //
        // Postgres text has no limit, so a pasted paragraph is stored happily and then
        // breaks every screen that renders it. Caught here rather than discovered later
        // on a product card.
        for (const [label, value] of [
          ['Title', row.title], ['Color', row.color], ['Size', row.size],
          ['DressType', row.dressType], ['Fabric', row.fabric], ['Brand', row.brand], ['SKU', row.sku]
        ] as const) {
          if (typeof value === 'string' && value.trim().length > this.MAX_TEXT) {
            errors.push({ rowNumber: row.rowNumber, message: `${label} is ${value.trim().length} characters. Keep it under ${this.MAX_TEXT}.` });
          }
        }

        // ── Numbers must be numbers of the right shape ──────────────────────
        //
        // The same rules bulkUpdateVariantSchema enforces, because a file should not be
        // able to write through this endpoint what the other one would refuse. Left
        // unchecked these do not bounce off the database politely: quantity and
        // reorderLevel are integer columns, so 2.5 is truncated or throws at apply time,
        // and a negative price is simply stored and then shown to customers.
        for (const [label, value, rule] of [
          ['Quantity', row.quantity, 'int>=0'],
          ['ReorderLevel', row.reorderLevel, 'int>=0'],
          ['BasePrice', row.basePrice, 'money>0'],
          ['SellingPrice', row.sellingPrice, 'money>0'],
          ['CostPrice', row.costPrice, 'money>=0']
        ] as const) {
          const n = this.num(value);
          if (n === undefined) continue;
          if (rule === 'int>=0') {
            if (!Number.isInteger(n)) errors.push({ rowNumber: row.rowNumber, message: `${label} must be a whole number, not ${n}.` });
            else if (n < 0) errors.push({ rowNumber: row.rowNumber, message: `${label} cannot be negative.` });
          } else if (rule === 'money>0') {
            if (n <= 0) errors.push({ rowNumber: row.rowNumber, message: `${label} must be more than zero.` });
          } else {
            if (n < 0) errors.push({ rowNumber: row.rowNumber, message: `${label} cannot be negative.` });
          }
        }

        // ── Warnings ────────────────────────────────────────────────────────
        const qty = this.num(row.quantity);
        const cost = this.num(row.costPrice);
        const isNewVariant = !existing;
        if (isNewVariant && qty !== undefined && qty > 0 && cost === undefined) {
          // Not pedantry. Stock that enters valued at zero drags the weighted average cost
          // down, and the first purchase order is then averaged against a number that was
          // never true -- which once priced a 4,999 saree at 98 rupees.
          warnings.push({ rowNumber: row.rowNumber, message: 'Quantity with no CostPrice. This stock will enter valued at zero, which skews the cost average on your first purchase order.' });
        }
      }
    }

    /*
     * What a new product is when it arrives, said before the button is pressed.
     *
     * A file carries no photographs, so imported products are created as drafts -- a
     * storefront listing with no picture is worse than one not yet listed. That is the right
     * behaviour and the wrong secret: somebody imports two hundred sarees, goes to look at
     * the shop, and finds nothing there. Row 0 means "this is about the file", the same
     * convention the permission refusals use.
     */
    if (newProducts > 0 && errors.length === 0) {
      warnings.push({
        rowNumber: 0,
        message: `${newProducts} new ${newProducts === 1 ? 'product arrives' : 'products arrive'} as a draft, because a file cannot carry photographs. Add photos, then publish from the product page.`
      });
    }

    return {
      summary: {
        newProducts,
        newVariants,
        updatedProducts: touchedExistingProducts.size,
        updatedVariants,
        unchangedVariants
      },
      errors,
      warnings,
      fingerprint: this.fingerprintOf(rows),
      canApply: errors.length === 0
    };
  }

  /**
   * Writes the file.
   *
   * Re-plans first and refuses on any error or on a fingerprint that does not match the
   * preview, so an apply can never be the first time these rows were examined.
   */
  async apply(
    clientId: string,
    rows: ImportRow[],
    heldPermissions: string[],
    userId: string | undefined,
    fingerprint: string
  ) {
    const plan = await this.plan(clientId, rows, heldPermissions);

    if (plan.fingerprint !== fingerprint) {
      throw { statusCode: 409, message: 'This file has changed since it was previewed. Upload it again to see what it would do.' };
    }
    if (!plan.canApply) {
      throw { statusCode: 400, message: 'This file still has errors. Fix them and preview again.' };
    }

    const importId = `IMP-${Date.now().toString(36).toUpperCase()}`;
    const location = await prisma.stockLocation.findFirst({
      where: { clientId, active: true },
      orderBy: [{ code: 'asc' }],
      select: { id: true, code: true }
    });
    if (!location) throw { statusCode: 400, message: 'This shop has no stock location, so imported stock has nowhere to go.' };

    const swatches = await this.swatchesFor(clientId);

    // Group again, this time to write.
    const groups = new Map<string, { key: string; isExisting: boolean; rows: ImportRow[] }>();
    for (const row of rows) {
      const code = row.productCode?.trim();
      const key = this.normaliseKey(row.productKey);
      const id = code ? `code:${code}` : `key:${key}`;
      if (!groups.has(id)) groups.set(id, { key: code || key!, isExisting: !!code, rows: [] });
      groups.get(id)!.rows.push(row);
    }

    let createdProducts = 0, createdVariants = 0, updatedVariants = 0, stockMovements = 0;

    for (const group of groups.values()) {
      // One transaction per PRODUCT, not per file.
      //
      // A file of three hundred sarees should not be one transaction: it would hold locks
      // across the whole import and, on a pooled connection, is exactly the shape that times
      // out halfway and leaves nothing. Per product, a failure costs one product -- and
      // because the importer is keyed on ProductCode and SKU, re-running the file finishes
      // the job instead of duplicating it.
      await prisma.$transaction(async (tx) => {
        let productId: string;
        let productCode: string;

        // A key this shop has imported before names a product that already exists, so the
        // same file run twice updates rather than duplicates.
        const found = group.isExisting
          ? await tx.product.findFirst({ where: { clientId, productCode: group.key }, select: { id: true, productCode: true } })
          : await tx.product.findFirst({ where: { clientId, importKey: group.key }, select: { id: true, productCode: true } });

        if (found) {
          productId = found.id;
          productCode = found.productCode;
        } else if (group.isExisting) {
          return; // planned against, cannot happen; skip rather than throw
        } else {
          const seed = group.rows.find(r => r.title?.trim())!;
          const cat = group.rows.find(r => r.category?.trim())!.category!.trim().toUpperCase();
          const price = group.rows.map(r => this.num(r.basePrice)).find(v => v !== undefined)!;
          const code = await generateSequentialCode(clientId, 'PRD', 'PRODUCT');
          const slug = `${seed.title!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')}-${code.toLowerCase()}`;

          const created = await tx.product.create({
            data: {
              clientId, productCode: code, slug,
              title: seed.title!.trim(),
              description: group.rows.find(r => r.description?.trim())?.description?.trim() || null,
              category: cat as any,
              // READY_TO_WEAR because an imported row describes a garment that exists and
              // has a quantity. CUSTOM is made to order and has no stock to import.
              productType: 'READY_TO_WEAR',
              dressType: group.rows.find(r => r.dressType?.trim())?.dressType?.trim() || null,
              fabric: group.rows.find(r => r.fabric?.trim())?.fabric?.trim() || null,
              craft: group.rows.find(r => r.craft?.trim())?.craft?.trim() || null,
              brand: group.rows.find(r => r.brand?.trim())?.brand?.trim() || null,
              basePrice: new Prisma.Decimal(price),
              // Kept so a re-run of this file finds this product instead of making another.
              importKey: group.key,
              // DRAFT on purpose: an imported product has no photographs yet, and a
              // storefront listing with no picture is worse than one not yet listed. The
              // merchant publishes when it is ready.
              status: 'DRAFT'
            },
            select: { id: true, productCode: true }
          });
          productId = created.id;
          productCode = created.productCode;
          createdProducts++;
        }

        for (const row of group.rows) {
          const sku = row.sku?.trim() || this.buildSku(productCode, row.color, row.size);
          const existing = await tx.productVariant.findFirst({ where: { clientId, sku }, select: { id: true } });

          let variantId: string;

          if (existing) {
            const data: Prisma.ProductVariantUncheckedUpdateInput = {};
            // Only what the file actually supplied. A blank cell leaves the value alone.
            if (this.num(row.sellingPrice) !== undefined) data.sellingPrice = new Prisma.Decimal(this.num(row.sellingPrice)!);
            if (this.num(row.costPrice) !== undefined) data.costPrice = new Prisma.Decimal(this.num(row.costPrice)!);
            if (this.num(row.reorderLevel) !== undefined) data.reorderLevel = this.num(row.reorderLevel)!;
            if (Object.keys(data).length) {
              await tx.productVariant.update({ where: { id: existing.id }, data });
              updatedVariants++;
            }
            variantId = existing.id;
          } else {
            const variantCode = await generateSequentialCode(clientId, 'VAR', 'VARIANT', tx as any);
            const created = await tx.productVariant.create({
              data: {
                clientId, productId, sku, variantCode,
                size: row.size?.trim() || null,
                colorName: row.color?.trim() || null,
                // The swatch, when the shop's own palette knows this colour by name. A
                // variant added through the form carries one; one added by import did not, so
                // the same "Royal Blue" drew a dot on one screen and nothing on another. A
                // colour the palette has never heard of is left without one rather than
                // guessed at -- see lib/colorNames for why an invented colour is worse.
                ...(swatches.get(this.normaliseKey(row.color) ?? '') ? { hexCode: swatches.get(this.normaliseKey(row.color)!)! } : {}),
                ...(this.num(row.sellingPrice) !== undefined ? { sellingPrice: new Prisma.Decimal(this.num(row.sellingPrice)!) } : {}),
                ...(this.num(row.costPrice) !== undefined ? { costPrice: new Prisma.Decimal(this.num(row.costPrice)!) } : {}),
                reorderLevel: this.num(row.reorderLevel) ?? 5
              },
              select: { id: true }
            });
            variantId = created.id;
            createdVariants++;
          }

          // ── Opening stock, as a movement ────────────────────────────────
          //
          // Never written straight onto the stock row. Stock in a real system does not
          // simply exist, it arrives, and the ledger has to say why -- otherwise Inventory
          // History shows a balance nobody can account for. Carrying the import's id means
          // every imported unit is traceable to the file that created it.
          // Opening stock only. See the note in plan(): posting it on every run would
          // double the shelf every time somebody re-uploaded their file.
          const qty = this.num(row.quantity);
          if (!existing && qty !== undefined && qty > 0) {
            await inventoryMutationService.applyMovement({
              clientId, variantId, locationId: location.id,
              movementType: 'IN', reason: 'INITIAL_STOCK',
              quantityDelta: qty,
              unitCost: this.num(row.costPrice),
              notes: `Imported (${importId})`,
              referenceType: 'IMPORT', referenceId: importId,
              createdBy: userId, tx
            });
            stockMovements++;
          }
        }
      }, { timeout: 30000 });
    }

    return { importId, createdProducts, createdVariants, updatedVariants, stockMovements };
  }

  /**
   * The same SKU rule the rest of the app uses, so an imported variant is indistinguishable
   * from one added by hand. Never invents a prefix -- the product code is always present.
   */
  /**
   * Every colour name this shop knows, and the colour it stands for.
   *
   * Covers base colours and their named shades alike, because a spreadsheet says "Royal Blue"
   * without caring which of the two it is. Built once per import rather than per row.
   */
  private async swatchesFor(clientId: string): Promise<Map<string, string>> {
    const colors = await prisma.clientCatalogItem.findMany({
      where: { clientId, type: 'COLOR', isActive: true },
      select: { label: true, metadata: true }
    });

    const map = new Map<string, string>();
    for (const color of colors) {
      const meta = readColorMetadata(color.metadata, color.label);
      if (!meta) continue;
      const base = this.normaliseKey(color.label);
      // First wins, so a shade never displaces the base colour it belongs to.
      if (base && !map.has(base)) map.set(base, meta.hex);
      for (const shade of meta.shades) {
        const key = this.normaliseKey(shade.name);
        if (key && !map.has(key)) map.set(key, shade.hex);
      }
    }
    return map;
  }

  private buildSku(productCode: string, color?: string, size?: string): string {
    const safe = (v: string | undefined, len: number) =>
      (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, len);
    return `${productCode}-${safe(color, 3) || 'STD'}-${safe(size, 8) || 'STD'}`;
  }
}

export const productImportService = new ProductImportService();
