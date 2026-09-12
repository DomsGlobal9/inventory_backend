import { z } from 'zod';
import { ProductImageType } from '@prisma/client';

export const createImageSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  /**
   * Which colour this photograph is OF.
   *
   * The column has existed since the beginning and not one of the 54 images in the database
   * carries it -- every photo has only ever been attached to the product as a whole. For a
   * shop selling one saree in five colours that is the wrong grain: the Images tab shows a
   * single pile, and nothing says which colour still has no picture of it.
   *
   * Optional, because a shot of the fabric or the border genuinely belongs to the product
   * rather than to one colour.
   */
  variantId: z.string().uuid().optional(),
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
