import { z } from 'zod';

export const supplierSchema = z.object({
  name: z.string().min(1, "Name is required"),
  contactName: z.string().optional().nullable(),
  email: z.string().email("Invalid email").optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});
