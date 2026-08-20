import { z } from 'zod';

export const stockChangeSchema = z.object({
  variantId: z.string().uuid("Invalid variant ID"),
  quantity: z.number(), // some routes require positive, some allow negative, controller logic checks
  reason: z.string().optional(),
  referenceType: z.string().optional(),
  reference: z.string().optional(),
  unitCost: z.number().optional(),
  notes: z.string().optional()
});
