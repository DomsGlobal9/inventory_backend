import { z } from 'zod';
import { ProductImageType } from '@prisma/client';

export const createImageSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  imageType: z.nativeEnum(ProductImageType).default(ProductImageType.GALLERY),
  orderIndex: z.number().int().default(0),
  storagePath: z.string().optional(),
  fileName: z.string().optional(),
  fileSize: z.number().int().optional(),
  altText: z.string().optional(),
  isPrimary: z.boolean().default(false)
});

export const updateImageSchema = z.object({
  altText: z.string().optional(),
  isPrimary: z.boolean().optional(),
  orderIndex: z.number().int().optional()
});
