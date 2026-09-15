import { z } from 'zod';

export const purchaseOrderCreateSchema = z.object({
  supplierId: z.string().min(1, "Supplier ID is required"),
  expectedDeliveryDate: z.string().datetime().optional().nullable().or(z.date().optional()),
  notes: z.string().optional().nullable(),
  items: z.array(z.object({
    variantId: z.string().min(1, "Variant ID is required"),
    orderedQty: z.number().positive("Quantity must be positive"),
    unitPrice: z.number().min(0, "Unit price must be >= 0"),
    productTitle: z.string().optional().nullable(),
    color: z.string().optional().nullable(),
    size: z.string().optional().nullable()
  })).min(1, "At least one item is required")
});

export const purchaseOrderReceiveSchema = z.object({
  receipts: z.array(z.object({
    poItemId: z.string().min(1, "PO Item ID is required"),
    // Whole pieces. 2.5 used to pass here and then fail against the integer column as a
    // database error, which is a 500 for what is only a typing mistake.
    quantityReceived: z.number().int('Whole pieces only.').min(0, "Quantity must be >= 0"),
    locationId: z.string().optional().nullable()
  })).min(1, "At least one receipt is required"),
  locationId: z.string().optional().nullable(),
  // Who took the goods. Required: a receipt handed to a supplier has to name somebody, and the
  // account entering it is often not the person who signed for the boxes.
  receivedByName: z.string({ required_error: 'Enter the name of the person who received the goods.' })
    .trim().min(2, 'Enter the name of the person who received the goods.').max(80, 'Keep the name under 80 characters.'),
  receivedByPhone: z.string().trim().max(20, 'That phone number is too long.')
    .regex(/^[0-9+()\-\s]*$/, 'Use digits, spaces, + and - only for the phone number.').optional().nullable(),
  supplierReference: z.string().trim().max(80, 'Keep the invoice or challan number under 80 characters.').optional().nullable(),
  notes: z.string().trim().max(500, 'Keep the note under 500 characters.').optional().nullable(),
  requestKey: z.string().trim().min(8).max(100).optional().nullable()
});
