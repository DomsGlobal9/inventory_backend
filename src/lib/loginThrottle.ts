/**
 * Slowing down password guessing against one account.
 *
 * The only limit on sign-in was 100 requests a minute per address, so anyone could try 100 passwords
 * a minute against one account -- from each address they had -- and the right password still worked
 * the moment it came up. After LIMIT wrong passwords for an account inside WINDOW, sign-in for that
 * account is refused until the oldest failure is WINDOW old. A correct sign-in clears the record.
 *
 * Keyed on the email address, not the address it came from: that is what a guesser rotates around.
 * The trade-off is that someone can hold a known email out for a quarter of an hour by guessing at
 * it; the window is kept short for that reason, and the person can still ask an admin for a reset.
 *
 * In memory, per server. The service runs as one instance; a restart forgets, which only ever errs
 * towards letting a real person back in.
 */

const WINDOW_MS = 15 * 60_000;
const LIMIT = 8;
const MAX_TRACKED = 20_000;

const failures = new Map<string, number[]>();

function recent(key: string, now = Date.now()): number[] {
  const list = (failures.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list); else failures.delete(key);
  return list;
}

/** How long this account must wait before trying again, in milliseconds; 0 when it may try now. */
export function lockedFor(key: string): number {
  const now = Date.now();
  const list = recent(key, now);
  if (list.length < LIMIT) return 0;
  return WINDOW_MS - (now - list[list.length - LIMIT]);
}

export function recordFailure(key: string): void {
  const list = recent(key);
  list.push(Date.now());
  failures.set(key, list);
  // Bounded: a flood of made-up emails must not grow this without end.
  if (failures.size > MAX_TRACKED) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
}

export function clearFailures(key: string): void {
  failures.delete(key);
}

export const loginKey = (realm: 'shop' | 'admin', email: unknown) => `${realm}:${String(email ?? '').trim().toLowerCase()}`;

export function tooManyMessage(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Too many wrong passwords for this account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask your admin to reset it.`;
}
