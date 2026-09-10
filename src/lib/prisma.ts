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
 * Raising this is safe while pgbouncer sits in front in transaction mode: these are
 * connections to the pooler, not to Postgres itself, and the pooler multiplexes them onto a
 * much smaller number of real backends. On a DIRECT connection this number has to come down,
 * which DIRECT_CONNECTION_LIMIT below does.
 *
 * On the region: that was the conclusion drawn from a round trip "about a second", and it was
 * measured through the pooler. Measured again against both endpoints, interleaved, twenty
 * samples each:
 *
 *     SELECT 1   pooled (6543)   p50 1514ms   p95 1838ms   min 1431ms
 *                direct (5432)   p50  311ms   p95  618ms   min  286ms
 *
 * and the same gap on a real table read (1533ms against 317ms). 311ms is what India to
 * ap-southeast-2 costs; the other 1203ms is the pooler, on every single query, and its minimum
 * never drops -- a fixed tax, not jitter. So the region is real but second: the pooler is
 * costing four times what the ocean does, and switching it off costs nothing.
 */
const CONNECTION_LIMIT = 25;

/**
 * The same, for a direct connection.
 *
 * Without pgbouncer multiplexing, every one of these is a real Postgres backend out of the
 * sixty this database allows -- twenty-five in use here was measured alongside the fourteen
 * this user already held. Ten leaves room for migrations, the Supabase dashboard, and a second
 * instance during a deploy.
 *
 * Direct is right for a long-running server like this one, which holds its connections and
 * reuses them. It is the wrong answer for serverless, where every invocation opens its own and
 * the pooler is what stops the database running out.
 */
const DIRECT_CONNECTION_LIMIT = 10;

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
  // Opt in with DB_USE_DIRECT=true. Deliberately off by default: which endpoint a deployment
  // should talk to depends on how it is run -- a long-running server wants the direct one, a
  // serverless deployment needs the pooler -- and that is not something to change under an
  // operator without them choosing it. See the measurement above for what it is worth.
  const useDirect = process.env.DB_USE_DIRECT === 'true' && !!process.env.DIRECT_URL;
  const raw = useDirect ? process.env.DIRECT_URL : process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);

    // pgbouncer=true tells Prisma to stop using prepared statements, which is required through
    // a transaction-mode pooler and pure loss without one. Carried over from DATABASE_URL it
    // would quietly make the direct connection slower than it needs to be.
    if (useDirect) url.searchParams.delete('pgbouncer');

    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set(
        'connection_limit',
        String(useDirect ? DIRECT_CONNECTION_LIMIT : CONNECTION_LIMIT)
      );
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
