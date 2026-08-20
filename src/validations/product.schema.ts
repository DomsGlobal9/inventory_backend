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
  basePrice: z.number().positive("Base price must be positive"),
  status: z.nativeEnum(ProductStatus).optional()
});

export const updateProductSchema = createProductSchema.partial();

export const productQuerySchema = z.object({
  page: z.preprocess((val) => val === undefined ? 1 : parseInt(String(val), 10), z.number().min(1).default(1)),
  limit: z.preprocess((val) => val === undefined ? 20 : parseInt(String(val), 10), z.number().min(1).max(100).default(20)),
  search: z.string().optional(),
  status: z.nativeEnum(ProductStatus).optional(),
  category: z.nativeEnum(ProductCategory).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'title', 'basePrice']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc')
});
