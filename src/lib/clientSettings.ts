import { prisma } from './prisma';

/**
 * A shop's settings, read once and remembered briefly.
 *
 * Three services were each fetching this row for themselves -- the day book for the timezone,
 * the snapshot job for the timezone, the storefront catalogue for the currency. Every one of
 * those is a round trip, and with the database on another continent a round trip is about a
 * second. The storefront one is the worst placed: it sat on the path of a merchant's own
 * website loading its product list, adding a second to a page a shopper is waiting on, to
 * fetch the string "INR".
 *
 * These values change approximately never -- a shop does not move timezone or change currency
 * on a Tuesday afternoon. A minute of staleness costs nothing and buys back a second on
 * almost every report, every snapshot and every storefront read.
 *
 * Deliberately in-process rather than in Redis: it is two short strings, the win comes from
 * not crossing the network at all, and putting it in Redis would replace one round trip with
 * a different one.
 */

export interface ShopSettings {
  timezone: string;
  currency: string;
  businessName: string | null;
}

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_CURRENCY = 'INR';

const TTL_MS = 60_000;
const cache = new Map<string, { value: ShopSettings; expires: number }>();

/** The shop's settings, from cache when it is fresh enough. */
export async function getShopSettings(clientId: string): Promise<ShopSettings> {
  const cached = cache.get(clientId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const row = await prisma.clientSettings.findUnique({
    where: { clientId },
    select: { timezone: true, currency: true, businessName: true }
  });

  const value: ShopSettings = {
    timezone: row?.timezone || DEFAULT_TIMEZONE,
    currency: row?.currency || DEFAULT_CURRENCY,
    businessName: row?.businessName || null
  };

  cache.set(clientId, { value, expires: Date.now() + TTL_MS });
  return value;
}

/**
 * Forgets a shop's cached settings.
 *
 * Called when settings are saved, so a deliberate change is visible immediately rather than
 * up to a minute later. The TTL is still the safety net -- this is the courtesy, not the
 * correctness: a process that never sees the write (another instance, a background job) still
 * catches up within the minute.
 */
export function forgetShopSettings(clientId: string) {
  cache.delete(clientId);
}
