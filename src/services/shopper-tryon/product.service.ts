import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { categoryFor, TryOnCategory } from './gateway.service';

/**
 * Turning a scanned QR code into a garment to try on.
 *
 * The caller here is ANONYMOUS -- a shopper holding a phone in a shop, with no account and no
 * session. That single fact drives every decision in this file:
 *
 *   - it returns the least it can. A title, one image, and the colours that garment comes in.
 *     Not cost, not stock, not supplier, not the product's internal id.
 *
 *     The colours were once withheld too, and that was wrong: a shopper scanning the tag on a
 *     rack of one saree in five colours was tried on in whichever one happened to be the cover,
 *     with nothing on the screen to say so. A colour name and a photograph are what is already
 *     hanging in front of them.
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
  /** Set only when the scan named a colour this product actually has. */
  variantCode?: string;
  colourName?: string | null;
};

/**
 * Extras a scan link may carry. Every field optional, by design -- see scanUrlFor.
 * New parameters go here rather than into a widening argument list.
 */
export type ScanUrlOptions = {
  /** Where the try-on page's Back control returns the shopper. Must be an allowed origin. */
  returnUrl?: string | null;
  /** Which surface produced this link: 'product-screen', 'label-sheet', 'storefront'. */
  source?: string | null;
  /**
   * The exact colour and size the tag is tied to.
   *
   * A QUERY PARAMETER rather than another path segment, and the difference decides whether tags
   * printed today are still right tomorrow. A path the try-on app does not serve is a 404 in a
   * customer's hand; an unknown query parameter is ignored and they get the product, which is
   * exactly what they get now. So every tag can carry its variant from the first print run, and
   * the day the try-on app learns to read it, every tag already hanging on a saree starts
   * opening the right colour -- with nothing reprinted.
   */
  variantCode?: string | null;
};

/**
 * Origins a scan link may send a shopper back to.
 *
 * Parsed per call rather than cached, because env is loaded once at boot and this is not hot:
 * getProductById, and printing a sheet of labels. Clarity is worth more than the microseconds.
 */
function allowedReturnOrigins(): string[] {
  const configured = (env.SHOPPER_TRYON_RETURN_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // FRONTEND_URL is always allowed: a shopper who came from our own front end returning to it
  // is the ordinary case, and requiring separate configuration for it would mean the feature
  // silently does nothing in most deployments.
  const candidates = configured.length > 0 ? [...configured, env.FRONTEND_URL] : [env.FRONTEND_URL];

  return candidates
    .map(value => { try { return new URL(value).origin; } catch { return null; } })
    .filter((origin): origin is string => origin !== null);
}

/**
 * Returns the URL only if a shopper may safely be sent there, otherwise null.
 *
 * Rejects anything that is not http(s) -- javascript:, data: and friends are XSS vectors the
 * moment a page turns this into an href -- and anything off the allow-list.
 */
function safeReturnUrl(candidate?: string | null): string | null {
  if (!candidate || typeof candidate !== 'string') return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null; // relative or malformed: there is no safe way to guess what was meant
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!allowedReturnOrigins().includes(url.origin)) return null;

  return url.toString();
}

/** A short, boring identifier. Anything else is dropped rather than sanitised into nonsense. */
function safeToken(candidate?: string | null): string | null {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > 40) return null;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

export class ShopperTryOnProductService {
  /**
   * The URL a printed QR code should carry.
   *
   * Built here rather than in the browser so that every QR -- product screen, label sheet,
   * whatever comes later -- is the same shape, and so the destination can be changed in the
   * environment without reprinting anything already stuck to a garment.
   *
   * Options are carried as query parameters and every one of them is optional, because the
   * link has to keep working when it is a code printed on a tag with no context at all. A
   * parameter that is missing, malformed or not allowed is dropped and the rest of the link
   * still resolves -- a tag that half-works is a tag that works.
   */
  scanUrlFor(clientId: string, productCode: string, options: ScanUrlOptions = {}): string | null {
    if (!env.SHOPPER_TRYON_APP_URL) return null;

    const base = env.SHOPPER_TRYON_APP_URL.replace(/\/+$/, '');
    const url = `${base}/try/${encodeURIComponent(clientId)}/${encodeURIComponent(productCode)}`;

    const params = new URLSearchParams();

    // Where the try-on page's Back control should return the shopper. Validated against the
    // allow-list, never taken on trust -- see allowedReturnOrigins below.
    const returnUrl = safeReturnUrl(options.returnUrl);
    if (returnUrl) params.set('returnUrl', returnUrl);

    // Which surface the scan came from: 'product-screen', 'label-sheet', 'storefront'.
    // Carried so the try-on side can tell a printed tag from a link somebody tapped, without
    // us having to guess from the referrer later.
    const source = safeToken(options.source);
    if (source) params.set('source', source);

    // See ScanUrlOptions.variantCode: safe to send before anything reads it.
    const variant = safeToken(options.variantCode);
    if (variant) params.set('variant', variant);

    const query = params.toString();
    return query ? `${url}?${query}` : url;
  }

