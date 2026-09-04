import { z } from 'zod';

export const createDraftOrdersSchema = z.object({
  groups: z.array(z.object({
    supplierId: z.string().uuid("A supplier must be selected"),
    items: z.array(z.object({
      variantId: z.string().uuid(),
      // A zero-quantity line is not an order for nothing, it is a line the user meant to
      // deselect -- rejecting it surfaces the mistake instead of creating an empty PO.
      orderedQty: z.number().int().positive("Quantity must be at least 1"),
      unitPrice: z.number().nonnegative("Price cannot be negative")
    })).min(1, "Each supplier needs at least one item")
  })).min(1, "Select at least one item to order")
});
