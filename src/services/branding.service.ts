import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { forgetShopSettings } from '../lib/clientSettings';

const BUCKET = 'inventory-images';

const SHOWN = {
  businessName: true, logoUrl: true,
  businessAddress: true, businessPhone: true, businessEmail: true, gstNumber: true, receiptFooter: true,
  gstRegistration: true, gstStateCode: true
} as const;

/**
 * Every write answers with the whole identity, not only the field it changed. The screen puts
 * the answer straight into its cache, and a name save that answered with name and logo alone
 * used to wipe the address from every document until the page was reloaded.
 */
function shape(row: Partial<Record<keyof typeof SHOWN, string | null>> | null | undefined) {
  return {
    businessName: row?.businessName || null,
    logoUrl: row?.logoUrl || null,
    businessAddress: row?.businessAddress || null,
    businessPhone: row?.businessPhone || null,
    businessEmail: row?.businessEmail || null,
    gstNumber: row?.gstNumber || null,
    receiptFooter: row?.receiptFooter || null,
    // How the shop is registered decides whether its bills carry GST at all (pricing/tax.ts).
    gstRegistration: row?.gstRegistration || 'UNREGISTERED',
    gstStateCode: row?.gstStateCode || null
  };
}

/** The GST state codes a GSTIN can start with (01-38, plus 97 Other Territory and 99 Centre). */
const STATE_CODE = /^(0[1-9]|1[0-9]|2[0-46-9]|3[0-8]|97|99)$/;

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Indian GSTIN: 2-digit state, 10-character PAN, entity number, Z, check character. */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const detailsSchema = z.object({
  businessAddress: z.preprocess(blankToNull, z.string().trim().max(300, 'Keep the address under 300 characters.').nullable()).optional(),
  businessPhone: z.preprocess(blankToNull, z.string().trim().max(30, 'That phone number is too long.')
    .regex(/^[0-9+()\-\s]{6,30}$/, 'Use digits, spaces, + and - only for the phone number.').nullable()).optional(),
  businessEmail: z.preprocess(blankToNull, z.string().trim().max(120).email('That email address does not look right.').nullable()).optional(),
  gstNumber: z.preprocess(
    v => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v),
    z.string().regex(GSTIN, 'A GSTIN is 15 characters, like 27ABCDE1234F1Z5.').nullable()
  ).optional(),
  // The line at the bottom of a counter receipt. Short: an 80 mm roll fits about 42 characters a line.
  receiptFooter: z.preprocess(blankToNull, z.string().trim().max(160, 'Keep the receipt footer under 160 characters.').nullable()).optional(),
  gstRegistration: z.enum(['REGULAR', 'COMPOSITION', 'UNREGISTERED'], { errorMap: () => ({ message: 'Say whether the shop is GST registered, on the composition scheme, or not registered.' }) }).optional(),
  gstStateCode: z.preprocess(blankToNull, z.string().trim().regex(STATE_CODE, 'Choose the state from the list.').nullable()).optional()
}).strict();

/**
 * The GST facts have to agree with each other, and the GSTIN is the authority.
 *
 * Its first two digits ARE the state, so a state chosen by hand that says otherwise is a slip
 * (or a GSTIN typed from the wrong certificate), and the state is filled in from the GSTIN when
 * none was chosen. A shop that says it is not registered cannot also hold a GSTIN. A registered
 * shop with no GSTIN yet is allowed -- the screen says its tax invoices wait for it.
 */
function reconcileGst(current: { gstNumber: string | null; gstRegistration: string; gstStateCode: string | null }, data: Record<string, unknown>) {
  const gstin = ('gstNumber' in data ? data.gstNumber : current.gstNumber) as string | null;
  const registration = ('gstRegistration' in data ? data.gstRegistration : current.gstRegistration) as string;
  let state = ('gstStateCode' in data ? data.gstStateCode : current.gstStateCode) as string | null;
  if (registration === 'UNREGISTERED' && gstin) {
    throw { statusCode: 400, message: 'A shop that is not registered has no GSTIN. Clear the GSTIN, or choose GST registered.' };
  }
  if (gstin) {
    const fromGstin = gstin.slice(0, 2);
    // A state named IN THIS REQUEST that disagrees is a slip; a state saved earlier simply follows the new GSTIN.
    if ('gstStateCode' in data && state && state !== fromGstin) {
      throw { statusCode: 400, message: `The GSTIN starts with ${fromGstin}, so the shop is in state ${fromGstin}. Choose that state, or check the GSTIN.` };
    }
    state = fromGstin;
  }
  return { ...data, gstStateCode: state };
}

/**
 * The shop's own identity: what it is called, and what it looks like.
 *
 * Lives on ClientSettings beside the timezone and currency, because it answers the same kind
 * of question -- something about the shop rather than about a product or a person -- and
 * because that row is already read and cached on the paths that will want the name.
 */
export class BrandingService {

