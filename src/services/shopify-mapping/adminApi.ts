/**
 * Asking a merchant's Shopify store a question.
 *
 * An INTERFACE first, and the real HTTP implementation second, for one reason: everything that
 * reads a store -- its locations, its variants -- has decisions in it worth testing (which SKU is
 * ambiguous, which location is already paired), and none of those decisions should need a live
 * Shopify store to prove. The services take a `ShopifyAdminApi`; production passes the real one,
 * the verification suites pass a fake that returns whatever store they are imagining.
 */

import axios from 'axios';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { adminApiBase } from '../../utils/shopifyDomain';
import { shopifyInstallationService } from '../shopify-installation.service';

export interface ShopifyAdminApi {
  graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

/** Something a merchant can act on -- reconnect, grant a scope, try later. Safe to show. */
export class ShopifyApiError extends Error {
  /** `statusCode`, because that is what respondWithError reads to decide it was deliberate. */
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The installation this tenant has connected, or a sentence saying there is none.
 *
 * Every mapping action starts here, so "you have not connected Shopify" is said once, the same
 * way, rather than surfacing as a null dereference three calls later.
 */
export async function activeInstallation(clientId: string) {
  const installation = await prisma.shopifyInstallation.findFirst({
    where: { clientId, uninstalledAt: null },
    select: { id: true, shopDomain: true, scopes: true }
  });
  if (!installation) {
    throw new ShopifyApiError('No Shopify store is connected to this workspace.', 404);
  }
  return installation;
}

/**
 * The real thing: GraphQL over HTTPS with the store's token.
 *
 * Shopify rate-limits by a cost bucket rather than a request count, and says so in two different
 * ways -- an HTTP 429, or a 200 whose body carries a THROTTLED error. Both are retried with a
 * growing wait. Anything else is turned into a sentence: a merchant reading "Request failed with
 * status code 403" learns nothing, while "Shopify refused -- reconnect and approve read_locations"
 * is something they can do.
 *
 * The token never appears in an error, a log line or a return value.
 */
export async function adminApiFor(installationId: string, shopDomain: string): Promise<ShopifyAdminApi> {
  const token = await shopifyInstallationService.accessTokenFor(installationId);
  const url = `${adminApiBase(shopDomain, env.SHOPIFY_API_VERSION)}/graphql.json`;

  return {
    async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let response;
        try {
          response = await axios.post(url, { query, variables }, {
            timeout: REQUEST_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            validateStatus: () => true
          });
        } catch {
          if (attempt === MAX_ATTEMPTS) {
            throw new ShopifyApiError(`Could not reach ${shopDomain}. Try again in a moment.`, 504);
          }
          await sleep(500 * 2 ** attempt);
          continue;
        }

        const throttled = response.status === 429
          || (Array.isArray(response.data?.errors)
            && response.data.errors.some((e: any) => e?.extensions?.code === 'THROTTLED'));

        if (throttled) {
          if (attempt === MAX_ATTEMPTS) {
            throw new ShopifyApiError('Shopify is busy with this store right now. Try again in a minute.', 503);
          }
          const retryAfter = Number(response.headers?.['retry-after']);
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          throw new ShopifyApiError(
            `Shopify refused the request for ${shopDomain}. Reconnect the store and approve the permissions it asks for.`,
            403
          );
        }

        if (response.status >= 400) {
          throw new ShopifyApiError(`Shopify answered with an error (${response.status}). Try again shortly.`, 502);
        }

        const errors = response.data?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
          const denied = errors.some((e: any) => e?.extensions?.code === 'ACCESS_DENIED');
          if (denied) {
            throw new ShopifyApiError(
              'Shopify did not grant this app permission to read that. Reconnect the store and approve every permission.',
              403
            );
          }
          console.error(`[Shopify] GraphQL errors from ${shopDomain}:`, JSON.stringify(errors).slice(0, 1000));
          throw new ShopifyApiError('Shopify could not answer that question about your store. Try again shortly.', 502);
        }

        return response.data?.data as T;
      }
      throw new ShopifyApiError('Shopify did not answer. Try again shortly.', 504);
    }
  };
}

/**
 * Shopify's ids, as the webhooks spell them.
 *
 * GraphQL says `gid://shopify/Location/71234`; an order webhook says `location_id: 71234`. The
 * maps are matched against webhooks, so they are stored in the webhook's spelling -- storing the
 * GraphQL form would mean no order ever found its location, silently.
 */
export function numericShopifyId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/(\d+)$/);
  return match ? match[1] : null;
}
