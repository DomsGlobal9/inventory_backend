import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { wearIt, TryOnWearError } from '../shopper-tryon';
import { OnlineShopRuleError } from './rules';

/**
 * "See it on you" on a shop's own online shop.
 *
 * The same try-on a customer already gets by scanning a tag in the shop, and the same one a
 * salesperson can now run at the counter -- this is that, on the page, for somebody at home.
 *
 * The work itself lives in `shopper-tryon/wear.service`: the allowance check, the EXIF stripping,
 * the upload and the deletion are identical wherever the photograph came from, and one copy is
 * why they cannot drift. What belongs HERE is only what is true of the shop page: whether this
 * shop switched it on, and that the piece is found by slug and product code so that one shop's
 * address can never reach another shop's anything.
 */

/** Whether this shop offers it at all, and whether the platform can do it. */
export async function offersTryOn(clientId: string): Promise<boolean> {
  if (!env.SHOPPER_TRYON_GATEWAY_URL) return false;
  const shop = await prisma.onlineShop.findUnique({ where: { clientId }, select: { tryOn: true } });
  return shop?.tryOn === true;
}

/** One try-on: this piece, on this person. */
export async function seeItOn(clientId: string, productCodeRaw: unknown, photoRaw: unknown) {
  if (!(await offersTryOn(clientId))) {
    throw new OnlineShopRuleError('This shop does not offer try-on just now.');
  }

  const productCode = typeof productCodeRaw === 'string' ? productCodeRaw.trim() : '';
  if (!productCode) throw new OnlineShopRuleError('Which piece is missing.');

  /*
   * Whether a photograph was sent at all is a free check, so it comes before the garment is looked
   * up. The other way round, somebody who pressed the button with nothing chosen was told "that
   * piece cannot be tried on" -- an answer about the shop's photograph, for a mistake of theirs.
   */
  const hasPhoto = typeof photoRaw === 'string' && photoRaw.replace(/^data:image\/[a-z+]+;base64,/i, '').length > 0;
  if (!hasPhoto) throw new OnlineShopRuleError('Choose a photograph of yourself first.');

  const garment = await garmentFor(clientId, productCode);
  if (!garment) throw new OnlineShopRuleError('That piece cannot be tried on. Ask the shop for a photo.');

  try {
    return await wearIt({ clientId, garment, photoBase64: photoRaw, from: 'SHOP_PAGE' });
  } catch (e) {
    /*
     * Turned into this module's own refusal, so the shop page's one error shape still holds -- and
     * a shopper hears what to do rather than what a gateway said. The out-of-allowance case gains
     * the sentence that is actually useful to them: the shop can still send a photo by hand.
     */
    if (e instanceof TryOnWearError) {
      throw new OnlineShopRuleError(
        e.statusCode === 429
          ? 'This shop has used all its try-ons for now. Ask them on WhatsApp — they will send you a photo.'
          : e.message
      );
    }
    throw e;
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
        // createdAt breaks the tie: orderIndex counts within a colour, so several colours
        // share the same index and "the first photograph" was whichever one came back first.
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }]
      }
    }
  });
  const photo = product?.images.find(i => i.isPrimary)?.url ?? product?.images[0]?.url;
  if (!product || !photo) return null;
  return { title: product.title, dressType: product.dressType, imageUrl: photo };
}
