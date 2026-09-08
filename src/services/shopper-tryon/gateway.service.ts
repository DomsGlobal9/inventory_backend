import { env } from '../../config/env';
import { serviceCredentialService } from '../tryon';

/**
 * The outbound call to the gateway for a shopper try-on, and nothing else.
 *
 * Different from the catalog service in every way that matters, which is why it is a separate
 * module rather than a flag on the existing one:
 *
 *   catalog   one garment photo in, four catalogue views out, streamed, staff-initiated
 *   shopper   a garment AND a photograph of a person in, one image out, synchronous, public
 *
 * The gateway documents this as synchronous and typically 10-25 seconds, so there is no stream
 * to proxy -- a single request that stays open. The timeout below is deliberately generous for
 * that reason and deliberately finite: without one, a gateway that hangs holds a connection
 * from a shopper's phone open forever.
 */

const TRYON_PATH = '/api/external/tryon';
const GENERATION_TIMEOUT_MS = 90_000;

/** What the gateway accepts. Anything outside this falls back to DEFAULT rather than erroring. */
const CATEGORIES = ['SAREE', 'LEHANGA', 'ANARKALI', 'SHARARA', 'KURTHI', 'DEFAULT'] as const;
export type TryOnCategory = (typeof CATEGORIES)[number];

/**
 * Maps whatever this shop happens to call a garment onto what the gateway understands.
 *
 * Matched loosely on purpose. `dressType` is free text a merchant typed -- "Lehenga",
 * "lehanga", "Bridal Lehenga" are all real values in this database -- and the alternative to
 * matching loosely is refusing a try-on because someone spelled it differently.
 */
export function categoryFor(dressType?: string | null): TryOnCategory {
  const text = (dressType ?? '').toLowerCase();
  if (!text) return 'DEFAULT';
  if (text.includes('saree') || text.includes('sari')) return 'SAREE';
  if (text.includes('lehenga') || text.includes('lehanga')) return 'LEHANGA';
  if (text.includes('anarkali')) return 'ANARKALI';
  if (text.includes('sharara')) return 'SHARARA';
  if (text.includes('kurti') || text.includes('kurtha') || text.includes('kurtha')) return 'KURTHI';
  return 'DEFAULT';
}

export type ShopperTryOnResult = {
  resultImageUrl: string;
  processingTimeMs?: number;
};

export class ShopperTryOnGatewayService {
  private gatewayUrl() {
    // NO FALLBACK TO THE CATALOG GATEWAY, deliberately.
    //
    // This originally fell back to CATALOG_TRYON_GATEWAY_URL on the assumption that both
    // services sat behind one gateway. They do not: the gateway routes by slug, and the two
    // are registered separately -- /api/gateway/cat for catalogue, /api/gateway/external for
    // this one. Probing confirmed it, and the console's API list agrees.
    //
    // So the fallback would have quietly pointed shopper try-ons at the catalogue slug, where
    // this path does not exist. The shopper would meet an unexplained failure, and the shop
    // would be charged for it, because a 404 from the gateway is recorded as a failed
    // generation. Missing configuration must announce itself instead.
    const url = env.SHOPPER_TRYON_GATEWAY_URL;
    if (!url) {
      throw Object.assign(
        new Error('Try-On is not configured for this deployment (SHOPPER_TRYON_GATEWAY_URL is not set).'),
        { statusCode: 503 }
      );
    }
    return url;
  }

  /**
   * One try-on: this garment, on this person.
   *
   * Presents THIS SHOP'S key, so the gateway meters the shop whose QR code was scanned rather
   * than the platform as a whole. A shop with no key of its own falls back to the shared one
   * and is still metered here, on our side, against its own clientId.
   */
  async generate(params: {
    clientId: string;
    garmentImageUrl: string;
    humanImageUrl: string;
    category?: TryOnCategory;
  }): Promise<ShopperTryOnResult> {
    const url = this.gatewayUrl();
    const { key } = await serviceCredentialService.keyFor(params.clientId, 'SHOPPER_TRYON');

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), GENERATION_TIMEOUT_MS);

    try {
      const response = await fetch(`${url}${TRYON_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          garmentImageUrl: params.garmentImageUrl,
          humanImageUrl: params.humanImageUrl,
          category: params.category ?? 'DEFAULT',
          responseType: 'url'
        }),
        signal: abort.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // The gateway's own words are not shown to a shopper -- they may name internal
        // services or quota mechanics. The status is kept so the caller can tell a refusal
        // from a breakage, and the detail goes to our logs.
        console.error(`[ShopperTryOn] gateway ${response.status} for ${params.clientId}: ${text.slice(0, 300)}`);
        throw Object.assign(
          new Error('The try-on service could not complete this request.'),
          { statusCode: response.status >= 500 ? 502 : response.status }
        );
      }

      const body = await response.json().catch(() => null) as any;
      const resultImageUrl = body?.resultImageUrl ?? body?.result_image_url;

      if (!resultImageUrl) {
        // A 200 with nothing usable in it is a failure, and must be recorded as one rather
        // than handed to the shopper as an empty screen.
        throw Object.assign(
          new Error('The try-on finished but produced no image.'),
          { statusCode: 502 }
        );
      }

      return { resultImageUrl, processingTimeMs: body?.processingTimeMs };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw Object.assign(
          new Error('The try-on took too long and was stopped. Please try again.'),
          { statusCode: 504 }
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const shopperTryOnGatewayService = new ShopperTryOnGatewayService();
