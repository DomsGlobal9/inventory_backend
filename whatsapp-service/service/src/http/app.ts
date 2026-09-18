import express, { json, type Express } from 'express';
import type { Ctx } from '../context';
import { safeEqual } from '../lib/crypto';
import { Errors } from '../lib/errors';
import { handleEngineEvent, type EnginePayload } from '../events/engine-events';
import { adminRoutes } from './routes-admin';
import { errorHandler, route } from './errors';
import { v1Routes } from './routes-v1';

export function createApp(ctx: Ctx): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get(
    '/ready',
    route(async (_req, res) => {
      const [db, engine] = await Promise.all([dbReady(ctx), ctx.engine.ping()]);
      res.status(db && engine ? 200 : 503).json({ status: db && engine ? 'ready' : 'not_ready', db, engine });
    }),
  );

  // Evolution's webhook. The secret in the path is the only credential the engine can send, so it
  // is compared in constant time and a wrong one gets a plain 401 (which the engine does not retry).
  app.post(
    '/engine/events/:secret',
    json({ limit: '5mb' }),
    route(async (req, res) => {
      if (!safeEqual(String(req.params.secret ?? ''), ctx.config.ENGINE_WEBHOOK_SECRET)) throw Errors.unauthorized();
      await handleEngineEvent(ctx, (req.body ?? {}) as EnginePayload);
      res.json({ ok: true });
    }),
  );

  app.use('/v1', v1Routes(ctx));
  app.use('/admin', adminRoutes(ctx));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'There is nothing at this address.' } });
  });
  app.use(errorHandler(ctx.log));
  return app;
}

async function dbReady(ctx: Ctx): Promise<boolean> {
  try {
    await Promise.race([
      ctx.db.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 3000).unref()),
    ]);
    return true;
  } catch {
    return false;
  }
}
