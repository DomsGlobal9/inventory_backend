import { z } from 'zod';

export const supplierSchema = z.object({
  name: z.string().trim().min(1, "Give the supplier a name"),
  contactName: z.string().optional().nullable(),
  // An empty box means "no email", not a bad one: a supplier needs only a name, and an email you
  // no longer want must be possible to clear.
  email: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().email('That email does not look right. Check it, or leave it empty.').optional().nullable()),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});
