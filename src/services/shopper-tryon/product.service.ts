import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { categoryFor, TryOnCategory } from './gateway.service';

/**
 * Turning a scanned QR code into a garment to try on.
 *
 * The caller here is ANONYMOUS -- a shopper holding a phone in a shop, with no account and no
 * session. That single fact drives every decision in this file:
 *
 *   - it returns the least it can. A title and one image. Not cost, not stock, not supplier,
 *     not the variant list, not the product's internal id.
 *   - it is addressed by (clientId, productCode), not by a database id. A UUID in a printed
 *     QR code invites walking the table; a product code is already public, printed on the tag
 *     and shown to customers.
 *   - it will not resolve a product the shop has not published. A DRAFT is a garment the
 *     merchant has not decided about yet, and a TRASHED one is deleted as far as they are
 *     concerned. Neither should be reachable by guessing a code.
 *
 * It also refuses to hand back anything that is not publicly fetchable, because the gateway
 * downloads the garment image itself: an image the gateway cannot reach fails deep inside a
 * generation the shopper has already waited for, instead of here.
 */

export type ScannedGarment = {
  clientId: string;
  productCode: string;
  title: string;
  imageUrl: string;
  category: TryOnCategory;
};

export class ShopperTryOnProductService {
  /**
   * The URL a printed QR code should carry.
   *
   * Built here rather than in the browser so that every QR -- product screen, label sheet,
   * whatever comes later -- is the same shape, and so the destination can be changed in the
   * environment without reprinting anything already stuck to a garment.
   */
  scanUrlFor(clientId: string, productCode: string): string | null {
    if (!env.SHOPPER_TRYON_APP_URL) return null;
    const base = env.SHOPPER_TRYON_APP_URL.replace(/\/+$/, '');
    return `${base}/try/${encodeURIComponent(clientId)}/${encodeURIComponent(productCode)}`;
  }

  /**
   * Resolves a scan. Returns null when there is nothing a shopper may see.
   *
   * Null rather than a thrown error with a reason: "no such product", "that product is a
   * draft" and "that product has no photograph" are all the same answer to someone who is not
   * signed in, and distinguishing them turns this into a tool for probing what a shop has.
   */
  async resolve(clientId: string, productCode: string): Promise<ScannedGarment | null> {
    if (!clientId || !productCode) return null;

    const product = await prisma.product.findFirst({
      where: {
        clientId,
        productCode,
        // Published only. A draft is a decision the merchant has not made yet.
        status: 'ACTIVE'
      },
      select: {
        title: true,
        productCode: true,
        dressType: true,
        images: {
          // The garment as the merchant chose to lead with, which is the one on the tag.
          orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }],
          take: 1,
          select: { url: true }
        }
      }
    });

    const imageUrl = product?.images?.[0]?.url;
    // No photograph means no try-on. Saying so here is honest; letting it through means the
    // shopper uploads a selfie, waits twenty seconds and then meets a failure.
    if (!product || !imageUrl) return null;
    if (!/^https:\/\//i.test(imageUrl)) return null;

    return {
      clientId,
      productCode: product.productCode,
      title: product.title,
      imageUrl,
      category: categoryFor(product.dressType)
    };
  }
}

export const shopperTryOnProductService = new ShopperTryOnProductService();
