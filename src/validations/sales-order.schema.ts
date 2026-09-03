import { z } from 'zod';

// This validates POST /sales-orders, which creates an EMPTY draft
// (salesOrderService.createDraftOrder / sales-order.controller.ts's createOrder) —
// items are added afterward one at a time via POST /:id/items. The controller never
// reads req.body.items at all, so requiring it here (as a previous version of this
// schema did) blocked every legitimate draft-order creation for no functional reason.
// locationId is optional too: the frontend doesn't always know the active location
// when starting a draft, and there's no current fallback resolution left in the
// controller (that was removed when this validation was added) — flagged as a
// separate known gap, not fixed here since it needs a UI decision, not just validation.
export const createOrderSchema = z.object({
  customerId: z.string().min(1, "Customer ID is required").optional().nullable(), // optional if externalCustomerId is provided
  externalCustomerId: z.string().optional().nullable(),
  locationId: z.string().min(1).optional().nullable(),
}).refine(data => data.customerId || data.externalCustomerId, {
  message: "Either customerId or externalCustomerId is required",
  path: ["customerId"]
});

// POST /sales-orders/full is the ingestion endpoint for orders raised OUTSIDE inventory
// (storefront, POS, marketplace). Inventory never originates a sales order itself, so this
// schema is the contract those systems are held to -- and z.object() strips whatever isn't
// declared. Three fields the service reads were missing, each with a silent consequence:
//   - sourceSystem: half of the (externalOrderId, sourceSystem) idempotency key. Stripped,
//     the dedupe lookup could never match, so every retry of a webhook created a duplicate order.
//   - status: 'CONFIRMED' is how a paid storefront order asks for its stock to be reserved.
//     Stripped, every order landed as DRAFT and nothing was ever reserved -- the same units
//     stayed sellable to the next customer.
//   - taxAmount / discountAmount / shippingAmount: forced to 0, so the order total the
//     customer was charged never matched the total recorded here.
// customer.externalId + name/phone/addresses drive the auto-create-customer branch in
// createFullOrder; without them an unknown storefront shopper could not be synced at all.
export const createFullOrderSchema = z.object({
  customer: z.object({
    id: z.string().min(1).optional().nullable(),
    externalId: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    email: z.string().email().optional().nullable(),
    billingAddress: z.string().optional().nullable(),
    shippingAddress: z.string().optional().nullable()
  }).refine(c => c.id || c.externalId, {
    message: "Either customer.id or customer.externalId is required"
  }),
  locationId: z.string().min(1, "Location ID is required"),
  externalOrderId: z.string().optional().nullable(),
  sourceSystem: z.string().optional().nullable(),
  status: z.enum(['DRAFT', 'CONFIRMED']).optional(),
  taxAmount: z.number().min(0).optional(),
  discountAmount: z.number().min(0).optional(),
  shippingAmount: z.number().min(0).optional(),
  items: z.array(z.object({
    variantId: z.string().min(1, "Variant ID is required"),
    quantity: z.number().positive("Quantity must be positive"),
    unitPrice: z.number().optional()
  })).min(1, "At least one item is required")
});
