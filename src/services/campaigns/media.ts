/**
 * Pictures for campaigns and wishes, made ready for WhatsApp.
 *
 * Whatever the shop gives us -- a product photo, a phone picture, a PNG with a see-through
 * background, a 40-megapixel camera file -- becomes one plain JPEG: at most 1,600 px on its longer
 * side, under 1 MB, sRGB colour, turned the right way up, and with nothing hidden inside it (no GPS
 * position, no camera details). WhatsApp is fussy about big or unusual files; customers' phones on
 * slow networks are too.
 *
 * Each picture is stored ONCE, at a random address in inventory-images/whatsapp-media/, and never
 * changed or replaced: a campaign's page must be able to show exactly the picture that went. The
 * address says nothing about the shop, the campaign or the product. Choosing another picture makes
 * another; ones nothing uses any more are removed by the housekeeping job after a few days.
 */
import { randomBytes } from 'crypto';
import { prepareImage as prep, type Prepared } from '../../lib/imagePrep';
import { prisma } from '../../lib/prisma';
import { supabase } from '../../lib/supabase';
import { env } from '../../config/env';
import { badRequest, notFound } from '../../utils/httpError';

export const BUCKET = 'inventory-images';
export const FOLDER = 'whatsapp-media';
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
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

export const mediaView = (m: { id: string; url: string; width: number; height: number; byteSize: number }) =>
  ({ id: m.id, url: m.url, width: m.width, height: m.height, byteSize: m.byteSize });

async function store(clientId: string, p: Prepared, extra: { source: 'UPLOAD' | 'PRODUCT'; productId?: string | null; createdById: string | null }) {
  const storagePath = `${FOLDER}/${randomBytes(16).toString('hex')}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, p.jpeg, {
    contentType: 'image/jpeg',
    upsert: false, // never replace: a new picture is a new address
    // An hour, not longer: the storage network keeps a copy for as long as this says, even after the
    // file is deleted (a removed picture, a deleted shop). A campaign's sends are covered anyway --
    // the WhatsApp Service keeps its own copy while sending.
    cacheControl: '3600'
  });
  if (error) {
    console.error('[campaign media] upload failed:', error.message);
    throw Object.assign(new Error('The picture could not be saved just now. Please try again.'), { statusCode: 503 });
  }
  const url = supabase.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;
  try {
    const row = await prisma.campaignMedia.create({
      data: { clientId, storagePath, url, width: p.width, height: p.height, byteSize: p.jpeg.length, source: extra.source, productId: extra.productId ?? null, createdById: extra.createdById }
    });
    return mediaView(row);
  } catch (e) {
    // Nothing points at the file: take it away again rather than leave it in the bucket.
    await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => undefined);
    throw e;
  }
}

/** A picture the shop uploaded, as base64 (a data: address is fine too). */
export async function fromUpload(clientId: string, userId: string | null, base64: unknown) {
  if (typeof base64 !== 'string' || !base64) throw badRequest('Choose a picture to upload.');
  const clean = base64.replace(/^data:[^;,]{0,100};base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw badRequest('The picture could not be read. Choose it again.');
  // Judged on the encoded length first, so a huge upload is never decoded.
  if (Math.floor((clean.length * 3) / 4) > MAX_UPLOAD_BYTES + 3) throw badRequest('The picture is larger than 15 MB. Choose a smaller one.');
  return store(clientId, await prepareImage(Buffer.from(clean, 'base64')), { source: 'UPLOAD', createdById: userId });
}

/**
 * One of the shop's own product photos. Fetched only from our own storage -- the address comes from
 * the database, and is checked to be ours anyway, so this can never be pointed somewhere else.
 */
export async function fromProductImage(clientId: string, userId: string | null, productImageId: unknown) {
  if (typeof productImageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(productImageId)) throw badRequest('Choose one of the product photos.');
  const img = await prisma.productImage.findFirst({
    where: { id: productImageId, OR: [{ product: { clientId } }, { variant: { clientId } }] },
    select: { url: true, productId: true, variant: { select: { productId: true } } }
  });
  if (!img) throw notFound('That product photo was not found.');
  const ours = env.SUPABASE_URL ? `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/` : null;
  if (!ours || !img.url.startsWith(ours)) throw badRequest('That product photo is not stored with ScaleEzy, so it cannot be used. Upload the picture instead.');
  let bytes: Buffer;
  try {
    const res = await fetch(img.url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(String(res.status));
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw badRequest('That product photo is larger than 15 MB. Upload a smaller copy instead.');
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if ((e as any)?.statusCode === 400) throw e;
    throw Object.assign(new Error('That product photo could not be loaded just now. Please try again.'), { statusCode: 503 });
  }
  return store(clientId, await prepareImage(bytes), { source: 'PRODUCT', productId: img.productId ?? img.variant?.productId ?? null, createdById: userId });
}

/** A picture id sent by the shop: it must be one of its own. */
export async function ownMedia(clientId: string, id: unknown) {
  if (id === null || id === undefined || id === '') return null;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('That picture was not found. Choose it again.');
  const m = await prisma.campaignMedia.findFirst({ where: { id, clientId } });
  if (!m) throw badRequest('That picture was not found. Choose it again.');
  return m;
}

/**
 * Pictures nothing uses: not a campaign's, not a template's, not a wish's, and older than two days
 * (a campaign being written may not be saved yet). The file goes first, then the row.
 */
export async function purgeUnused(now = new Date(), opts: { onlyClients?: string[] } = {}) {
  const rows = await prisma.$queryRaw<{ id: string; storage_path: string }[]>`
    SELECT m.id, m.storage_path FROM campaign_media m
     WHERE m.created_at < ${new Date(now.getTime() - UNUSED_RETENTION_MS)}
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
