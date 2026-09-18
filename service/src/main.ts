import type { Server } from 'node:http';
import { ConfigError, loadConfig } from './config';
import { createPrisma } from './db';
import { EvolutionEngine } from './engine/client';
import { createApp } from './http/app';
import { log } from './lib/logger';
import { ensureScaleezyAccount } from './accounts/service';
import { Runner } from './worker/runner';
import type { Ctx } from './context';
import { loadDotEnv } from './lib/dotenv';

async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      // Printed plainly so it reads well in Render's log.
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  log.level = config.LOG_LEVEL;

  const db = createPrisma(config.DATABASE_URL);
  const engine = new EvolutionEngine({ baseUrl: config.ENGINE_URL, apiKey: config.ENGINE_API_KEY });
  const ctx: Ctx = { db, engine, config, log };

  const app = createApp(ctx);
  const server: Server = app.listen(config.PORT, () => log.info({ port: config.PORT }, 'WhatsApp service listening'));
  server.keepAliveTimeout = 65_000;

  // The database may be briefly unreachable at boot (deploys start services together). Keep
  // trying instead of crashing; /ready says not ready until then.
  let runner: Runner | null = null;
  let shuttingDown = false;
  void (async () => {
    for (let attempt = 1; !shuttingDown; attempt++) {
      try {
        await ensureScaleezyAccount(ctx);
        break;
      } catch (e) {
        log.error({ err: e, attempt }, 'cannot reach the database yet; retrying');
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * attempt)));
      }
    }
    if (shuttingDown) return;
    if (config.WORKER_ENABLED) {
      runner = new Runner(ctx);
      runner.start();
    }
  })();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down: no new work, finishing the send in progress');
    const force = setTimeout(() => {
      log.error('shutdown took too long; exiting');
      process.exit(1);
    }, 55_000);
    force.unref();
    server.close();
    try {
      if (runner) await runner.stop();
      await db.$disconnect();
    } catch (e) {
      log.error({ err: e }, 'error during shutdown');
    }
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A forgotten promise must never take the service down silently; it is logged and work goes on.
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled promise rejection (kept running)');
  });
  // After an uncaught exception the process state is unknown: stop cleanly and let the platform restart it.
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception; restarting');
    void shutdown('uncaughtException').finally(() => process.exit(1));
  });
}

void main();
