import { z } from 'zod';

/**
 * What the New sale screen sends when the cashier presses Complete sale.
 *
 * Strict, on purpose. The screen sends WHICH items and HOW MANY, the quote it was shown, and any
 * money a person took off with a reason. It does not send prices, a channel or discount amounts --
 * a request carrying `unitPrice` is refused, not quietly ignored, because a till that could name its
 * own price is a till that can sell a saree for a rupee. Price comes from the quote alone.
 */

const money = (label: string) =>
  z.number({ invalid_type_error: `${label} must be a number` })
    .min(0, `${label} cannot be negative`)
    .max(10_000_000, `${label} is too large`)
    .refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, `${label} cannot have more than two decimal places`);

const manualDiscount = z.object({
  amount: money('Discount'),
  reason: z.string().min(1, 'Say why money is coming off')
}).strict();

export const completeSaleSchema = z.object({
  /**
   * Made up once by the screen for each basket. A double tap, a retry after a dropped connection,
   * or two requests racing all carry the same one, and all get the same single sale.
   */
  saleId: z.string().uuid('A sale needs its own id. Reload the New sale screen.'),
  locationId: z.string().min(1, 'Choose the store you are selling from.'),
  customer: z.object({
    id: z.string().min(1).optional().nullable(),
    phone: z.string().max(40).optional().nullable(),
    name: z.string().max(120).optional().nullable(),
    email: z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.string().trim().email('That email address does not look right.').max(120).optional().nullable()),
    /** The customer said yes to offers on WhatsApp, and the cashier ticked it. */
    offersOk: z.boolean().optional()
  }).strict().refine(c => c.id || c.phone, { message: "Enter the customer's phone number." }),
  quoteId: z.string().min(1, 'Price the basket first.'),
  couponCodes: z.array(z.string().min(1).max(60)).max(10).optional(),
  manualDiscount: manualDiscount.optional().nullable(),
  items: z.array(z.object({
    variantId: z.string().min(1),
    quantity: z.number().int('Sell whole pieces.').positive('Sell at least one.').max(10_000),
    manualDiscount: manualDiscount.optional().nullable()
  }).strict()).min(1, 'Add something to sell.').max(100, 'A bill can have 100 lines at most.')
    .refine(items => new Set(items.map(i => i.variantId)).size === items.length, {
      message: 'The same item is in the basket twice. Change its quantity instead.'
    }),
  payments: z.array(z.object({
    method: z.enum(['CASH', 'UPI', 'CARD', 'POINTS'], { errorMap: () => ({ message: 'Choose Cash, UPI, Card or Points.' }) }),
    amount: money('Amount'),
    cashReceived: money('Cash received').optional().nullable(),
    reference: z.string().max(60).optional().nullable()
  }).strict()).max(6, 'A bill can be split 6 ways at most.')
}).strict();

export type CompleteSaleInput = z.infer<typeof completeSaleSchema>;
