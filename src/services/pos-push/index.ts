/**
 * Inventory -> POS till, at once (12 Nov 2026, PLAN-live.md step 3).
 *
 * The till used to learn of a new price, a new saree or a sold-out piece only on its next pull. Now, for every
 * shop with a till connected, Inventory sends the POS service two kinds of event through the module outbox
 * (signed, in order, retried; services/module-outbox) as receiver `pos`:
 *
 *   catalogue.changed  {topics: ['products'|'stock'|'offers'|'settings', ...], from, to}
 *                      "something the till's catalogue shows changed between from and to: pull what changed"
 *                      (GET /pos/v1/catalogue?since=). No product data travels here: the pull, with the till's
 *                      own key and stores, stays the one way the till learns the catalogue.
 *   customer.erased    {phone, erasedAt}: the same as GET /pos/v1/erasures, at once.
 *
 * Changes are heard from the live line (services/live), gathered for GATHER_MS per shop, and written as ONE event.
 * While an earlier catalogue.changed of that shop is still waiting (not yet sent, or POS is down and it is being
 * retried) no second one is written: the till pulls everything since its own last sync anyway, so one is enough.
 * The pull stays the safety net: a push that never arrives is caught on the till's next pull.
 *
 * Off unless POS_EVENTS_URL and POS_EVENTS_SECRET are set (both Render services share the secret).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { POS_ONLY } from '../../utils/posConnection';
import { destinationFor, ModuleOutboxDispatcher } from '../module-outbox';
import { watchAll, type AnyTopic } from '../live';

export const POS_MODULE = 'pos';
export const CATALOGUE_KIND = 'catalogue.changed';
export const ERASED_KIND = 'customer.erased';
/** The topics a till's catalogue shows. */
export const TILL_TOPICS = ['products', 'stock', 'offers', 'settings'] as const;
/** A bill moving 50 lines, a bulk price change: one event per shop per this long. */
export const GATHER_MS = 1500;

/** A till that may still sell: connected and not switched off or disconnected. */
const LIVE_TILL = { ...POS_ONLY, status: { in: ['ACTIVE', 'PENDING_SYNC'] } } as const;

export async function shopHasTill(clientId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  return (await tx.storefrontConnection.count({ where: { clientId, ...LIVE_TILL } as any })) > 0;
}

/**
 * Write one catalogue.changed for the shop, unless one is already waiting or the shop has no till.
 * Returns whether an event was written.
 */
export async function queueCatalogueChanged(clientId: string, topics: string[], from: Date, to = new Date()) {
  if (!(await shopHasTill(clientId))) return false;
  const waiting = await prisma.moduleEvent.count({
    where: { module: POS_MODULE, clientId, kind: CATALOGUE_KIND, status: { in: ['PENDING', 'RETRYING'] } }
  });
  if (waiting) return false;
  await prisma.moduleEvent.create({
    data: {
      clientId, module: POS_MODULE, kind: CATALOGUE_KIND, sourceTable: 'live', rowId: clientId,
      payload: { topics: [...new Set(topics)].sort(), from: from.toISOString(), to: to.toISOString() }
    }
  });
  return true;
}

/**
 * customer.erased for each phone, in the SAME transaction as the erasure (services/customer-erasures), so an
 * erasure is never told to the till without happening, nor happens without being told.
 */
export async function queueErasures(tx: Prisma.TransactionClient, clientId: string, phones: string[], erasedAt = new Date()) {
  // No POS address on this server: nothing would ever send them; the till's GET /erasures still answers.
  if (!phones.length || !destinationFor(POS_MODULE) || !(await shopHasTill(clientId, tx))) return 0;
  const r = await tx.moduleEvent.createMany({
    data: phones.map(phone => ({
      clientId, module: POS_MODULE, kind: ERASED_KIND, sourceTable: 'customer_erasures', rowId: phone,
      payload: { phone, erasedAt: erasedAt.toISOString() }
    }))
  });
  return r.count;
}

/** Send this shop's waiting events now rather than on the next 5-second pass (safe beside it: rows are claimed). */
async function sendNow(clientId: string) {
  await ModuleOutboxDispatcher.runOnce({ onlyClients: [clientId] });
}

let stopWatching: (() => void) | null = null;
const gathering = new Map<string, { topics: Set<string>; from: Date; timer: NodeJS.Timeout }>();

async function flush(clientId: string) {
  const g = gathering.get(clientId);
  gathering.delete(clientId);
  if (!g) return;
  try {
    if (clientId === '*') {
      // The live line was down: anything may have changed. Every shop with a till pulls once.
      const shops = await prisma.storefrontConnection.findMany({ where: LIVE_TILL as any, select: { clientId: true }, distinct: ['clientId'] });
      for (const s of shops) if (await queueCatalogueChanged(s.clientId, [...TILL_TOPICS], g.from)) await sendNow(s.clientId);
      return;
    }
    if (await queueCatalogueChanged(clientId, [...g.topics], g.from)) await sendNow(clientId);
  } catch (err) {
    console.error('[pos-push] could not queue catalogue.changed; the till catches it on its next pull.', err);
  }
}

function heard(clientId: string, topic: AnyTopic) {
  if (topic === 'erasures') {
    // Already written with the erasure; just send it now.
    void sendNow(clientId).catch(() => undefined);
    return;
  }
  if (!(TILL_TOPICS as readonly string[]).includes(topic)) return;
  const g = gathering.get(clientId);
  if (g) { g.topics.add(topic); return; }
  gathering.set(clientId, { topics: new Set([topic]), from: new Date(), timer: setTimeout(() => { void flush(clientId); }, GATHER_MS) });
}

/** Start telling tills (once per process). Needs the live line (services/live) started too. */
export function startPosPush() {
  if (stopWatching) return true;
  if (!destinationFor(POS_MODULE)) return false;
  stopWatching = watchAll(heard);
  return true;
}

export function stopPosPush() {
  stopWatching?.();
  stopWatching = null;
  for (const g of gathering.values()) clearTimeout(g.timer);
  gathering.clear();
}
