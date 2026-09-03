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
    quantityReceived: z.number().min(0, "Quantity must be >= 0"),
    locationId: z.string().optional().nullable()
  })).min(1, "At least one receipt is required")
});
