import { z } from 'zod';
import { normalisePhone } from '../lib/phone';

/**
 * A phone number the shop can find the customer by, stored one way (see lib/phone).
 *
 * Refined here so a malformed number is a 400 with the reason, and transformed so the service only
 * ever sees the stored form.
 */
const phoneField = z.string({ required_error: 'Enter the customer\'s phone number.', invalid_type_error: 'Enter the customer\'s phone number.' })
  .transform((value, ctx) => {
    const result = normalisePhone(value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
      return z.NEVER;
    }
    return result.value;
  });

// Every field the customer service actually writes must be listed here: z.object()
// strips unknown keys, so anything missing arrives as `undefined` and is silently
// dropped. companyName, gstNumber and status were all being collected by
// CustomerModal, stripped here, and then rendered back as "N/A" forever.
const fields = {
  // Trimmed before the length check, for the same reason as the product title: "   " passed
  // min(1) and saved a customer with a blank name, which no search can ever find again.
  name: z.string().trim().min(1, "Give the customer a name"),
  companyName: z.string().optional().nullable(),
  // A blank email is no email, not an invalid one: the form sends "" for an empty box.
  email: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().email("Invalid email").optional().nullable()),
  gstNumber: z.string().optional().nullable(),
  billingAddress: z.string().optional().nullable(),
  shippingAddress: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  // Groups for offers: VIP, STAFF, WHOLESALE. Tidied and de-duplicated by the service.
  tags: z.array(z.string().trim().min(1, 'A group needs a name').max(40, 'Keep a group name under 40 characters'))
    .max(20, 'A customer can be in at most 20 groups').optional(),
};

/** A new customer: a shop finds people by phone, so there is no customer without one. */
export const customerSchema = z.object({ ...fields, phone: phoneField });

/**
 * A change to a customer. Phone may be left out -- changing only their groups must keep working for
 * customers saved before phones were required -- but it cannot be sent empty: a customer that has
 * one cannot lose it.
 */
export const customerUpdateSchema = z.object({
  ...fields,
  phone: z.union([z.null(), z.string()])
    .transform((value, ctx) => {
      if (value === null || value.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A customer needs a phone number. Enter the new one instead of clearing it.' });
        return z.NEVER;
      }
      const result = normalisePhone(value);
      if (!result.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
        return z.NEVER;
      }
      return result.value;
    })
    .optional()
}).partial();
