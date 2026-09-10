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
 * The same, for the session-mode endpoint.
 *
 * Five, and the number matters -- ten took production down.
 *
 * This was sized against Postgres's own max_connections, about sixty, on the assumption that
 * DIRECT_URL means a direct connection to the database. It does not. It is Supabase's SESSION
 * pooler, and that has its own far smaller ceiling: pool_size 15 for the whole project. The
 * name "direct" refers to how it behaves -- one connection held for the length of the session,
 * no statement-level multiplexing -- not to what it is connected to.
 *
 * Session mode is what makes the arithmetic unforgiving. A connection is held for as long as
 * the client keeps it, so a Prisma pool of ten occupies ten of the fifteen permanently, not
 * just while a query runs. Render also overlaps instances during a deploy, so for a minute
 * there are two pools: ten plus ten against a ceiling of fifteen. Production answered
 *
 *   FATAL: (EMAXCONNSESSION) max clients reached in session mode - pool_size: 15
 *
 * and the dashboard 500'd, twelve minutes after the deploy that turned this on.
 *
 * Five leaves the sums working: five live, five more during a deploy overlap, and three spare
 * for migrations and the Supabase dashboard. One Render instance with WEB_CONCURRENCY=1 has no
 * use for ten held connections anyway -- the win from this endpoint is the round trip it saves
 * per query, not depth.
 *
 * If this ever needs raising, raise Supabase's pool size first and check it, rather than
 * inferring a ceiling from the word "direct" as this comment previously did.
 */
const DIRECT_CONNECTION_LIMIT = 5;

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

/**
 * Say which endpoint this process is talking to, once, at boot.
 *
 * Without this, setting DB_USE_DIRECT is an act of faith: the flag is read here and nothing
 * anywhere confirms it was picked up. An operator who sets it in Render and restarts has no
 * way to tell the difference between "it worked" and "the variable was misspelled, or
 * DIRECT_URL is missing, so it silently carried on using the pooler" -- and the second one
 * looks exactly like the first until somebody measures query latency and wonders why nothing
 * changed.
 *
 * Host and port only. A connection string carries the password.
 */
function announceConnection(url: string | undefined) {
  const wanted = process.env.DB_USE_DIRECT === 'true';
  if (!url) {
    console.log('[db] using DATABASE_URL as given (no tuning applied)');
    return;
  }
  try {
    const { hostname, port, searchParams } = new URL(url);
    const direct = wanted && !!process.env.DIRECT_URL;
    console.log(
      `[db] ${direct ? 'DIRECT' : 'POOLED'} ${hostname}:${port}` +
      ` (connection_limit=${searchParams.get('connection_limit')})`
    );
    // The near-miss worth naming: asked for direct, and quietly did not get it.
    if (wanted && !process.env.DIRECT_URL) {
      console.warn('[db] DB_USE_DIRECT=true but DIRECT_URL is not set -- still using the pooler.');
    }
  } catch {
    console.log('[db] connection string could not be parsed for logging');
  }
}

const prismaClientSingleton = () => {
  const url = tunedDatabaseUrl();
  announceConnection(url);
  return url
    ? new PrismaClient({ datasources: { db: { url } } })
    : new PrismaClient();
};

declare global {
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>;
}

export const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

if (env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma;
