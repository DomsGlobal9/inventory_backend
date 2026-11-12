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
export const TOPICS = ['orders', 'returns', 'customers', 'vouchers', 'stock', 'shelves', 'products', 'alerts', 'purchases', 'counts', 'offers', 'settings'] as const;
export type Topic = typeof TOPICS[number];
/** Heard by the server only, never sent to screens (services/pos-push). */
export const SERVER_TOPICS = ['erasures'] as const;
export type AnyTopic = Topic | typeof SERVER_TOPICS[number];
const isScreenTopic = (t: unknown): t is Topic => (TOPICS as readonly unknown[]).includes(t);
const isServerTopic = (t: unknown): t is AnyTopic => isScreenTopic(t) || (SERVER_TOPICS as readonly unknown[]).includes(t);

/** Changes heard within this long are sent to a screen together: a burst of writes is one reload. */
export const BATCH_MS = 300;
/** Per shop: more open screens than this is not a shop, it is a leak. */
export const MAX_PER_SHOP = 200;

type Listener = (topics: Topic[]) => void;
const byShop = new Map<string, Set<Listener>>();
/** Server-side listeners: every shop, every topic, as heard (services/pos-push). */
const watchers = new Set<(clientId: string, topic: AnyTopic) => void>();
function tellWatchers(clientId: string, topic: AnyTopic) {
  for (const w of watchers) { try { w(clientId, topic); } catch { /* one watcher never stops the others */ } }
}
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
  tellWatchers('*', 'products');
}

/**
 * Hear every change signal of every shop on this server, e.g. to tell the till. `clientId` is '*' after the line
 * to the database was down: something may have changed in any shop. Returns the way to stop.
 */
export function watchAll(fn: (clientId: string, topic: AnyTopic) => void) {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

/**
 * Proof the line really hears (idea from the CRM chat, 12 Nov): a transaction pooler accepts LISTEN and then
 * delivers nothing, and a connection can go quietly deaf. So a test signal is sent the way real changes travel
 * (the app's normal database connection) and the line counts as listening only once it comes back -- at the start
 * and every PROBE_EVERY_MS after. Not heard within PROBE_WAIT_MS: the line is re-made, and meanwhile screens are
 * told listening:false, so they refresh every minute instead of waiting for news that never comes.
 */
export const PROBE_EVERY_MS = 5 * 60_000;
export const PROBE_WAIT_MS = 10_000;
const PROBE_SHOP = '__probe__';
let warnedDeaf = false;

async function sendProbe(token: string) {
  const { prisma } = await import('../../lib/prisma');
  await prisma.$executeRaw`SELECT pg_notify(${LIVE_CHANNEL}, ${JSON.stringify({ c: PROBE_SHOP, t: token })})`;
}

async function connect() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) return;
  const c = new Client({ connectionString: url, keepAlive: true });
  let waitingFor: { token: string; heard: () => void } | null = null;
  let probeTimer: NodeJS.Timeout | null = null;
  c.on('notification', msg => {
    if (msg.channel !== LIVE_CHANNEL || !msg.payload) return;
    try {
      const { c: shop, t } = JSON.parse(msg.payload);
      if (shop === PROBE_SHOP) { if (waitingFor && t === waitingFor.token) waitingFor.heard(); return; }
      if (typeof shop !== 'string') return;
      if (isScreenTopic(t)) deliver(shop, [t]);
      if (isServerTopic(t)) tellWatchers(shop, t);
    } catch { /* not ours */ }
  });
  const lost = (why: string) => {
    if (client !== c) return;
    client = null;
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    waitingFor = null;
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
  /** Resolves true when this line hears a test signal sent the normal way within PROBE_WAIT_MS. */
  const probe = () => new Promise<boolean>(resolve => {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => { waitingFor = null; resolve(false); }, PROBE_WAIT_MS);
    waitingFor = { token, heard: () => { clearTimeout(timer); waitingFor = null; resolve(true); } };
    sendProbe(token).catch(() => { clearTimeout(timer); waitingFor = null; resolve(false); });
  });
  client = c;
  try {
    await c.connect();
    await c.query(`LISTEN ${LIVE_CHANNEL}`);
    if (!(await probe())) {
      if (!warnedDeaf) {
        warnedDeaf = true;
        console.warn('[live] LISTEN accepted but a test signal never came back (a transaction pooler as DIRECT_URL?); screens refresh every minute until it does.');
      }
      return lost('test signal not heard');
    }
    if (client !== c) return; // dropped while proving
    const wasDown = retryMs > 1000;
    connected = true;
    retryMs = 1000;
    if (wasDown) everyoneEverything();
    probeTimer = setInterval(() => {
      void probe().then(ok => { if (!ok) lost('went quiet: test signal not heard'); });
    }, PROBE_EVERY_MS);
    probeTimer.unref?.();
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
