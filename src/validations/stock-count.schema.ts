import { z } from 'zod';

export const stockCountCreateSchema = z.object({
  name: z.string().trim().min(1, "Give the count a name"),
  locationId: z.string().min(1, "Location ID is required"),
  categoryId: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable()
});

export const stockCountUpdateItemSchema = z.object({
  // Nullable: countedQty null means "not yet counted" (see stock-count.service.ts's
  // completeCount, which already treats null specially) -- clearing a previously-entered
  // count back to that state is a real, meaningful action, not just "no value sent".
  countedQty: z.number({ invalid_type_error: 'Type how many pieces you counted, as a number.' })
    .int('Count whole pieces, for example 3, not 2.5.')
    .min(0, 'A count cannot be less than 0. Type how many pieces are on the shelf, or 0 if there are none.')
    .nullable()
});
