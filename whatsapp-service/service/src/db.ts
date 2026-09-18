import { PrismaClient } from '@prisma/client';

/**
 * Time limits on every database call. Without them a connection that died silently (network
 * cut, database failover) can leave a query waiting forever, and the sender with it.
 */
export function withTimeouts(url: string): string {
  const u = new URL(url);
  const defaults: Record<string, string> = { connect_timeout: '10', pool_timeout: '15', socket_timeout: '30' };
  for (const [k, v] of Object.entries(defaults)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: withTimeouts(url) } },
    // Prisma's own query logging could print message text; errors are handled by our code.
    log: [],
  });
}

export type Db = PrismaClient;
