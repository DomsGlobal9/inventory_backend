import { env } from '../../config/env';
import { serviceCredentialService } from './credential.service';

/**
 * What a shop's catalog try-on has cost this month at ScaleEzy's prices, for the console.
 *
 * Read from the Gateway's caller-facing GET /api/v1/usage?month=YYYY-MM, which answers for
 * whoever's key is presented -- so it is asked ONLY with the shop's OWN key. A shop on the shared
 * key would be shown ScaleEzy's entire bill as its own, so it is told that instead and nothing is
 * fetched. The key is used server-side here and goes nowhere else: the browser gets the four
 * fields below and never the key or the Gateway's full answer.
 *
 * Any failure -- billing not deployed yet (404), the Gateway down, a timeout, a body we cannot
 * read -- is the same one plain state, NOT_ON, which the screen shows as a sentence. A bill that
 * cannot be read is not something the person looking at it can fix, so it is never an error.
 */
export type ChargesState =
  | { state: 'ON'; month: string; totalPaise: number; gstPaise: number | null; gstRatePercent: number | null }
  | { state: 'NOT_ON' }
  | { state: 'SHARED_KEY' }
  | { state: 'NO_KEY' };

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

/** Keyed by shop, month and key prefix, so replacing a key is never answered from the old one. */
const cache = new Map<string, { at: number; value: ChargesState }>();

const isPaise = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Pulls the four fields we show out of the Gateway's answer, or null if it is not that shape. */
function readUsageBody(body: any, month: string): ChargesState | null {
  const totalPaise = body?.total?.paise;
  if (!isPaise(totalPaise)) return null;
  const gstPaise = body?.gst?.amount?.paise;
  const rate = body?.gst?.ratePercent;
  return {
    state: 'ON',
    month: typeof body?.month === 'string' ? body.month : month,
    totalPaise,
    gstPaise: body?.gst ? (isPaise(gstPaise) ? gstPaise : null) : null,
    gstRatePercent: body?.gst && typeof rate === 'number' ? rate : null
  };
}

export async function catalogChargesFor(clientId: string, month: string): Promise<ChargesState> {
  const own = await serviceCredentialService.ownKeyFor(clientId, 'CATALOG_TRYON');
  if (!own) return env.CATALOG_TRYON_API_KEY ? { state: 'SHARED_KEY' } : { state: 'NO_KEY' };
  if (!env.CATALOG_TRYON_GATEWAY_URL) return { state: 'NOT_ON' };

  const cacheKey = `${clientId}|${month}|${own.keyPrefix}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value: ChargesState = { state: 'NOT_ON' };
  try {
    const url = `${env.CATALOG_TRYON_GATEWAY_URL.replace(/\/+$/, '')}/api/v1/usage?month=${encodeURIComponent(month)}`;
    const res = await fetch(url, {
      headers: { 'x-api-key': own.key, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.ok) {
      value = readUsageBody(await res.json().catch(() => null), month) ?? { state: 'NOT_ON' };
    } else {
      // Logged with the status only. 404 is the normal answer until billing is deployed.
      if (res.status !== 404) console.warn(`[tryon-charges] gateway usage answered HTTP ${res.status} for ${clientId}`);
    }
  } catch (error: any) {
    console.warn(`[tryon-charges] could not read gateway usage for ${clientId}: ${error?.name ?? 'error'}`);
  }

  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** For tests: forget everything cached. */
export function clearChargesCache() {
  cache.clear();
}
