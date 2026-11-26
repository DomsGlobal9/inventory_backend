import { prisma } from '../../lib/prisma';
import { pictureOf, type By, type Module } from './index';

/**
 * Telling the modules (26 Nov 2026): every row of module_connects is "tell this module this client's picture" (or
 * that it is off), sent until the module answers. The picture is built when sent, so it is always the newest.
 *   answered 2xx                         DONE (the answer kept for the checklist)
 *   away: no answer, 5xx, 401/403/429    RETRYING, waiting 5 s, 10 s, 20 s ... up to 30 min, for ever
 *   refused (any other 4xx)              REFUSED with the module's own words; sent again on the next change or "Try again"
 * Modules ignore an older version, so a late retry can never undo a newer change.
 */
const MAX_WAIT_MS = 30 * 60_000;
const LEASE_MS = 2 * 60_000;
export const waitAfter = (attempts: number) => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), MAX_WAIT_MS);

type Hint = { by?: By; source?: string; changed?: { on: Module[]; off: Module[] } };
const hints = new Map<string, Hint>();

class Away extends Error {}
class Refused extends Error { constructor(public status: number, message: string) { super(message); } }

/** Send one module the picture. Throws Away (try later) or Refused (the module said no, in its words). */
async function send(clientId: string, module: string, action: string, hint: Hint) {
  const picture = await pictureOf(clientId, hint);
  const by = hint.by ?? null;
  if (module === 'crm') {
    const { callCrm, CrmUnavailable, CrmRefused } = await import('../crm-identity/client');
    try {
      return await callCrm<any>(action === 'connect' ? 'PUT' : 'DELETE', '/platform/client', clientId, picture, { scope: ['crm:platform'], timeoutMs: 30_000, ...(by ? { onBehalfOf: { userId: by.userId, name: by.name ?? null } } : {}) });
    } catch (e: any) {
      if (e instanceof CrmUnavailable) throw new Away(e.why);
      if (e instanceof CrmRefused) throw new Refused(e.status, e.message);
      throw new Away(String(e?.message ?? e));
    }
  }
  if (module === 'pos') {
    const pos = await import('../pos-switch');
    try {
      const posBy = by ? { userId: by.userId, name: by.name ?? null } : { userId: 'scaleezy-modules', name: 'ScaleEzy (modules)' };
      return action === 'connect' ? await pos.connect(clientId, picture, posBy) : await pos.disconnect(clientId, picture, posBy);
    } catch (e: any) {
      if (e instanceof pos.PosSwitchError && e.statusCode >= 500) throw new Away(e.message);
      if (e instanceof pos.PosSwitchError) throw new Refused(e.statusCode, e.message);
      throw new Away(String(e?.message ?? e));
    }
  }
  throw new Refused(400, `Nothing to tell for "${module}".`);
}

let running = false;
/** One pass: every row that is due (optionally only one client's). */
export async function runOnce(opts: { onlyClient?: string } = {}) {
  if (running) return { sent: 0 };
  running = true;
  let sent = 0;
  try {
    const due = await prisma.moduleConnect.findMany({
      where: {
        status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: new Date() },
        OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - LEASE_MS) } }],
        ...(opts.onlyClient ? { clientId: opts.onlyClient } : {})
      },
      orderBy: { nextAttemptAt: 'asc' }, take: 25
    });
    for (const row of due) {
      // Claimed: a second server (or pass) leaves it alone.
      const claim = await prisma.moduleConnect.updateMany({ where: { clientId: row.clientId, module: row.module, version: row.version, status: row.status, lockedAt: row.lockedAt }, data: { lockedAt: new Date() } });
      if (!claim.count) continue;
      const hint = hints.get(row.clientId) ?? {};
      const attempts = row.attempts + 1;
      // Written only if the row is still the version we sent (a newer change made meanwhile is sent next).
      const finish = (data: Record<string, unknown>) => prisma.moduleConnect.updateMany({ where: { clientId: row.clientId, module: row.module, version: row.version }, data: { ...data, attempts, lockedAt: null } as any });
      try {
        const answer = await send(row.clientId, row.module, row.action, hint);
        await finish({ status: 'DONE', doneAt: new Date(), lastError: null, answer: (answer ?? {}) as any });
        sent++;
      } catch (e: any) {
        if (e instanceof Refused) await finish({ status: 'REFUSED', lastError: String(e.message).slice(0, 500) });
        else await finish({ status: 'RETRYING', lastError: String(e?.message ?? e).slice(0, 500), nextAttemptAt: new Date(Date.now() + waitAfter(attempts)) });
      }
    }
  } finally { running = false; }
  return { sent };
}

/** Send now for this client (after a change), not on the next timer tick. */
export function kick(clientId: string, hint: Hint = {}) {
  hints.set(clientId, hint);
  setTimeout(() => { void runOnce({ onlyClient: clientId }).catch(e => console.error('[modules] could not tell the modules:', e?.message ?? e)); }, 50);
}

/** "Try again" on the Console: a refused or waiting module is asked again now. */
export async function retry(clientId: string, module: string) {
  const r = await prisma.moduleConnect.updateMany({ where: { clientId, module, status: { in: ['REFUSED', 'RETRYING'] } }, data: { status: 'PENDING', nextAttemptAt: new Date(), lockedAt: null } });
  if (r.count) kick(clientId, hints.get(clientId) ?? {});
  return r.count > 0;
}

let timer: NodeJS.Timeout | null = null;
/** Background jobs only: every 10 seconds, whatever is due. */
export function startModuleConnects() {
  if (timer) return;
  timer = setInterval(() => { void runOnce().catch(e => console.error('[modules] pass failed:', e?.message ?? e)); }, 10_000);
  timer.unref?.();
}
export function stopModuleConnects() { if (timer) clearInterval(timer); timer = null; }

/**
 * For a door that answers at once (the Boutique app's POS switch): tell the module now and wait for its answer, up to
 * waitMs. DONE gives the module's answer; REFUSED its words; still waiting means it was away (it keeps being told).
 */
export async function tellAndWait(clientId: string, module: string, hint: Hint = {}, waitMs = 45_000) {
  hints.set(clientId, hint);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await runOnce({ onlyClient: clientId });
    const row = await prisma.moduleConnect.findUnique({ where: { clientId_module: { clientId, module } } });
    if (!row) return { status: 'NONE' as const };
    if (row.status === 'DONE') return { status: 'DONE' as const, answer: row.answer as any };
    if (row.status === 'REFUSED') return { status: 'REFUSED' as const, why: row.lastError ?? 'refused' };
    if (row.status === 'RETRYING') return { status: 'RETRYING' as const, why: row.lastError ?? 'away' };
    await new Promise(r => setTimeout(r, 300));
  }
  return { status: 'RETRYING' as const, why: 'still working' };
}
