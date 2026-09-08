import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/**
 * How many database connections this process may hold.
 *
 * Prisma's default is derived from the CPU count, which on a small instance is single digits.
 * That default assumes a database next door, where a connection is returned in a millisecond
 * and a handful of them serve a lot of traffic. This database is on another continent: a round
 * trip is about a second, so each connection is occupied roughly a thousand times longer, and
 * the same default supports a thousandth of the traffic.
 *
 * Measured against production before this was set -- a ramp on `/ready`, which is one
 * `SELECT 1`:
 *
 *      40 concurrent   p50 2.1s   no failures
 *     100 concurrent   p50 4.0s   no failures
 *     250 concurrent   p50 6.8s   58 of 250 FAILED
 *
 * The failures were `prisma.$queryRaw` throwing, not the platform shedding load. Meanwhile
 * `/health`, which touches nothing, stayed at 330ms with no errors at every level -- so the
 * Node process was never the constraint.
 *
 * Raising this is safe here because pgbouncer sits in front in transaction mode: these are
 * connections to the pooler, not to Postgres itself, and the pooler multiplexes them onto a
 * much smaller number of real backends. Without pgbouncer this number would have to stay small.
 *
 * It is a mitigation, not the fix. The fix is to put the application in the same region as its
 * database; until then this buys headroom rather than removing the ceiling.
 */
const CONNECTION_LIMIT = 25;

/**
 * How long a query waits for a free connection before giving up.
 *
 * Prisma's default is 10 seconds. At the concurrency above, a request that waits that long has
 * already lost the user -- and it holds a request slot the whole time, which makes the queue
 * worse for everyone behind it. Failing sooner sheds load instead of amplifying it.
 */
const POOL_TIMEOUT_SECONDS = 20;

/**
 * Applies the settings above to the connection string.
 *
 * Done here rather than by editing DATABASE_URL in the environment so that every deployment
 * gets it, including ones configured before this existed -- an environment variable someone
 * has to remember to set is a setting that will be missing somewhere.
 *
 * Anything already specified in the URL wins: an operator tuning it by hand is making a
 * deliberate choice, and this should not quietly override it.
 */
function tunedDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(CONNECTION_LIMIT));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', String(POOL_TIMEOUT_SECONDS));
    }
    return url.toString();
  } catch {
    // A connection string we cannot parse is not one to rewrite. Hand it back untouched and
    // let Prisma report the problem, rather than failing here with a URL error that says
    // nothing about the database.
    return raw;
  }
}

const prismaClientSingleton = () => {
  const url = tunedDatabaseUrl();
  return url
    ? new PrismaClient({ datasources: { db: { url } } })
    : new PrismaClient();
};

declare global {
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>;
}

export const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

if (env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma;
