import { createHash } from 'node:crypto';

// Pure business rules, kept free of I/O so they can be tested exactly.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DUPLICATE_WINDOW_MS = 60 * 1000;
export const EXPIRY_MS = DAY_MS;
export const NUMBER_CHECK_TTL_MS = 7 * DAY_MS;
export const STALE_SENDING_MS = 2 * 60 * 1000;
export const MAX_TRIES = 3;

// India has no daylight saving; "today" for caps is the Indian calendar day.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Start of the current Indian day, as a UTC instant. */
export function istDayStart(now: Date): Date {
  const shifted = now.getTime() + IST_OFFSET_MS;
  const dayStartShifted = shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS);
  return new Date(dayStartShifted - IST_OFFSET_MS);
}

export function nextIstDayStart(now: Date): Date {
  return new Date(istDayStart(now).getTime() + DAY_MS);
}

/** Hour of the day in India (0-23). */
export function istHour(now: Date): number {
  return Math.floor((((now.getTime() + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / (60 * 60 * 1000));
}

export const NEW_NUMBER_DAYS = 14;
export const NEW_NUMBER_CAP = 40;
export const SETTLED_NUMBER_CAP = 200;

export interface CapInput {
  kind: 'SCALEEZY' | 'CLIENT';
  dailyCap: number | null;
  linkedAt: Date | null;
}

/**
 * Messages a number may send per Indian day. A newly linked number sends little for its first
 * two weeks: sudden volume from a fresh link is what WhatsApp bans.
 */
export function dailyCapFor(account: CapInput, now: Date, scaleezyCap: number): number {
  if (account.dailyCap !== null && account.dailyCap >= 0) return account.dailyCap;
  if (account.kind === 'SCALEEZY') return scaleezyCap;
  if (!account.linkedAt) return NEW_NUMBER_CAP;
  const age = now.getTime() - account.linkedAt.getTime();
  return age < NEW_NUMBER_DAYS * DAY_MS ? NEW_NUMBER_CAP : SETTLED_NUMBER_CAP;
}

export function isOverCap(sentToday: number, cap: number): boolean {
  return sentToday >= cap;
}

export function isExpired(queuedAt: Date, now: Date): boolean {
  return now.getTime() - queuedAt.getTime() >= EXPIRY_MS;
}

export function isWithinDuplicateWindow(earlierQueuedAt: Date, now: Date): boolean {
  const age = now.getTime() - earlierQueuedAt.getTime();
  return age >= 0 && age < DUPLICATE_WINDOW_MS;
}

export function isNumberCheckFresh(checkedAt: Date, now: Date): boolean {
  return now.getTime() - checkedAt.getTime() < NUMBER_CHECK_TTL_MS;
}

/** Same words and same document hash the same, whatever order they arrive in. */
export function contentHash(text: string | null | undefined, document: Buffer | null | undefined): string {
  const h = createHash('sha256');
  h.update('t:');
  h.update(text ?? '', 'utf8');
  h.update('|d:');
  if (document) h.update(createHash('sha256').update(document).digest('hex'));
  return h.digest('hex');
}

/** Wait before retry n (1-based): 30 s, 2 min, 8 min. */
export function backoffMs(tries: number): number {
  return 30_000 * Math.pow(4, Math.max(0, tries - 1));
}

/** Human-like pause between two messages from the same number. */
export function randomGapMs(minMs: number, maxMs: number, rand: () => number = Math.random): number {
  return Math.round(minMs + (maxMs - minMs) * rand());
}
