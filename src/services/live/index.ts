/**
 * Instant updates (12 Nov 2026, PLAN-live.md).
 *
 * The database says "shop X: <topic> changed" on the channel inventory_live (migration 20261112180000_live_notify)
 * whatever made the change -- a person, the POS till, CRM, Shopify, a background job. One listening connection per
 * server passes it to that shop's open screens (GET /api/v1/live), which reload what they show through the usual
 * routes with the usual permissions. Only a shop id and a topic word ever travel here.
 *
 * LISTEN needs a session connection: the direct address (DIRECT_URL), never the transaction pooler. A dropped
 * connection is re-made with a growing pause, and screens are told "everything" once it is back, because changes
 * made while it was down were not heard.
 */
import { Client } from 'pg';

export const LIVE_CHANNEL = 'inventory_live';
export const TOPICS = ['orders', 'returns', 'customers', 'vouchers', 'stock', 'shelves', 'products', 'alerts', 'purchases', 'counts', 'offers'] as const;
export type Topic = typeof TOPICS[number];

/** Changes heard within this long are sent to a screen together: a burst of writes is one reload. */
export const BATCH_MS = 300;
/** Per shop: more open screens than this is not a shop, it is a leak. */
export const MAX_PER_SHOP = 200;

type Listener = (topics: Topic[]) => void;
const byShop = new Map<string, Set<Listener>>();
let client: Client | null = null;
let started = false;
let connected = false;
let retryMs = 1000;
let stopped = false;

function deliver(clientId: string, topics: Topic[]) {
  for (const l of byShop.get(clientId) ?? []) {
    try { l(topics); } catch { /* one screen's broken line never stops the others */ }
  }
}

/** Tell every open screen of every shop to reload everything (after the line to the database was down). */
function everyoneEverything() {
  for (const clientId of byShop.keys()) deliver(clientId, [...TOPICS]);
}

async function connect() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) return;
  const c = new Client({ connectionString: url, keepAlive: true });
  c.on('notification', msg => {
    if (msg.channel !== LIVE_CHANNEL || !msg.payload) return;
    try {
      const { c: shop, t } = JSON.parse(msg.payload);
      if (typeof shop === 'string' && (TOPICS as readonly string[]).includes(t)) deliver(shop, [t]);
    } catch { /* not ours */ }
  });
  const lost = (why: string) => {
    if (client !== c) return;
    client = null;
    const wasConnected = connected;
    connected = false;
    c.removeAllListeners();
    c.end().catch(() => undefined);
    if (stopped) return;
    if (wasConnected) console.warn(`[live] database line lost (${why}); retrying in ${retryMs} ms`);
    setTimeout(() => { void connect(); }, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  };
  c.on('error', err => lost(err.message));
  c.on('end', () => lost('ended'));
  client = c;
  try {
    await c.connect();
    await c.query(`LISTEN ${LIVE_CHANNEL}`);
    const wasDown = retryMs > 1000;
    connected = true;
    retryMs = 1000;
    if (wasDown) everyoneEverything();
  } catch (err: any) {
    lost(err?.message ?? 'could not connect');
  }
}

/** Start listening (once per process). Off with LIVE_UPDATES=off. */
export function startLive() {
  if (started || process.env.LIVE_UPDATES === 'off') return;
  started = true;
  void connect();
}

export function stopLive() {
  stopped = true;
  const c = client;
  client = null;
  connected = false;
  if (c) { c.removeAllListeners(); void c.end().catch(() => undefined); }
}

export function liveStatus() {
  return { listening: connected, shops: byShop.size, screens: [...byShop.values()].reduce((n, s) => n + s.size, 0) };
}

/**
 * One open screen of `clientId`. `send` gets the topics that changed, at most every BATCH_MS. Returns the way to
 * stop, or null when the shop already has MAX_PER_SHOP screens open.
 */
export function subscribe(clientId: string, send: (topics: Topic[]) => void): (() => void) | null {
  const set = byShop.get(clientId) ?? new Set<Listener>();
  if (set.size >= MAX_PER_SHOP) return null;
  const pending = new Set<Topic>();
  let timer: NodeJS.Timeout | null = null;
  const listener: Listener = topics => {
    topics.forEach(t => pending.add(t));
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const out = [...pending];
      pending.clear();
      if (out.length) send(out);
    }, BATCH_MS);
  };
  set.add(listener);
  byShop.set(clientId, set);
  return () => {
    if (timer) clearTimeout(timer);
    set.delete(listener);
    if (!set.size) byShop.delete(clientId);
  };
}
