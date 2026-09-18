import { z } from 'zod';
import { isWholePaise, PAISA_MESSAGE } from './money';

export const createDraftOrdersSchema = z.object({
  // The store the suggestions were for; without one, the store selected at the top of the app.
  locationId: z.string().min(1).optional().nullable(),
  groups: z.array(z.object({
    supplierId: z.string().uuid("A supplier must be selected"),
    items: z.array(z.object({
      variantId: z.string().uuid(),
      // A zero-quantity line is not an order for nothing, it is a line the user meant to
      // deselect -- rejecting it surfaces the mistake instead of creating an empty PO.
      // The same caps as a purchase order raised by hand: these lines become one.
      orderedQty: z.number().int('Order whole pieces.').positive("Quantity must be at least 1")
        .max(1_000_000, 'That is more pieces than any delivery can hold. Check the quantity.'),
      unitPrice: z.number().nonnegative("Price cannot be negative")
        .max(10_000_000, 'That price looks wrong. Enter what one piece costs.')
        .refine(isWholePaise, PAISA_MESSAGE)
    })).min(1, "Each supplier needs at least one item")
  })).min(1, "Select at least one item to order")
});
