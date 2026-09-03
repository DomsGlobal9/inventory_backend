import { z } from 'zod';

// category/priority are Prisma enums. Before this existed the controller passed whatever
// arrived straight through (the service casts them `as any`), so a value outside the enum
// -- e.g. priority "MEDIUM", which reads perfectly plausible but is not one of
// LOW/NORMAL/HIGH/URGENT -- reached Prisma and came back as an opaque 500 with a stack
// trace in the response body. The UI's dropdowns only offer valid values, so this was not
// reachable from the app itself, but any other caller (integration, script, retry with a
// stale payload) got a 500 where a 400 was owed.
export const createSupportTicketSchema = z.object({
  subject: z.string().min(1, 'Subject is required').max(200),
  description: z.string().min(1, 'Description is required'),
  category: z.enum(['BUG', 'QUESTION', 'BILLING', 'FEATURE_REQUEST', 'OTHER']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  linkedErrorId: z.string().optional().nullable(),
});

export const replySupportTicketSchema = z.object({
  body: z.string().min(1, 'Message body is required'),
});
