import { z } from 'zod';

export const supplierSchema = z.object({
  name: z.string().trim().min(1, "Give the supplier a name"),
  contactName: z.string().optional().nullable(),
  email: z.string().email("Invalid email").optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});
