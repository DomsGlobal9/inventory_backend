import { z } from 'zod';

// Every field the customer service actually writes must be listed here: z.object()
// strips unknown keys, so anything missing arrives as `undefined` and is silently
// dropped. companyName, gstNumber and status were all being collected by
// CustomerModal, stripped here, and then rendered back as "N/A" forever.
export const customerSchema = z.object({
  // Trimmed before the length check, for the same reason as the product title: "   " passed
  // min(1) and saved a customer with a blank name, which no search can ever find again.
  name: z.string().trim().min(1, "Give the customer a name"),
  companyName: z.string().optional().nullable(),
  email: z.string().email("Invalid email").optional().nullable(),
  phone: z.string().optional().nullable(),
  gstNumber: z.string().optional().nullable(),
  billingAddress: z.string().optional().nullable(),
  shippingAddress: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
});
