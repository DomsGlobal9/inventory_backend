import { z } from 'zod';
import { ProductCategory, ProductType, ProductStatus } from '@prisma/client';

export const createProductSchema = z.object({
  productCode: z.string().optional(),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  category: z.nativeEnum(ProductCategory),
  productType: z.nativeEnum(ProductType),
  dressType: z.string().optional(),
  fabric: z.string().optional(),
  craft: z.string().optional(),
  brand: z.string().optional(),
  // Non-negative here, with the "must be positive" rule applied below only to products
  // that are actually going live. A DRAFT is a save-point for something unfinished -- the
  // price is often the last thing decided -- and every comparable catalogue (Shopify, Zoho)
  // lets you park one without it. Requiring it here meant Save as Draft could only ever
  // 400, since the review screen offers drafts before pricing is settled.
  basePrice: z.number().nonnegative("Base price cannot be negative"),
  status: z.nativeEnum(ProductStatus).optional()
}).superRefine((val, ctx) => {
  // Anything that is not explicitly a draft is going into the sellable catalogue, so it
  // still needs a real price. Publishing a draft later goes through the same check.
  if (val.status !== ProductStatus.DRAFT && !(val.basePrice > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['basePrice'],
      message: "Base price must be positive to publish -- save it as a draft instead"
    });
  }
});

// createProductSchema is a ZodEffects once superRefine is attached, and ZodEffects has no
// .partial(). Derive the update schema from the underlying object instead -- a partial
// update has no complete picture of the product anyway, so the publish-price rule above
// belongs to creation and to the status transition, not here.
export const updateProductSchema = createProductSchema.innerType().partial();

export const productQuerySchema = z.object({
  page: z.preprocess((val) => val === undefined ? 1 : parseInt(String(val), 10), z.number().min(1).default(1)),
  limit: z.preprocess((val) => val === undefined ? 20 : parseInt(String(val), 10), z.number().min(1).max(100).default(20)),
  search: z.string().optional(),
  status: z.nativeEnum(ProductStatus).optional(),
  category: z.nativeEnum(ProductCategory).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'title', 'basePrice']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc')
});
