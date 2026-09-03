import { z } from 'zod';

// Every field the customer service actually writes must be listed here: z.object()
// strips unknown keys, so anything missing arrives as `undefined` and is silently
// dropped. companyName, gstNumber and status were all being collected by
// CustomerModal, stripped here, and then rendered back as "N/A" forever.
export const customerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  companyName: z.string().optional().nullable(),
  email: z.string().email("Invalid email").optional().nullable(),
  phone: z.string().optional().nullable(),
  gstNumber: z.string().optional().nullable(),
  billingAddress: z.string().optional().nullable(),
  shippingAddress: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
});
