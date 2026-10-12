import { describe, expect, it } from 'vitest';
import { rateLimit } from '../../src/http/rate-limit';
import { AppError } from '../../src/lib/errors';

// A request is only what the limiter reads: a header getter and an address.
const req = (key?: string, ip = '10.0.0.1') => ({ get: (h: string) => (h === 'x-module-key' ? key : undefined), ip }) as any;
const run = (mw: ReturnType<typeof rateLimit>, r: any) => {
  let out: unknown = 'not called';
  mw(r, {} as any, (e?: unknown) => { out = e ?? null; });
  return out;
};

describe('rateLimit', () => {
  it('lets a key make perMinute requests a minute, then refuses in words with 429', () => {
    let t = 0;
    const mw = rateLimit(3, () => t);
    expect([1, 2, 3].map(() => run(mw, req('key-a')))).toEqual([null, null, null]);
    const refused = run(mw, req('key-a')) as AppError;
    expect(refused).toBeInstanceOf(AppError);
    expect(refused.status).toBe(429);
    expect(refused.message).toMatch(/Slow down and try again in a minute/);
  });

  it('counts each key on its own, and a new minute starts afresh', () => {
    let t = 0;
    const mw = rateLimit(1, () => t);
    expect(run(mw, req('key-a'))).toBeNull();
    expect(run(mw, req('key-b'))).toBeNull(); // another module is not slowed by the first
    expect(run(mw, req('key-a'))).toBeInstanceOf(AppError);
    t = 60_000;
    expect(run(mw, req('key-a'))).toBeNull();
  });

  it('without a key, counts by address (someone guessing keys)', () => {
    const mw = rateLimit(1, () => 0);
    expect(run(mw, req(undefined, '1.1.1.1'))).toBeNull();
    expect(run(mw, req(undefined, '1.1.1.1'))).toBeInstanceOf(AppError);
    expect(run(mw, req(undefined, '2.2.2.2'))).toBeNull();
  });
});
