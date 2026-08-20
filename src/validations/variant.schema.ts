import { z } from 'zod';

export const createVariantSchema = z.object({
  sku: z.string().min(1, "SKU is required"),
  size: z.string().optional(),
  colorName: z.string().optional(),
  hexCode: z.string().optional(),
  quantity: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(5),
  priceOverride: z.number().positive().optional()
});

export const updateVariantSchema = createVariantSchema.partial();

export const bulkCreateVariantSchema = z.object({
  variants: z.array(createVariantSchema).min(1, "At least one variant is required")
});

export const bulkUpdateVariantSchema = z.object({
  updates: z.array(z.object({
    sku: z.string().min(1, "SKU is required"),
    quantity: z.number().int().min(0).optional(),
    priceOverride: z.number().positive().optional(),
    reorderLevel: z.number().int().min(0).optional(),
  })).min(1, "At least one update is required")
});
