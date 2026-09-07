import { z } from 'zod';

export const createVariantSchema = z.object({
  sku: z.string().min(1, "SKU is required"),
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
  applyToAllLocations: z.boolean().optional().default(false)
});

export const bulkUpdateVariantSchema = z.object({
  updates: z.array(z.object({
    sku: z.string().min(1, "SKU is required"),
    quantity: z.number().int().min(0).optional(),
    priceOverride: z.number().positive().optional(),
    sellingPrice: z.number().positive().optional(),
    costPrice: z.number().positive().optional(),
    reorderLevel: z.number().int().min(0).optional(),
  })).min(1, "At least one update is required"),
  // Where a `quantity` applies. A quantity is a level at one place, and a business with a
  // warehouse and a shop has no single obvious answer, so the caller states it. Ownership is
  // checked against the tenant before it is used. Optional: a file that only sets prices or
  // reorder levels changes properties of the variant itself and needs no location.
  locationId: z.string().uuid().optional()
});
