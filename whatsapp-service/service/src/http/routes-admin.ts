import { Router, json } from 'express';
import type { Prisma } from '@prisma/client';
import type { Ctx } from '../context';
import { requireAdmin } from '../auth/middleware';
import { reconnectAccount } from '../accounts/service';
import { startCanary } from '../health/canary';
import { runHealthWatch } from '../health/watch';
import { EngineError } from '../engine/client';
import { Errors } from '../lib/errors';
import { maskPhone } from '../lib/phone';
import { route } from './errors';
import { adminMessagesQuery } from './schemas';

// For the platform console. Never returns message text, documents or full numbers.
export function adminRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(json({ limit: '100kb' }));
  r.use(requireAdmin(ctx));

  r.get(
    '/accounts',
    route(async (_req, res) => {
      const accounts = await ctx.db.account.findMany({ orderBy: { createdAt: 'asc' } });
      const queued = await ctx.db.message.groupBy({ by: ['accountId'], where: { status: 'QUEUED' }, _count: { _all: true } });
      const q = new Map(queued.map((g) => [g.accountId, g._count._all]));
      res.json(
        accounts.map((a) => ({
          id: a.id,
          kind: a.kind,
          clientId: a.clientId,
          instanceName: a.instanceName,
          displayName: a.displayName,
          phone: maskPhone(a.phone),
          status: a.status,
          linkedAt: a.linkedAt,
          lastSeenAt: a.lastSeenAt,
          statusChangedAt: a.statusChangedAt,
          dailyCap: a.dailyCap,
          queued: q.get(a.id) ?? 0,
        })),
      );
    }),
  );

  /** Live check used by the post-deploy smoke test: does every CONNECTED number really answer? */
  r.get(
    '/accounts/verify',
    route(async (_req, res) => {
      const accounts = await ctx.db.account.findMany({ orderBy: { createdAt: 'asc' } });
      const out = [];
      for (const a of accounts) {
        let engineState: string | null = null;
        try {
          engineState = (await ctx.engine.connectionInfo(a.instanceName))?.state ?? null;
        } catch (e) {
          if (e instanceof EngineError) throw Errors.engineUnavailable();
          throw e;
        }
        out.push({ id: a.id, kind: a.kind, status: a.status, engineState, ok: a.status !== 'CONNECTED' || engineState === 'open' });
      }
      res.json({ ok: out.every((a) => a.ok), accounts: out });
    }),
  );

  r.post(
    '/accounts/:id/reconnect',
    route(async (req, res) => {
      res.json(await reconnectAccount(ctx, String(req.params.id)));
    }),
  );

  r.get(
    '/messages',
    route(async (req, res) => {
      const q = adminMessagesQuery.parse(req.query);
      const where: Prisma.MessageWhereInput = {};
      if (q.status) where.status = q.status;
      if (q.since) where.queuedAt = { gte: new Date(q.since) };
      const rows = await ctx.db.message.findMany({
        where,
        orderBy: { queuedAt: 'desc' },
        take: q.limit ?? 100,
        select: {
          id: true,
          accountId: true,
          toDigits: true,
          kind: true,
          reference: true,
          status: true,
          failReason: true,
          tries: true,
          queuedAt: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          failedAt: true,
          fileName: true,
          module: { select: { name: true } },
        },
      });
      res.json(rows.map(({ toDigits, module, ...m }) => ({ ...m, to: maskPhone(toDigits), module: module?.name ?? null })));
    }),
  );

  r.get(
    '/canary',
    route(async (_req, res) => {
      const runs = await ctx.db.canaryRun.findMany({ orderBy: { at: 'desc' }, take: 30 });
      res.json({ enabled: ctx.config.CANARY_ENABLED, runs });
    }),
  );

  /** Runs the canary now (the daily one runs by itself when CANARY_ENABLED=true). */
  r.post(
    '/canary/run',
    route(async (_req, res) => {
      res.status(202).json(await startCanary(ctx));
    }),
  );

  r.post(
    '/health-watch/run',
    route(async (_req, res) => {
      res.json(await runHealthWatch(ctx, { confirmDelayMs: 5000 }));
    }),
  );

  return r;
}
