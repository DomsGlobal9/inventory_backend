import { z } from 'zod';

export const stockChangeSchema = z.object({
  variantId: z.string().uuid("Invalid variant ID"),

  // Whole pieces only. The sign is still the controller's business -- stock-in and stock-out
  // disagree about it -- but the sign was the ONLY thing being checked, so 2.7 was accepted
  // and silently became 2. Garments are not sold by the fraction, and a stock figure that
  // quietly loses 0.7 of what somebody typed is worse than one that refuses it.
  quantity: z
    .number({ invalid_type_error: 'How many pieces? A number, please.' })
    .int('Whole pieces only — you cannot take in or send out part of a garment.')
    .finite('That is not a number of pieces.'),

  reason: z.string().optional(),
  referenceType: z.string().optional(),
  reference: z.string().optional(),

  // What a piece cost. Never negative: this feeds the weighted average, so a negative here
  // drags down the value of every unit already on the shelf, including the ones bought
  // properly. Proved on a live tenant during an audit -- receiving one piece at -500 moved a
  // variant's average cost from 47,045 to 44,031, which is real money on a real valuation and
  // nothing in the request was refused.
  //
  // Zero IS allowed, and deliberately: opening stock whose cost nobody recorded is a real
  // situation, and the product already tells the merchant when a figure rests on one.
  unitCost: z
    .number()
    .nonnegative('What you paid cannot be a negative number.')
    .finite('That is not an amount.')
    .optional(),

  notes: z.string().optional()
});
