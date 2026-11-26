import { env } from '../../config/env';
import { serviceCredentialService } from './credential.service';

const GENERATE_PATH = '/api/v1/draping/generate-catalog';
const CANCEL_PATH = '/api/v1/draping/cancel-job';

export class CatalogTryOnService {
  private assertConfigured() {
    // Only the URL is required here now. The KEY used to be checked too, which would refuse a
    // client who has a perfectly good key of their own on a deployment where the shared
    // fallback had been removed -- which is exactly the end state this work is heading for.
    // Whether a usable key exists is keyFor's question, and it answers it per client.
    if (!env.CATALOG_TRYON_GATEWAY_URL) {
      throw { statusCode: 503, message: 'Catalog Try-On is not configured (missing CATALOG_TRYON_GATEWAY_URL).' };
    }
  }

  // Proxies the Gateway's SSE stream straight through. The Gateway resolves the tenant from
  // the key we present and injects its own separate secret when it forwards to the actual
  // catalog-tryon-microservice -- we never see that secret.
  //
  // The key is now THIS CLIENT'S, where they have one. Every generation from every shop used
  // to arrive at the gateway under one key, so the gateway -- which meters by key -- saw the
  // whole platform as a single customer. There was nothing wrong with the calls; there was
  // simply no way to tell whose they were.
  //
  // A client with no key of their own falls back to the shared one, so this changed nothing on
  // the day it shipped and keys are pasted in as clients are onboarded.
  async streamGenerateCatalog(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    clientId: string
  ) {
    this.assertConfigured();
    const { key } = await serviceCredentialService.keyFor(clientId, 'CATALOG_TRYON');

    const response = await fetch(`${env.CATALOG_TRYON_GATEWAY_URL}${GENERATE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify(payload),
      signal,
    });
    return response;
  }

  /**
   * `clientId` is the tenant -- it chooses which API key we present. `jobKey` is what the far end
   * calls the job, and is what actually gets cancelled; it defaults to the tenant so a caller that
   * never named a job still stops the one it started.
   */
  async cancelJob(clientId: string, jobKey: string = clientId) {
    this.assertConfigured();
    // The same key that started the job. Cancelling with a different one would ask the gateway
    // to stop a job belonging to a tenant it does not think we are.
    const { key } = await serviceCredentialService.keyFor(clientId, 'CATALOG_TRYON');

    const response = await fetch(`${env.CATALOG_TRYON_GATEWAY_URL}${CANCEL_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      // The far end reads this field as the job name, not as who we are -- who we are is the key
      // above and the tenant header the gateway adds.
      body: JSON.stringify({ clientId: jobKey }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw { statusCode: response.status, message: `Cancel-job failed: ${text || response.statusText}` };
    }
    return response.json().catch(() => ({ success: true }));
  }
}

/**
 * The monthly limit set for this shop's key in ScaleEzy's Platform Console (api-super-admin, catalog billing), asked of
 * the gateway's own GET /api/v1/usage before anything is queued (26 Nov 2026). The gateway refuses a generation once
 * the limit is reached (402 MONTHLY_LIMIT_REACHED); asking first means the shop is told at the press, not 59 failures
 * later. Read with the key the shop's runs would use, so it is the same account the gateway meters.
 * Answers null when there is no limit, or the gateway cannot say (old gateway, network): never a reason to refuse.
 * Remembered for 30 seconds per key, so a list of 59 sarees asks once.
 */
export type CatalogLimit = { reached: boolean; limitRupees: string | null; usedRupees: string | null; remainingRupees: string | null };
const limitCache = new Map<string, { at: number; value: CatalogLimit | null }>();
export async function catalogMonthlyLimit(clientId: string): Promise<CatalogLimit | null> {
  if (!env.CATALOG_TRYON_GATEWAY_URL) return null;
  let key: string;
  try { ({ key } = await serviceCredentialService.keyFor(clientId, 'CATALOG_TRYON')); } catch { return null; }
  const cacheKey = key.slice(-12);
  const hit = limitCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  let value: CatalogLimit | null = null;
  try {
    const res = await fetch(`${new URL(env.CATALOG_TRYON_GATEWAY_URL).origin}/api/v1/usage`, {
      headers: { 'x-api-key': key }, signal: AbortSignal.timeout(5_000)
    });
    if (res.ok) {
      const j: any = await res.json().catch(() => null);
      const m = j?.monthlyLimit;
      value = m ? { reached: !!m.reached, limitRupees: m.limit?.rupees ?? null, usedRupees: m.used?.rupees ?? null, remainingRupees: m.remaining?.rupees ?? null } : null;
    }
  } catch { value = null; }
  limitCache.set(cacheKey, { at: Date.now(), value });
  return value;
}
/** Forget what was remembered (a refusal just said the limit is reached; tests). */
export function forgetCatalogLimit() { limitCache.clear(); }

export const catalogTryOnService = new CatalogTryOnService();
