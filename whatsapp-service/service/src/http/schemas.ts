import { z } from 'zod';

const kinds = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'TEST'] as const;

export const clientIdParam = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'client id may only contain letters, digits and . _ : -');

export const linkBody = z
  .object({
    method: z.enum(['qr', 'code']),
    phone: z.string().max(30).optional(),
  })
  .strict();

const fromSchema = z.union([z.literal('scaleezy'), z.object({ clientId: clientIdParam }).strict()]);

export const sendBody = z
  .object({
    from: fromSchema,
    to: z.string().min(1).max(30),
    text: z.string().max(4000).optional().nullable(),
    document: z
      .object({
        fileName: z.string().min(1).max(200),
        mimeType: z.string().max(100),
        // ~5 MB of PDF is ~7 MB of base64; anything longer is refused before decoding.
        base64: z.string().min(1).max(7_200_000),
      })
      .strict()
      .optional()
      .nullable(),
    kind: z.enum(kinds),
    reference: z.string().max(200).optional().nullable(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const numbersCheckBody = z.object({ from: fromSchema, to: z.string().min(1).max(30) }).strict();

export const adminMessagesQuery = z.object({
  status: z.enum(['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'EXPIRED']).optional(),
  since: z
    .string()
    .optional()
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), 'since must be a date, e.g. 2026-09-18T00:00:00Z'),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Turns a zod error into one plain sentence. */
export function describeZodError(err: z.ZodError): string {
  const parts = err.issues.slice(0, 5).map((i) => {
    const where = i.path.length ? i.path.join('.') : 'request';
    if (i.code === 'unrecognized_keys') return `unknown field(s): ${i.keys.join(', ')}`;
    if (i.code === 'invalid_type' && i.received === 'undefined') return `${where} is missing`;
    return `${where}: ${i.message}`;
  });
  return `The request is not valid: ${parts.join('; ')}.`;
}
