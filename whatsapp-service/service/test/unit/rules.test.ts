import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  contentHash,
  dailyCapFor,
  DAY_MS,
  isExpired,
  isNumberCheckFresh,
  isOverCap,
  istDayStart,
  istHour,
  isWithinDuplicateWindow,
  nextIstDayStart,
  randomGapMs,
} from '../../src/domain/rules';

const at = (iso: string) => new Date(iso);

describe('daily cap', () => {
  const now = at('2026-09-18T10:00:00Z');
  it('a new client number gets 40 a day for its first 14 days', () => {
    expect(dailyCapFor({ kind: 'CLIENT', dailyCap: null, linkedAt: at('2026-09-17T10:00:00Z') }, now, 150)).toBe(40);
    expect(dailyCapFor({ kind: 'CLIENT', dailyCap: null, linkedAt: new Date(now.getTime() - 14 * DAY_MS + 1) }, now, 150)).toBe(40);
  });
  it('then 200', () => {
    expect(dailyCapFor({ kind: 'CLIENT', dailyCap: null, linkedAt: new Date(now.getTime() - 14 * DAY_MS) }, now, 150)).toBe(200);
  });
  it('an unlinked client number is treated as new', () => {
    expect(dailyCapFor({ kind: 'CLIENT', dailyCap: null, linkedAt: null }, now, 150)).toBe(40);
  });
  it('the ScaleEzy number uses its configured cap', () => {
    expect(dailyCapFor({ kind: 'SCALEEZY', dailyCap: null, linkedAt: at('2026-09-18T06:00:00Z') }, now, 150)).toBe(150);
  });
  it('a per-number override wins', () => {
    expect(dailyCapFor({ kind: 'CLIENT', dailyCap: 5, linkedAt: null }, now, 150)).toBe(5);
    expect(dailyCapFor({ kind: 'SCALEEZY', dailyCap: 0, linkedAt: null }, now, 150)).toBe(0);
  });
  it('the cap is reached at exactly the cap', () => {
    expect(isOverCap(39, 40)).toBe(false);
    expect(isOverCap(40, 40)).toBe(true);
    expect(isOverCap(41, 40)).toBe(true);
  });
});

describe('Indian day boundaries', () => {
  it('the day starts at 00:00 IST = 18:30 UTC the previous day', () => {
    expect(istDayStart(at('2026-09-18T10:00:00Z')).toISOString()).toBe('2026-09-17T18:30:00.000Z');
    expect(istDayStart(at('2026-09-18T18:29:59Z')).toISOString()).toBe('2026-09-17T18:30:00.000Z');
    expect(istDayStart(at('2026-09-18T18:30:00Z')).toISOString()).toBe('2026-09-18T18:30:00.000Z');
    expect(nextIstDayStart(at('2026-09-18T10:00:00Z')).toISOString()).toBe('2026-09-18T18:30:00.000Z');
  });
  it('hour of day in India', () => {
    expect(istHour(at('2026-09-18T03:30:00Z'))).toBe(9);
    expect(istHour(at('2026-09-18T18:29:00Z'))).toBe(23);
    expect(istHour(at('2026-09-18T18:30:00Z'))).toBe(0);
  });
});

describe('expiry', () => {
  it('a message queued 24 h ago or more is expired', () => {
    const now = at('2026-09-18T10:00:00Z');
    expect(isExpired(at('2026-09-17T10:00:01Z'), now)).toBe(false);
    expect(isExpired(at('2026-09-17T10:00:00Z'), now)).toBe(true);
    expect(isExpired(at('2026-09-16T10:00:00Z'), now)).toBe(true);
  });
});

describe('60 second duplicate rule', () => {
  const now = at('2026-09-18T10:00:00Z');
  it('inside the minute is a duplicate, outside is not', () => {
    expect(isWithinDuplicateWindow(at('2026-09-18T09:59:00.001Z'), now)).toBe(true);
    expect(isWithinDuplicateWindow(at('2026-09-18T09:59:00Z'), now)).toBe(false);
    expect(isWithinDuplicateWindow(at('2026-09-18T10:00:05Z'), now)).toBe(false);
  });
  it('same text and document hash the same; any difference does not', () => {
    const pdf = Buffer.from('%PDF-1.4 a');
    expect(contentHash('hi', pdf)).toBe(contentHash('hi', Buffer.from('%PDF-1.4 a')));
    expect(contentHash('hi', pdf)).not.toBe(contentHash('hi ', pdf));
    expect(contentHash('hi', pdf)).not.toBe(contentHash('hi', Buffer.from('%PDF-1.4 b')));
    expect(contentHash(null, pdf)).not.toBe(contentHash('', null));
    // Text cannot be shifted into the document part.
    expect(contentHash('a|d:', null)).not.toBe(contentHash('a', null));
  });
});

describe('number check cache', () => {
  it('is fresh for 7 days', () => {
    const now = at('2026-09-18T10:00:00Z');
    expect(isNumberCheckFresh(new Date(now.getTime() - 7 * DAY_MS + 1), now)).toBe(true);
    expect(isNumberCheckFresh(new Date(now.getTime() - 7 * DAY_MS), now)).toBe(false);
  });
});

describe('retry backoff and gaps', () => {
  it('30 s, 2 min, 8 min', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([30_000, 120_000, 480_000]);
  });
  it('gap stays within 4-9 s', () => {
    expect(randomGapMs(4000, 9000, () => 0)).toBe(4000);
    expect(randomGapMs(4000, 9000, () => 0.999999)).toBe(9000);
    for (let i = 0; i < 200; i++) {
      const g = randomGapMs(4000, 9000);
      expect(g).toBeGreaterThanOrEqual(4000);
      expect(g).toBeLessThanOrEqual(9000);
    }
  });
});
