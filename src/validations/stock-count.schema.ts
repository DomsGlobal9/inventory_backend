import { z } from 'zod';

export const stockCountCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  locationId: z.string().min(1, "Location ID is required"),
  categoryId: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable()
});

export const stockCountUpdateItemSchema = z.object({
  // Nullable: countedQty null means "not yet counted" (see stock-count.service.ts's
  // completeCount, which already treats null specially) -- clearing a previously-entered
  // count back to that state is a real, meaningful action, not just "no value sent".
  countedQty: z.number().min(0, "Counted quantity must be >= 0").nullable()
});
