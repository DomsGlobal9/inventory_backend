import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';

/**
 * The service's front door, per caller: at most `perMinute` requests in each minute, counted per
 * module key (or per address when no key is sent). The daily caps already bound what is SENT;
 * this bounds how hard anyone can knock -- a stuck retry loop, or someone guessing keys.
 *
 * In memory, per instance: a restart forgets the counts, which only ever lets a caller through.
 * shortcut: per-instance counts; if the service runs several instances behind a balancer, move to the database.
 */
export function rateLimit(perMinute: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.get('x-module-key') || req.get('x-admin-key');
    const who = key ? `k:${createHash('sha256').update(key).digest('hex')}` : `ip:${req.ip}`;
    const t = now();
    const w = windows.get(who);
    if (!w || t - w.start >= 60_000) {
      windows.set(who, { start: t, count: 1 });
      if (windows.size > 10_000) for (const [k, v] of windows) if (t - v.start >= 60_000) windows.delete(k);
      return next();
    }
    if (++w.count > perMinute) {
      return next(new AppError(429, 'too_many_requests', 'Too many requests to the WhatsApp service. Slow down and try again in a minute.'));
    }
    next();
  };
}
