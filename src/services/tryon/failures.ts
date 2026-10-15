import { prisma } from '../../lib/prisma';

/**
 * Try-on failures, kept with the REAL reason.
 *
 * A shop or shopper only ever sees a friendly sentence (safeMessage). That is right for them and
 * useless for us: when the far end hit its monthly spending cap on 15 Oct, every shop saw "the
 * photo studio could not be reached" and the real 429 lived only in server logs that roll away.
 * This keeps the far end's own words next to what was shown, for Platform Console → Errors → Try-on.
 */

export type TryOnFailureService = 'CATALOG_TRYON' | 'SHOPPER_TRYON';
export type TryOnFailurePlace = 'PHOTO_JOB' | 'CATALOG_STREAM' | 'SHOP_PAGE' | 'COUNTER' | 'STOREFRONT';

const KEEP_DAYS = 90;
const MAX_ERROR = 4000;

export interface TryOnFailureInput {
  clientId: string;
  service: TryOnFailureService;
  place: TryOnFailurePlace;
  error: unknown;
  httpStatus?: number | null;
  code?: string | null;
  shownMessage?: string | null;
  productId?: string | null;
  jobId?: string | null;
  attempt?: number | null;
}

const words = (e: unknown) => {
  if (e == null) return 'No reason was given.';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name;
  try { return JSON.stringify(e); } catch { return String(e); }
};

/**
 * Writes one failure down. Never throws and is never awaited by callers that matter: the record
 * of a failure must not be able to become a second failure.
 */
export function recordTryOnFailure(f: TryOnFailureInput): void {
  void prisma.tryOnFailure.create({
    data: {
      clientId: f.clientId, service: f.service, place: f.place,
      error: words(f.error).slice(0, MAX_ERROR),
      httpStatus: f.httpStatus ?? null, code: f.code ?? null,
      shownMessage: f.shownMessage?.slice(0, 1000) ?? null,
      productId: f.productId ?? null, jobId: f.jobId ?? null, attempt: f.attempt ?? null
    }
  }).then(() => {
    // shortcut: trims old rows on roughly 1 write in 100 instead of a job; move to a daily job if writes get heavy.
    if (Math.random() < 0.01) {
      return prisma.tryOnFailure.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } });
    }
  }).catch(err => console.error('[tryon-failures] could not record a failure:', err?.message));
}

/** A short reason to group by: the status and the first words, without ids, numbers or quotes. */
export function reasonOf(f: { httpStatus: number | null; code: string | null; error: string }) {
  const head = f.error.replace(/["'`{}[\]]/g, ' ').replace(/\b[0-9a-f-]{8,}\b/gi, '…').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const short = head.length > 80 ? `${head.slice(0, 80).replace(/\s+\S*$/, '')}…` : head;
  return [f.httpStatus, f.code, short].filter(Boolean).join(' · ');
}

export async function listTryOnFailures(opts: { service?: string; clientId?: string; days?: number; limit?: number } = {}, now = new Date()) {
  const days = Math.min(Math.max(Number(opts.days) || 7, 1), KEEP_DAYS);
  const since = new Date(now.getTime() - days * 86_400_000);
  const where = {
    createdAt: { gte: since },
    ...(opts.service ? { service: opts.service } : {}),
    ...(opts.clientId ? { clientId: opts.clientId } : {})
  };
  const hourAgo = new Date(now.getTime() - 3_600_000), dayAgo = new Date(now.getTime() - 86_400_000);
  const [rows, lastDay, lastHour] = await Promise.all([
    prisma.tryOnFailure.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(Number(opts.limit) || 200, 500) }),
    prisma.tryOnFailure.findMany({ where: { createdAt: { gte: dayAgo } }, select: { service: true, clientId: true, httpStatus: true, code: true, error: true } }),
    prisma.tryOnFailure.findMany({ where: { createdAt: { gte: hourAgo } }, select: { clientId: true, httpStatus: true, code: true, error: true } })
  ]);

  const count = (list: { httpStatus: number | null; code: string | null; error: string }[]) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(reasonOf(r), (m.get(reasonOf(r)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, n]) => ({ reason, count: n }));
  };
  const shopsLastHour = new Set(lastHour.map(r => r.clientId)).size;
  return {
    rows,
    lastDay: {
      total: lastDay.length,
      byService: { CATALOG_TRYON: lastDay.filter(r => r.service === 'CATALOG_TRYON').length, SHOPPER_TRYON: lastDay.filter(r => r.service === 'SHOPPER_TRYON').length },
      topReasons: count(lastDay)
    },
    // Many failures in one hour is almost always the far end (a cap, an outage), not a shop's photo.
    outage: lastHour.length >= 5
      ? { failures: lastHour.length, shops: shopsLastHour, topReason: count(lastHour)[0]?.reason ?? null }
      : null
  };
}
