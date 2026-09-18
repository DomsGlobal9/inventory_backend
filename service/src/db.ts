import { PrismaClient } from '@prisma/client';

export function createPrisma(url?: string): PrismaClient {
  return new PrismaClient({
    datasources: url ? { db: { url } } : undefined,
    // Prisma's own query logging could print message text; errors are handled by our code.
    log: [],
  });
}

export type Db = PrismaClient;
