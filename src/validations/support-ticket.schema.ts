import { z } from 'zod';

/**
 * Every field a person types is trimmed BEFORE its length is checked.
 *
 * z.string().min(1) counts the spaces, so "   " passed and was saved. Proved on the product
 * title, which then sat in every list as a blank row nobody could find by searching; the same
 * hole was open on the supplier name, the stock count name, the variant SKU, the storefront
 * connection, and on a support ticket -- where a blank subject is a ticket the person who has
 * to answer it cannot even identify.
 *
 * In the schema rather than each service, so it applies wherever the schema is used.
 */

// category/priority are Prisma enums. Before this existed the controller passed whatever
// arrived straight through (the service casts them `as any`), so a value outside the enum
// -- e.g. priority "MEDIUM", which reads perfectly plausible but is not one of
// LOW/NORMAL/HIGH/URGENT -- reached Prisma and came back as an opaque 500 with a stack
// trace in the response body. The UI's dropdowns only offer valid values, so this was not
// reachable from the app itself, but any other caller (integration, script, retry with a
// stale payload) got a 500 where a 400 was owed.
export const createSupportTicketSchema = z.object({
  subject: z.string().trim().min(1, 'Give the ticket a subject').max(200),
  description: z.string().trim().min(1, 'Describe what is happening'),
  category: z.enum(['BUG', 'QUESTION', 'BILLING', 'FEATURE_REQUEST', 'OTHER']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  linkedErrorId: z.string().optional().nullable(),
});

export const replySupportTicketSchema = z.object({
  body: z.string().trim().min(1, 'Write a message before sending'),
});
