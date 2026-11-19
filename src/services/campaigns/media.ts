/**
 * What is left in Inventory of campaign pictures (19 Nov 2026: campaigns are ScaleEzy CRM's alone, and CRM
 * makes and stores its own pictures).
 *
 * - productPhoto / productPhotosOf: the shop's product photos CRM may choose from (checked here).
 * - mediaOfShop / templatesOfShop: what the shop had saved, for CRM to copy once at its takeover.
 * - purgeUnused: the housekeeping job removing old pictures nothing uses any more.
 * - prepareImage: the WhatsApp-sized conversion, kept with its checks (lib/imagePrep does the work).
 */
import { prepareImage as prep, type Prepared } from '../../lib/imagePrep';
import { prisma } from '../../lib/prisma';
import { supabase } from '../../lib/supabase';
import { env } from '../../config/env';
import { badRequest, notFound } from '../../utils/httpError';
import { literal } from '../../utils/likeText';

export const BUCKET = 'inventory-images';
export const MAX_PIXELS = 40_000_000;
export const MAX_SIDE = 1600;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Unused pictures are removed after this long (a draft being written may not be saved yet). */
export const UNUSED_RETENTION_MS = 2 * 86_400_000;

export type { Prepared };

/**
 * The conversion itself, with WhatsApp's limits.
 *
 * The work is in lib/imagePrep, shared with online-shop banners: the decompression-bomb guard and
 * stripping GPS out of a photo before it is published are exactly the parts nobody should be
 * writing twice. What is WhatsApp's alone is how big the result may be.
 */
export const prepareImage = (input: Buffer) =>
  prep(input, {
    maxSide: MAX_SIDE,
    maxBytes: MAX_OUTPUT_BYTES,
    tooBig: 'That picture could not be made small enough for WhatsApp. Try a simpler photo.'
  });

/**
 * One of the shop's own product photos, checked: this shop's product or colour, not archived or in the bin,
 * and stored in our own storage. Used by ScaleEzy CRM, which
 * fetches the address itself and keeps its own copy (GET internal .../product-photos/:imageId).
 */
export async function productPhoto(clientId: string, productImageId: unknown) {
  if (typeof productImageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(productImageId)) throw badRequest('Choose one of the product photos.');
  // Ids are stored in small letters (a text column): the same id in capitals is the same photo.
  const img = await prisma.productImage.findFirst({
    where: { id: productImageId.toLowerCase(), OR: [{ product: { clientId } }, { variant: { clientId } }] },
    select: {
      id: true, url: true, productId: true,
      product: { select: { status: true, title: true } },
      variant: { select: { productId: true, product: { select: { status: true, title: true } } } }
    }
  });
  if (!img) throw notFound('That product photo was not found.');
  // The photo list leaves these out; a photo chosen from an old list, or asked for by id, is refused the same way.
  const owner = img.product ?? img.variant?.product ?? null;
  const status = String(owner?.status ?? '');
  if (status === 'ARCHIVED' || status === 'TRASHED') throw badRequest('That product is archived or in the bin, so its photos are not used. Bring the product back, or upload the picture instead.');
  const ours = env.SUPABASE_URL ? `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/` : null;
  if (!ours || !img.url.startsWith(ours)) throw badRequest('That product photo is not stored with ScaleEzy, so it cannot be used. Upload the picture instead.');
  return { id: img.id, url: img.url, productId: img.productId ?? img.variant?.productId ?? null, title: owner?.title ?? '' };
}

/** Every picture this shop has for messages, newest first (for CRM to copy once into its own storage). */
export async function mediaOfShop(clientId: string) {
  return prisma.campaignMedia.findMany({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, url: true, width: true, height: true, createdAt: true }
  });
}

/**
 * The campaign templates this shop saved while campaigns were Inventory's, read once by ScaleEzy CRM at its
 * takeover (19 Nov 2026) so nothing the owner saved is lost. Read only; Inventory no longer makes them.
 * The picture keeps its id (the same one GET campaign-media lists) and only this shop's picture is given.
 * The link as CRM keeps it: { type: 'EXTERNAL', url } or { type: 'WHATSAPP' }; anything unreadable is null.
 */