  /**
   * Name, logo and letterhead details, for anyone signed in: every screen that shows the shop
   * needs the first two, and every document it prints needs the rest.
   */
  async get(clientId: string) {
    const row = await prisma.clientSettings.findUnique({ where: { clientId }, select: SHOWN });

    // A shop that has never opened this screen has no settings row at all -- the table was
    // empty for every client when this was written. Absent is not an error; it is a shop
    // that has not told us its name yet.
    return shape(row);
  }

  /**
   * What a letterhead prints under the name. Each is optional, and an empty one is cleared rather
   * than stored as an empty string, so a document never prints a blank "Phone:" line.
   */
  async setDetails(clientId: string, input: unknown) {
    const parsed = detailsSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw { statusCode: 400, message: parsed.error.issues[0]?.message ?? 'Check the details and try again.' };
    }
    const current = await prisma.clientSettings.findUnique({ where: { clientId }, select: { gstNumber: true, gstRegistration: true, gstStateCode: true } });
    const data = reconcileGst(current ?? { gstNumber: null, gstRegistration: 'UNREGISTERED', gstStateCode: null }, parsed.data);
    const saved = await this.upsert(clientId, data);
    return shape(saved);
  }

  /** Creates the settings row on first write, so the owner never meets "no settings found". */
  private async upsert(clientId: string, data: Record<string, unknown>) {
    const saved = await prisma.clientSettings.upsert({
      where: { clientId },
      create: { clientId, ...data },
      update: data
    });
    // Otherwise the name on purchase orders and day books lags by up to a minute after a
    // deliberate change -- see the note on the cache in lib/clientSettings.
    forgetShopSettings(clientId);
    return saved;
  }

  async setName(clientId: string, businessName: string | null) {
    const trimmed = typeof businessName === 'string' ? businessName.trim() : '';
    const saved = await this.upsert(clientId, { businessName: trimmed || null });
    return shape(saved);
  }

  /**
   * A one-time upload URL for a path THIS server computed.
   *
   * Same rule as product images: the browser never supplies a clientId and never holds a
   * Supabase key. The tenant comes from the session, which the browser cannot forge, so a
   * crafted request cannot write into another shop's folder.
   */
  async createLogoUploadUrl(clientId: string, fileName: string) {
    // "../" or a leading slash would climb out of the tenant prefix that is the whole point
    // of deriving this here.
    const safeName = String(fileName || 'logo')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^[._-]+/, '')
      .slice(0, 120) || 'logo';

    const storagePath = `${clientId}/branding/${Date.now()}_${safeName}`;

    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath);
    if (error || !data) {
      throw { statusCode: 502, message: `Could not prepare upload: ${error?.message || 'unknown storage error'}` };
    }

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

    return { storagePath, token: data.token, signedUrl: data.signedUrl, publicUrl: publicUrlData.publicUrl };
  }

  /**
   * Records an uploaded logo, and removes the one it replaces.
   *
   * The path is re-checked against the tenant prefix even though createLogoUploadUrl
   * generated it: this endpoint accepts one from the request body, and defence in depth is
   * cheaper than trusting that the only caller is the one we wrote.
   */
  async setLogo(clientId: string, storagePath: string) {
    if (!storagePath || !storagePath.startsWith(`${clientId}/branding/`)) {
      throw { statusCode: 400, message: 'That upload does not belong to this shop.' };
    }

    const existing = await prisma.clientSettings.findUnique({
      where: { clientId },
      select: { logoPath: true }
    });

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const saved = await this.upsert(clientId, {
      logoUrl: publicUrlData.publicUrl,
      logoPath: storagePath
    });
    const result = shape(saved);

    // After the row is saved, never before: if this removal fails the shop still has the
    // logo it just chose, and the cost is one orphaned file rather than no logo at all.
    if (existing?.logoPath && existing.logoPath !== storagePath) {
      await this.removeObject(existing.logoPath);
    }

    return result;
  }

  async removeLogo(clientId: string) {
    const existing = await prisma.clientSettings.findUnique({
      where: { clientId },
      select: { logoPath: true }
    });

    const saved = await this.upsert(clientId, { logoUrl: null, logoPath: null });
    if (existing?.logoPath) await this.removeObject(existing.logoPath);

    return shape(saved);
  }

  /**
   * Storage cleanup is never allowed to fail the request.
   *
   * The database is the record of what the shop's logo IS. A leftover file costs a few
   * kilobytes; a 500 here would tell an owner their logo change failed when it had already
   * succeeded, and they would do it again.
   */
  private async removeObject(path: string) {
    try {
      const { error } = await supabase.storage.from(BUCKET).remove([path]);
      if (error) console.error(`[branding] could not remove old logo ${path}:`, error.message);
    } catch (err) {
      console.error(`[branding] could not remove old logo ${path}:`, err);
    }
  }
}

export const brandingService = new BrandingService();
