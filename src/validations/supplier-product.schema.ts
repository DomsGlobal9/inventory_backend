import { z } from 'zod';

// Blank inputs arrive as "" from a cleared form field, which must mean "no value" rather
// than an empty supplier code or a zero price.
const optionalText = (max: number) =>
  z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional().nullable());

const optionalNumber = (message: string) =>
  z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number({ invalid_type_error: message }).optional().nullable());

export const linkSupplierProductSchema = z.object({
  supplierId: z.string().uuid("A supplier must be selected"),
  variantId: z.string().uuid("A product variant must be selected"),
  supplierSku: optionalText(120),
  // Zero is allowed: a free sample or a replacement under warranty legitimately costs
  // nothing, and rejecting it would force a fake price.
  costPrice: optionalNumber("Cost price must be a number")
    .refine(v => v === undefined || v === null || v >= 0, "Cost price cannot be negative"),
  leadTimeDays: optionalNumber("Lead time must be a number")
    .refine(v => v === undefined || v === null || (Number.isInteger(v) && v >= 0), "Lead time must be a whole number of days"),
  minOrderQty: optionalNumber("Minimum order quantity must be a number")
    .refine(v => v === undefined || v === null || (Number.isInteger(v) && v >= 0), "Minimum order quantity must be a whole number"),
  isPreferred: z.boolean().optional(),
  notes: optionalText(1000)
});

export const listBySupplierSchema = z.object({
  search: z.string().trim().max(120).optional()
});
