import { z } from 'zod';
import { TransactionType, InventoryReason } from '@prisma/client';

export const createTransactionSchema = z.object({
  variantId: z.string().uuid("Invalid variant ID"),
  type: z.nativeEnum(TransactionType),
  // SHELF_MOVE is written only by the shelves service, as legs of a quantity-0 movement.
  reason: z.nativeEnum(InventoryReason).refine(r => r !== 'SHELF_MOVE', { message: 'Use Put away or Move to move stock between shelves.' }),
  quantity: z.number().int().refine(val => val !== 0, { message: "Quantity cannot be zero" }),
  notes: z.string().optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  metadata: z.record(z.any()).optional()
});

export const getTransactionsSchema = z.object({
  productId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  type: z.nativeEnum(TransactionType).optional(),
  reason: z.nativeEnum(InventoryReason).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
