/**
 * How long to wait before trying again, after `attempts` failures.
 *
 * Exponential with a ceiling: roughly 30s, 1m, 2m, 4m, 8m, 16m, 30m, 30m. Jittered, so a
 * destination that went down while a thousand pieces of work were queued does not receive all of
 * them again in the same instant when it returns.
 *
 * One schedule for everything that retries outbound work -- storefront deliveries and Shopify
 * discount pushes both ask this. Two copies of a backoff drift the day one of them is tuned.
 */
export function backoffMs(attempts: number): number {
  const base = Math.min(30_000 * 2 ** (Math.max(1, attempts) - 1), 30 * 60_000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}
