import { z } from 'zod';
import { LeadStatus } from '@prisma/client';

/**
 * Email and phone are both required: the entire purpose of a lead is that someone can be
 * reached about it, and a record with neither is not a lead, it is noise in the console.
 */
export const createLeadSchema = z.object({
  companyName: z.string().trim().min(2, "Business name must be at least 2 characters").max(120),
  contactName: z.string().trim().min(2, "Your name must be at least 2 characters").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200),
  // Deliberately permissive on shape -- Indian mobile, landline with STD code, and numbers
  // written with +91/spaces/dashes are all legitimate, and a strict pattern rejects real
  // customers. Digits are counted instead so the field cannot be satisfied by punctuation.
  phone: z.string().trim()
    .min(7, "Enter a valid phone number")
    .max(20, "Phone number is too long")
    .refine(v => (v.match(/\d/g) || []).length >= 7, "Enter a valid phone number")
    .refine(v => /^[\d\s+()-]+$/.test(v), "Phone number can only contain digits, spaces and + ( ) -"),
  message: z.string().trim().max(1000, "Message is too long").optional()
});

export const updateLeadSchema = z.object({
  status: z.nativeEnum(LeadStatus).optional(),
  notes: z.string().max(4000).optional()
}).refine(v => v.status !== undefined || v.notes !== undefined, {
  message: "Provide a status or notes to update"
});

export const convertLeadSchema = z.object({
  companyName: z.string().trim().min(2).max(120).optional(),
  adminName: z.string().trim().min(2).max(120).optional(),
  adminEmail: z.string().trim().toLowerCase().email().max(200).optional()
});

export const listLeadsSchema = z.object({
  status: z.nativeEnum(LeadStatus).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.preprocess(v => (v === undefined ? 1 : parseInt(String(v), 10)), z.number().min(1).default(1)),
  limit: z.preprocess(v => (v === undefined ? 25 : parseInt(String(v), 10)), z.number().min(1).max(100).default(25))
});