export async function templatesOfShop(clientId: string) {
  const rows = await prisma.campaignTemplate.findMany({
    where: { clientId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, text: true, link: true, updatedAt: true, media: { select: { id: true, url: true, width: true, height: true, clientId: true } } }
  });
  return rows.map(t => ({
    id: t.id,
    name: t.name,
    text: t.text,
    media: t.media && t.media.clientId === clientId ? { id: t.media.id, url: t.media.url, width: t.media.width, height: t.media.height } : null,
    link: linkForCrm(t.link),
    updatedAt: t.updatedAt
  }));
}

function linkForCrm(raw: unknown): { type: 'EXTERNAL'; url: string } | { type: 'WHATSAPP' } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.type === 'WHATSAPP') return { type: 'WHATSAPP' };
  const url = typeof r.target === 'string' ? r.target : typeof r.url === 'string' ? r.url : '';
  if (r.type === 'EXTERNAL' && /^https?:\/\//i.test(url)) return { type: 'EXTERNAL', url };
  return null;
}

/**
 * Pictures nothing uses: not a campaign's, not a template's, not a wish's, and older than two days
 * (a campaign being written may not be saved yet). The file goes first, then the row.
 * Never one CRM made (source 'CRM'): what uses those is in CRM's database, out of sight from here.
 */
export async function purgeUnused(now = new Date(), opts: { onlyClients?: string[] } = {}) {
  const rows = await prisma.$queryRaw<{ id: string; storage_path: string }[]>`
    SELECT m.id, m.storage_path FROM campaign_media m
     WHERE m.created_at < ${new Date(now.getTime() - UNUSED_RETENTION_MS)}
       AND m.source <> 'CRM'
       AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM campaign_templates t WHERE t.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM loyalty_settings l WHERE l.birthday_media_id = m.id OR l.anniversary_media_id = m.id)
     LIMIT 200`;
  const mine = opts.onlyClients
    ? (await prisma.campaignMedia.findMany({ where: { id: { in: rows.map(r => r.id) }, clientId: { in: opts.onlyClients } }, select: { id: true } })).map(r => r.id)
    : rows.map(r => r.id);
  // The row first, one at a time: a draft that picked the picture up a moment ago holds it (the
  // campaign's foreign key refuses the delete), and then its file must stay too.
  const gone: string[] = [];
  for (const d of rows.filter(r => mine.includes(r.id))) {
    try {
      await prisma.campaignMedia.delete({ where: { id: d.id } });
      gone.push(d.storage_path);
    } catch {
      /* in use after all, or already gone */
    }
  }
  if (gone.length === 0) return 0;
  const { error } = await supabase.storage.from(BUCKET).remove(gone);
  // A file left behind is only wasted space; the next run cannot find it again, so say so.
  if (error) console.error('[campaign media] rows removed but files left:', gone.join(', '), error.message);
  return gone.length;
}

/** The shop's products with photos, for ScaleEzy CRM's picture picker (routes/internal-crm, whose person is checked there). */
export async function productPhotosOf(clientId: string, search: unknown) {
  const q = typeof search === 'string' ? search.trim().slice(0, 80) : '';
  const rows = await prisma.product.findMany({
    where: {
      clientId,
      status: { notIn: ['ARCHIVED', 'TRASHED'] },
      images: { some: {} },
      // Taken literally: Prisma's contains is an unescaped LIKE, so "%" listed every product and "_" any letter.
      ...(q ? { OR: [{ title: { contains: literal(q), mode: 'insensitive' } }, { productCode: { contains: literal(q), mode: 'insensitive' } }] } : {})
    },
    // No `take` on the photographs any more, and six distinct ones kept below instead.
    // One photograph of a colour is registered against every size of that colour, so a saree in
    // three sizes gave the same picture three times -- and six rows could be two pictures shown
    // three times each. 24 products x a handful of photographs is a small read.
    select: { id: true, title: true, images: { select: { id: true, url: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }, { createdAt: 'asc' }] } },
    orderBy: { updatedAt: 'desc' },
    take: 24
  });
  return rows.map(p => {
    const seen = new Set<string>();
    const images = p.images.filter(i => !seen.has(i.url) && seen.add(i.url)).slice(0, 6);
    return { id: p.id, title: p.title, images: images.map(i => ({ id: i.id, url: i.url })) };
  });
}
