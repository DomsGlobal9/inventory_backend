import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

// Per-user write throttle: without this, every single request from an active user would
// fire a DB write, which is both wasteful and (given this environment's persistent DB
// latency) a real risk of adding contention to the connection pool. A minute of staleness
// on a "last active" timestamp is invisible to anyone looking at it.
const THROTTLE_MS = 60_000;
const lastWriteAt = new Map<string, number>();

export const trackActivity = (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.id;
  next();

  if (!userId) return;
  const now = Date.now();
  const last = lastWriteAt.get(userId) || 0;
  if (now - last < THROTTLE_MS) return;
  lastWriteAt.set(userId, now);

  // Fire-and-forget: this must never slow down or fail the actual request. updateMany
  // (not update) so a synthetic gateway principal with no matching User row is a silent
  // no-op instead of a thrown "record not found".
  prisma.user.updateMany({ where: { id: userId }, data: { lastActiveAt: new Date() } })
    .catch(err => console.error('activity-tracker: failed to update lastActiveAt', err));
};
