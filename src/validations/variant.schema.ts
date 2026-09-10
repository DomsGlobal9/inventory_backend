import { z } from 'zod';

export const createVariantSchema = z.object({
  sku: z.string().trim().min(1, "Give the variant an SKU"),
  size: z.string().optional(),
  colorName: z.string().optional(),
  hexCode: z.string().optional(),
  quantity: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(5),
  priceOverride: z.number().positive().optional(),
  // The price a customer actually pays for this specific size/color, and what it cost
  // to acquire -- previously accepted nowhere (silently stripped by this schema), so a
  // variant could never have its own price even though the DB column existed.
  // Nullable (not just optional): clearing the field is a real, supported action --
  // it removes the variant-specific override and falls back to the product's basePrice
  // (see resolveVariantForLocation) -- not merely "no value sent".
  sellingPrice: z.number().positive().nullable().optional(),
  costPrice: z.number().positive().nullable().optional(),
  locationId: z.string().optional()
});

export const updateVariantSchema = createVariantSchema.partial();

export const bulkCreateVariantSchema = z.object({
  variants: z.array(createVariantSchema).min(1, "At least one variant is required"),
  locationId: z.string().optional(),
  applyToAllLocations: z.boolean().optional().default(false),
  // Who these are bought from. Optional -- plenty of stock is made in-house or has no
  // supplier worth recording -- but until now there was no way to say it at all: the link
  // was only ever created as a side effect of raising a purchase order, so every supplier's
  // item list stayed empty until after you had already ordered from them.
  supplierId: z.string().optional()
});

export const bulkUpdateVariantSchema = z.object({
  updates: z.array(z.object({
    sku: z.string().trim().min(1, "Give the variant an SKU"),
    quantity: z.number().int().min(0).optional(),
    priceOverride: z.number().positive().optional(),
    sellingPrice: z.number().positive().optional(),
    costPrice: z.number().positive().optional(),
    reorderLevel: z.number().int().min(0).optional(),
  }))
    .min(1, "At least one update is required")
    // A ceiling, because this endpoint is a loop over rows and each row is several database
    // round trips. Without one, a single request could queue unbounded work on a pool shared
    // with every other tenant -- so one merchant's oversized file becomes everyone's outage.
    // Two thousand covers any real catalogue file; larger ones should be split, and the
    // message says so rather than failing at some opaque timeout later.
    .max(2000, "Too many rows in one request. Split the file into batches of 2000 or fewer."),
  // Where a `quantity` applies. A quantity is a level at one place, and a business with a
  // warehouse and a shop has no single obvious answer, so the caller states it. Ownership is
  // checked against the tenant before it is used. Optional: a file that only sets prices or
  // reorder levels changes properties of the variant itself and needs no location.
  locationId: z.string().uuid().optional()
});