  /**
   * Resolves a scan. Returns null when there is nothing a shopper may see.
   *
   * Null rather than a thrown error with a reason: "no such product", "that product is a
   * draft" and "that product has no photograph" are all the same answer to someone who is not
   * signed in, and distinguishing them turns this into a tool for probing what a shop has.
   */
  async resolve(
    clientId: string,
    productCode: string,
    variantCode?: string | null
  ): Promise<ScannedGarment | null> {
    if (!clientId || !productCode) return null;

    // Through the same gate every other scan parameter passes: a malformed one is dropped and
    // the rest of the link still resolves.
    const wanted = safeToken(variantCode);

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
          orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }, { createdAt: 'asc' }],
          take: 1,
          select: { url: true }
        },
        /*
         * The colour the tag was tied to, if the scan named one.
         *
         * A swing tag hangs on ONE saree, and its code carries ?variant=. A customer holding the
         * goldenrod one has already chosen; showing them the crimson because it happens to be the
         * product's cover is worse than showing them nothing, because they believe it.
         *
         * Matched against this product's own variants, never trusted from the query: otherwise a
         * made-up code would be a way to point one shop's try-on at another shop's photograph.
         */
        variants: wanted
          ? {
              where: { variantCode: wanted },
              take: 1,
              select: {
                variantCode: true, colorName: true,
                images: {
                  orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }, { createdAt: 'asc' }],
                  take: 1,
                  select: { url: true }
                }
              }
            }
          : false
      }
    });

    /*
     * The variant's photograph when there is one, the product's otherwise.
     *
     * Falling back rather than refusing, because a tag outlives the data behind it: a colour
     * gets renamed, a photograph is removed, and the tag is still hanging on the garment. A
     * shopper scanning it should see the saree, not an error about a variant code.
     */
    const chosen = (product as any)?.variants?.[0];
    const imageUrl = chosen?.images?.[0]?.url ?? product?.images?.[0]?.url;
    // No photograph means no try-on. Saying so here is honest; letting it through means the
    // shopper uploads a selfie, waits twenty seconds and then meets a failure.
    if (!product || !imageUrl) return null;
    if (!/^https:\/\//i.test(imageUrl)) return null;

    return {
      clientId,
      productCode: product.productCode,
      title: product.title,
      imageUrl,
      category: categoryFor(product.dressType),
      // Only when the scan actually landed on one, so the page can name the colour it is showing.
      ...(chosen ? { variantCode: chosen.variantCode, colourName: chosen.colorName ?? null } : {})
    };
  }

  /**
   * The colours this garment comes in, for the shopper to pick from before trying it on.
   *
   * A QR code on a product -- the one on the product screen, not a swing tag -- names no colour,
   * so the try-on used the cover photograph. A shopper standing at a rack of the same saree in
   * five colours was shown themselves in whichever one the shop happened to lead with, with
   * nothing on the screen admitting it. Asking first is the only honest version.
   *
   * Public, so it carries a colour, a code and a picture and nothing else -- no price, no stock,
   * no ids. One entry per COLOUR rather than per variant: red/S, red/M and red/L are the same
   * garment and the same photographs, and offering the shopper three identical choices is
   * offering them a decision they do not have.
   *
   * A colour with no photograph of its own is included using the cover, because it is genuinely
   * on the rack; it simply looks like the product. A colour whose only picture is not publicly
   * fetchable is dropped, for the reason in resolve: the gateway downloads these itself.
   */
  async coloursFor(
    clientId: string,
    productCode: string
  ): Promise<Array<{ variantCode: string; colourName: string | null; imageUrl: string }>> {
    if (!clientId || !productCode) return [];

    const product = await prisma.product.findFirst({
      where: { clientId, productCode, status: 'ACTIVE' },
      select: {
        images: {
          orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }, { createdAt: 'asc' }],
          take: 1,
          select: { url: true }
        },
        variants: {
          orderBy: [{ colorName: 'asc' }, { variantCode: 'asc' }],
          select: {
            variantCode: true,
            colorName: true,
            images: {
              orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }, { createdAt: 'asc' }],
              take: 1,
              select: { url: true }
            }
          }
        }
      }
    });
    if (!product) return [];

    const cover = product.images?.[0]?.url ?? null;
    const seen = new Set<string>();
    const out: Array<{ variantCode: string; colourName: string | null; imageUrl: string }> = [];

    for (const v of product.variants) {
      // One per colour. A variant with no colour name is its own entry -- there is nothing to
      // group it by, and dropping it would hide a garment that is on the rack.
      const key = (v.colorName ?? `~${v.variantCode}`).trim().toLowerCase();
      if (seen.has(key)) continue;

      const imageUrl = v.images?.[0]?.url ?? cover;
      if (!imageUrl || !/^https:\/\//i.test(imageUrl)) continue;

      seen.add(key);
      out.push({ variantCode: v.variantCode, colourName: v.colorName ?? null, imageUrl });
    }

    return out;
  }
}

export const shopperTryOnProductService = new ShopperTryOnProductService();
