import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { supabase } from '../../lib/supabase';
import { prepareImage } from '../../lib/imagePrep';
import { env } from '../../config/env';
import { shopperTryOnGatewayService, categoryFor } from '../shopper-tryon';
import { tryOnUsageService } from '../tryon';
import { OnlineShopRuleError } from './rules';

/**
 * "See it on you" on a shop's own online shop.
 *
 * The same gateway and the same allowance as the try-on a customer already gets by scanning a QR
 * code on a tag in the shop -- this is that, on the page, for somebody at home.
 *
 * TWO THINGS ARE DIFFERENT HERE, and both matter.
 *
 * The first is the shopper's photograph. The in-shop flow deliberately refuses to accept an image
 * and takes a URL instead, because an unauthenticated upload endpoint is a bucket anyone can fill.
 * A shopper on a shop page has nowhere to put a photograph, so this one does accept it -- and pays
 * for that with: the shop's allowance checked BEFORE a byte is read, so filling the bucket costs
 * the abuser the shop's try-ons first and stops; the picture shrunk and stripped of its EXIF,
 * which on a selfie carries the place it was taken; a name nobody can guess; and the file DELETED
 * the moment the gateway has finished with it, whether it worked or not. A photograph of somebody
 * is not ours to keep, and the only reason it is stored at all is that the gateway fetches by URL.
 *
 * The second is the shop's own id. The in-shop route carries it in the address, which is fine on
 * a QR code nobody reads. A shop page must not: the whole public surface is addressed by slug so
 * that one shop's address can never reach another shop's anything.
 */

const BUCKET = 'inventory-images';
const FOLDER = 'shop-tryon';

/**
 * Smaller than a product photograph on purpose. The gateway wants a person, not a poster, and
 * every extra megabyte is a slower try-on on a phone holding a photograph it just took.
 */
const LIMITS = {
  maxSide: 1280,
  maxBytes: 400 * 1024,
  tooBig: 'That photograph could not be made small enough. Try another one.'
};

/** Whether this shop offers it at all, and whether the platform can do it. */
export async function offersTryOn(clientId: string): Promise<boolean> {
  if (!env.SHOPPER_TRYON_GATEWAY_URL) return false;
  const shop = await prisma.onlineShop.findUnique({ where: { clientId }, select: { tryOn: true } });
  return shop?.tryOn === true;
}

/**
 * One try-on: this piece, on this person.
 *
 * The garment is resolved from the product code rather than taken from the request. If the picture
 * to wear came from the browser, anybody could have this shop pay to composite any two images.
 */
export async function seeItOn(clientId: string, productCodeRaw: unknown, photoRaw: unknown) {
  if (!(await offersTryOn(clientId))) {
    throw new OnlineShopRuleError('This shop does not offer try-on just now.');
  }

  const productCode = typeof productCodeRaw === 'string' ? productCodeRaw.trim() : '';
  if (!productCode) throw new OnlineShopRuleError('Which piece is missing.');

  /*
   * The allowance first, before the photograph is even decoded.
   *
   * A shop out of try-ons should cost nothing at all to refuse -- not a decode, not an upload, not
   * a gateway call. It is also what makes accepting an upload here defensible: there is a finite
   * number of times anybody can do it, and it is the shop's own number.
   */
  await tryOnUsageService.assertWithinLimit(clientId, 'SHOPPER_TRYON').catch((e: any) => {
    throw new OnlineShopRuleError(
      e?.statusCode === 429
        ? 'This shop has used all its try-ons for now. Ask them on WhatsApp — they will send you a photo.'
        : 'Try-on is not available just now.'
    );
  });

  /*
   * Whether a photograph was sent at all is a free check, so it comes before the garment is looked
   * up. The other way round, somebody who pressed the button with nothing chosen was told "that
   * piece cannot be tried on" -- an answer about the shop's photograph, for a mistake of theirs.
   */
  const raw = typeof photoRaw === 'string' ? photoRaw.replace(/^data:image\/[a-z+]+;base64,/i, '') : '';
  if (!raw) throw new OnlineShopRuleError('Choose a photograph of yourself first.');

  const garment = await garmentFor(clientId, productCode);
  if (!garment) throw new OnlineShopRuleError('That piece cannot be tried on. Ask the shop for a photo.');
  let buf: Buffer;
  try { buf = Buffer.from(raw, 'base64'); }
  catch { throw new OnlineShopRuleError('That photograph did not arrive intact. Please choose it again.'); }

  // Shrunk, flattened and stripped: a selfie's EXIF carries the place and time it was taken, and
  // none of that has any business leaving the shopper's phone.
  const prepared = await prepareImage(buf, LIMITS);

  const path = `${FOLDER}/${crypto.randomBytes(24).toString('hex')}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, prepared.jpeg, {
    contentType: 'image/jpeg',
    // Nothing should cache a picture of somebody that is about to be deleted.
    cacheControl: 'no-store',
    upsert: false
  });
  if (error) throw new OnlineShopRuleError('That photograph could not be used just now. Please try again.');

  const humanImageUrl = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  try {
    const result = await shopperTryOnGatewayService.generate({
      clientId,
      garmentImageUrl: garment.imageUrl,
      humanImageUrl,
      category: categoryFor(garment.dressType)
    });

    // Counted after the fact and never awaited: the meter must not be able to fail the thing it
    // is counting.
    void tryOnUsageService.record(clientId, { started: true, completed: true, viewsGenerated: 1 }, 'SHOPPER_TRYON');

    return { imageUrl: result.resultImageUrl, title: garment.title };
  } catch (e: any) {
    void tryOnUsageService.record(clientId, { started: true, failed: true }, 'SHOPPER_TRYON');
    // The gateway's own words may name internal services; the shopper gets something they can act on.
    console.error('[online-shop] try-on failed:', e?.message);
    throw new OnlineShopRuleError(
      e?.statusCode === 429
        ? 'This shop has used all its try-ons for now. Ask them on WhatsApp — they will send you a photo.'
        : 'That did not work. Try a clear, full-length photograph taken straight on.'
    );
  } finally {
    /*
     * The photograph goes, always. Whether the try-on worked, failed, or the gateway timed out,
     * a picture of somebody must not be left sitting in a bucket. Not awaited into the answer --
     * the shopper should not wait on our tidying -- but it does happen.
     */
    void supabase.storage.from(BUCKET).remove([path]).catch(() => undefined);
  }
}

/**
 * The garment, as this shop's own row.
 *
 * Scoped by client and by what the shop actually put online, so a product code from another shop
 * -- or one this shop has not published -- resolves to nothing rather than to somebody else's saree.
 */
async function garmentFor(clientId: string, productCode: string) {
  const product = await prisma.product.findFirst({
    where: { clientId, productCode, status: 'ACTIVE', trashedAt: null },
    select: {
      title: true, dressType: true,
      images: {
        where: { imageType: { in: ['COVER', 'GALLERY'] } },
        select: { url: true, isPrimary: true },
        orderBy: { orderIndex: 'asc' }
      }
    }
  });
  const photo = product?.images.find(i => i.isPrimary)?.url ?? product?.images[0]?.url;
  if (!product || !photo) return null;
  return { title: product.title, dressType: product.dressType, imageUrl: photo };
}
