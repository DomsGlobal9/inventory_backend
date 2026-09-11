import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { forgetShopSettings } from '../lib/clientSettings';

const BUCKET = 'inventory-images';

/**
 * The shop's own identity: what it is called, and what it looks like.
 *
 * Lives on ClientSettings beside the timezone and currency, because it answers the same kind
 * of question -- something about the shop rather than about a product or a person -- and
 * because that row is already read and cached on the paths that will want the name.
 */
export class BrandingService {

  /** Name and logo, for anyone signed in: every screen that shows the shop needs these. */
  async get(clientId: string) {
    const row = await prisma.clientSettings.findUnique({
      where: { clientId },
      select: { businessName: true, logoUrl: true }
    });

    // A shop that has never opened this screen has no settings row at all -- the table was
    // empty for every client when this was written. Absent is not an error; it is a shop
    // that has not told us its name yet.
    return {
      businessName: row?.businessName || null,
      logoUrl: row?.logoUrl || null
    };
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
    return { businessName: saved.businessName, logoUrl: saved.logoUrl };
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

    // After the row is saved, never before: if this removal fails the shop still has the
    // logo it just chose, and the cost is one orphaned file rather than no logo at all.
    if (existing?.logoPath && existing.logoPath !== storagePath) {
      await this.removeObject(existing.logoPath);
    }

    return { businessName: saved.businessName, logoUrl: saved.logoUrl };
  }

  async removeLogo(clientId: string) {
    const existing = await prisma.clientSettings.findUnique({
      where: { clientId },
      select: { logoPath: true }
    });

    const saved = await this.upsert(clientId, { logoUrl: null, logoPath: null });
    if (existing?.logoPath) await this.removeObject(existing.logoPath);

    return { businessName: saved.businessName, logoUrl: saved.logoUrl };
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
