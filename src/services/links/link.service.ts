/**
 * Short links (go.scaleezy.com/<code>). A module of its own: other code calls these functions and
 * never touches the short_links tables.
 *
 * What it knows: whose link it is (the shop), what made it (module + reference), where it goes,
 * how long it lives, and how often a person or a robot opened it. What it never knows: who the
 * person is. A module that wants per-person counts passes an opaque random token (newRecipientRef)
 * and keeps the token-to-person match itself.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { checkTarget, expiryFor, newCode, redirectTarget, stateOf, LinkRuleError, type TargetType } from './rules';
import { classifyVisitor } from './robots';
import { page, type PageKind } from './pages';

export { LinkRuleError, newRecipientRef } from './rules';
export type { TargetType } from './rules';

export const MAX_LINKS_PER_CALL = 1000;
/** Tap rows are kept this long (the same as the security log); the counts on the link stay. */
export const TAP_RETENTION_DAYS = 180;
/** A test send's link is removed this long after it expired. Real links stay for the history. */
export const TEST_LINK_RETENTION_DAYS = 30;

const MODULE_SHAPE = /^[a-z][a-z0-9-]{1,39}$/;
const REF_SHAPE = /^[A-Za-z0-9_.:-]{1,100}$/;

export interface Owner {
  /** Which part of ScaleEzy made it: 'campaigns', 'receipts', 'billing', ... */
  module: string;
  /** What it was made for, e.g. the campaign id. */
  ref?: string | null;
}

export interface NewLink {
  /** From newRecipientRef(), one per person; or leave out for one shared link. */
  recipientRef?: string | null;
  targetType: TargetType;
  target: string;
}

export interface MadeLink {
  recipientRef: string | null;
  code: string;
  shortUrl: string;
  target: string;
  expiresAt: Date;
}

/** Short links are made only once LINK_BASE_URL says where they live. */
export const available = () => Boolean(env.LINK_BASE_URL);

export function shortUrl(code: string): string {
  if (!env.LINK_BASE_URL) throw new LinkRuleError('Short links are not set up on this server yet.');
  return `${env.LINK_BASE_URL}/${code}`;
}

/** The host short links are served on in production (go.scaleezy.com), or null. */
export function linkHost(): string | null {
  if (!env.LINK_BASE_URL) return null;
  const u = new URL(env.LINK_BASE_URL);
  return u.pathname === '/' || u.pathname === '' ? u.hostname.toLowerCase() : null;
}

/** Our own addresses a link may never point at: the short-link host, the app, this API. */
function blockedHosts(): string[] {
  const hosts = new Set<string>();
  const add = (url?: string | null) => {
    if (!url) return;
    try {
      hosts.add(new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase());
    } catch {
      /* not an address */
    }
  };
  add(env.LINK_BASE_URL);
  add(env.FRONTEND_URL);
  // Render tells every service its own public name.
  add(process.env.RENDER_EXTERNAL_HOSTNAME);
  hosts.delete('localhost');
  hosts.delete('127.0.0.1');
  return [...hosts];
}

const targetContext = () => ({ blockedHosts: blockedHosts(), production: env.NODE_ENV === 'production' });

/** Checks one address without making anything: for a screen to say "fine" or why not. */
export function checkLinkTarget(target: unknown, type: TargetType): string {
  return checkTarget(target, type, targetContext());
}

function checkOwner(owner: Owner) {
  if (!owner || typeof owner.module !== 'string' || !MODULE_SHAPE.test(owner.module)) {
    throw new LinkRuleError('The link owner must be a module name like "campaigns".');
  }
  if (owner.ref != null && (typeof owner.ref !== 'string' || !REF_SHAPE.test(owner.ref))) {
    throw new LinkRuleError('The link owner reference may be up to 100 letters, digits and _ . : -');
  }
}

/**
 * Makes links, one per person, or returns the ones made before for the same people: calling it
 * again after a failure halfway makes only the missing ones, and never changes a link that may
 * already be in someone's WhatsApp. Up to 1,000 per call; a campaign calls it in batches.
 */
export async function makeLinks(input: {
  clientId: string;
  owner: Owner;
  links: NewLink[];
  days?: number | null;
  isTest?: boolean;
  createdById?: string | null;
  now?: Date;
}): Promise<MadeLink[]> {
  if (!available()) throw new LinkRuleError('Short links are not set up on this server yet.');
  const { clientId, owner, links } = input;
  if (!clientId) throw new LinkRuleError('A link belongs to a shop.');
  checkOwner(owner);
  if (!Array.isArray(links) || links.length === 0) throw new LinkRuleError('There are no links to make.');
  if (links.length > MAX_LINKS_PER_CALL) throw new LinkRuleError(`Make at most ${MAX_LINKS_PER_CALL.toLocaleString('en-IN')} links at a time.`);

  const shared = links.filter(l => !l.recipientRef);
  if (shared.length > 0 && links.length > 1) {
    throw new LinkRuleError('Links for several people each need their own recipient token.');
  }
  const refs = links.map(l => l.recipientRef ?? null);
  if (refs.some(r => r !== null && (typeof r !== 'string' || !REF_SHAPE.test(r)))) {
    throw new LinkRuleError('A recipient token may be up to 100 letters, digits and _ . : -');
  }
  if (new Set(refs).size !== refs.length) throw new LinkRuleError('The same recipient token appears twice.');
  // The database's one-link-per-person rule holds only with a reference: two empty references
  // are never "the same" to Postgres.
  if (shared.length === 0 && !owner.ref) throw new LinkRuleError('Links for people need the owner reference they belong to (e.g. the campaign).');

  const ctx = targetContext();
  const checked = links.map((l, i) => {
    try {
      return { recipientRef: l.recipientRef ?? null, targetType: l.targetType, target: checkTarget(l.target, l.targetType, ctx) };
    } catch (e) {
      if (e instanceof LinkRuleError && links.length > 1) throw new LinkRuleError(`Link ${i + 1}: ${e.message}`);
      throw e;
    }
  });
  const now = input.now ?? new Date();
  const expiresAt = expiryFor(now, input.days);
  const ownerRef = owner.ref ?? null;

  // A shared link (no recipient) is never looked up again: nothing identifies "the same" one.
  const personal = checked.filter(l => l.recipientRef !== null).map(l => l.recipientRef as string);
  const found = new Map<string, MadeLink>();
  const collect = async () => {
    if (!personal.length) return;
    const rows = await prisma.shortLink.findMany({
      where: { clientId, ownerModule: owner.module, ownerRef, recipientRef: { in: personal } },
      select: { recipientRef: true, code: true, target: true, expiresAt: true }
    });
    for (const r of rows) found.set(r.recipientRef!, { recipientRef: r.recipientRef, code: r.code, shortUrl: shortUrl(r.code), target: r.target, expiresAt: r.expiresAt });
  };
  await collect();

  const made: MadeLink[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const missing = checked.filter(l => l.recipientRef === null ? made.length === 0 : !found.has(l.recipientRef));
    if (missing.length === 0) break;
    const rows = missing.map(l => ({
      code: newCode(),
      clientId,
      ownerModule: owner.module,
      ownerRef,
      recipientRef: l.recipientRef,
      targetType: l.targetType,
      target: l.target,
      expiresAt,
      isTest: input.isTest === true,
      createdById: input.createdById ?? null
    }));
    if (missing.length === 1 && missing[0].recipientRef === null) {
      try {
        const r = await prisma.shortLink.create({ data: rows[0], select: { code: true, target: true, expiresAt: true } });
        made.push({ recipientRef: null, code: r.code, shortUrl: shortUrl(r.code), target: r.target, expiresAt: r.expiresAt });
      } catch (e) {
        // A code that already exists: draw another.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
      continue;
    }
    // skipDuplicates covers both a code clash and someone else making the same person's link at the
    // same moment; either way the row is simply missing, and the re-read below tells which.
    await prisma.shortLink.createMany({ data: rows, skipDuplicates: true });
    await collect();
  }

  const out = checked.map(l => (l.recipientRef === null ? made[0] : found.get(l.recipientRef)));
  if (out.some(x => !x)) throw new Error('Short links could not all be made; try again.');
  return out as MadeLink[];
}

// ── Opening a link ────────────────────────────────────────────────────────────────────────

export type OpenResult = { kind: 'redirect'; location: string } | { kind: 'page'; status: number; html: string };

const shopName = async (clientId: string) =>
  (await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } }))?.businessName ?? null;

/**
 * What a visit to go.scaleezy.com/<code> gets. The open is counted after the answer is decided and
 * never delays or blocks it: a counting failure costs a count, not a customer.
 */
export async function open(code: string, visit: { method: string; userAgent?: string | null }, now = new Date()): Promise<OpenResult> {
  const unavailable = (): OpenResult => ({ kind: 'page', status: 404, html: page('UNAVAILABLE') });
  if (!/^[A-Za-z0-9]{7}$/.test(code)) return unavailable();
  const link = await prisma.shortLink.findUnique({
    where: { code },
    select: { id: true, clientId: true, targetType: true, target: true, status: true, expiresAt: true }
  });
  if (!link) return unavailable();

  const state = stateOf(link, now);
  if (state === 'DISABLED_BY_PLATFORM') return unavailable();
  if (state === 'DISABLED_BY_SHOP' || state === 'EXPIRED') {
    const kind: PageKind = state === 'EXPIRED' ? 'ENDED' : 'SHOP_OFF';
    return { kind: 'page', status: 410, html: page(kind, { shopName: await shopName(link.clientId).catch(() => null), expiredAt: link.expiresAt }) };
  }

  const visitor = classifyVisitor(visit.method, visit.userAgent);
  void recordOpen(link.id, visitor, now).catch(e => console.error('[links] could not count an open:', (e as Error)?.message));
  return { kind: 'redirect', location: redirectTarget(link.target, link.targetType, code) };
}

export async function recordOpen(linkId: string, visitor: 'HUMAN' | 'BOT', at = new Date()): Promise<void> {
  const counts: Prisma.ShortLinkUpdateInput = visitor === 'HUMAN'
    ? { tapCount: { increment: 1 }, lastTapAt: at }
    : { botOpenCount: { increment: 1 } };
  await prisma.$transaction([
    prisma.shortLink.update({ where: { id: linkId }, data: counts }),
    // First tap: set once, by whichever tap gets here first.
    ...(visitor === 'HUMAN' ? [prisma.shortLink.updateMany({ where: { id: linkId, firstTapAt: null }, data: { firstTapAt: at } })] : []),
    prisma.shortLinkTap.create({ data: { linkId, visitor, at } })
  ]);
}

// ── Counts ────────────────────────────────────────────────────────────────────────────────

export interface LinkStats {
  links: number;
  /** Links a person opened at least once: with one link per customer, the customers who tapped. */
  tapped: number;
  totalTaps: number;
  robotOpens: number;
}

/** A thing's links, test sends left out. */
export async function statsFor(clientId: string, owner: Owner): Promise<LinkStats> {
  checkOwner(owner);
  const where = { clientId, ownerModule: owner.module, ownerRef: owner.ref ?? null, isTest: false };
  const [agg, tapped] = await Promise.all([
    prisma.shortLink.aggregate({ where, _count: { _all: true }, _sum: { tapCount: true, botOpenCount: true } }),
    prisma.shortLink.count({ where: { ...where, tapCount: { gt: 0 } } })
  ]);
  return { links: agg._count._all, tapped, totalTaps: agg._sum.tapCount ?? 0, robotOpens: agg._sum.botOpenCount ?? 0 };
}

/** Per person, for the module that holds the tokens. */
export async function tapsByRecipient(clientId: string, owner: Owner, recipientRefs: string[]) {
  checkOwner(owner);
  if (recipientRefs.length === 0) return new Map<string, { tapCount: number; firstTapAt: Date | null; lastTapAt: Date | null }>();
  const rows = await prisma.shortLink.findMany({
    where: { clientId, ownerModule: owner.module, ownerRef: owner.ref ?? null, recipientRef: { in: recipientRefs.slice(0, 5000) } },
    select: { recipientRef: true, tapCount: true, firstTapAt: true, lastTapAt: true }
  });
  return new Map(rows.map(r => [r.recipientRef!, { tapCount: r.tapCount, firstTapAt: r.firstTapAt, lastTapAt: r.lastTapAt }]));
}

// ── Switching off ─────────────────────────────────────────────────────────────────────────

/** The shop switches a thing's links off. A link ScaleEzy switched off stays off. */
export async function disableForOwner(clientId: string, owner: Owner, byUserId: string | null, now = new Date()) {
  checkOwner(owner);
  const r = await prisma.shortLink.updateMany({
    where: { clientId, ownerModule: owner.module, ownerRef: owner.ref ?? null, status: 'ACTIVE' },
    data: { status: 'DISABLED_BY_SHOP', disabledAt: now, disabledById: byUserId }
  });
  return { switchedOff: r.count };
}

/** The shop switches its own links back on. Never one ScaleEzy switched off. */
export async function enableForOwner(clientId: string, owner: Owner) {
  checkOwner(owner);
  const r = await prisma.shortLink.updateMany({
    where: { clientId, ownerModule: owner.module, ownerRef: owner.ref ?? null, status: 'DISABLED_BY_SHOP' },
    data: { status: 'ACTIVE', disabledAt: null, disabledById: null }
  });
  return { switchedOn: r.count };
}

/** ScaleEzy switches one link off, e.g. a reported scam. The note is for us, never the visitor. */
export async function platformDisable(code: string, adminId: string, note: string, now = new Date()) {
  if (!/^[A-Za-z0-9]{7}$/.test(code)) throw new LinkRuleError('That is not a short-link code.');
  if (!note?.trim()) throw new LinkRuleError('Say why the link is being switched off.');
  const r = await prisma.shortLink.updateMany({
    where: { code },
    data: { status: 'DISABLED_BY_PLATFORM', disabledAt: now, disabledById: adminId, disabledNote: note.trim().slice(0, 500) }
  });
  if (r.count === 0) throw new LinkRuleError('No link has that code.');
  return { code, status: 'DISABLED_BY_PLATFORM' as const };
}

export async function platformEnable(code: string) {
  const r = await prisma.shortLink.updateMany({
    where: { code, status: 'DISABLED_BY_PLATFORM' },
    data: { status: 'ACTIVE', disabledAt: null, disabledById: null, disabledNote: null }
  });
  if (r.count === 0) throw new LinkRuleError('No link with that code is switched off by ScaleEzy.');
  return { code, status: 'ACTIVE' as const };
}

/** For the console: what a code is, without anything about who it was sent to. */
export async function describe(code: string) {
  if (!/^[A-Za-z0-9]{7}$/.test(code)) return null;
  return prisma.shortLink.findUnique({
    where: { code },
    select: {
      code: true, clientId: true, ownerModule: true, ownerRef: true, targetType: true, target: true, status: true,
      expiresAt: true, isTest: true, disabledAt: true, disabledNote: true, tapCount: true, botOpenCount: true,
      firstTapAt: true, lastTapAt: true, createdAt: true
    }
  });
}

// ── Housekeeping ──────────────────────────────────────────────────────────────────────────

export async function purge(now = new Date()) {
  const day = 86_400_000;
  const taps = await prisma.shortLinkTap.deleteMany({ where: { at: { lt: new Date(now.getTime() - TAP_RETENTION_DAYS * day) } } });
  const testLinks = await prisma.shortLink.deleteMany({
    where: { isTest: true, expiresAt: { lt: new Date(now.getTime() - TEST_LINK_RETENTION_DAYS * day) } }
  });
  return { taps: taps.count, testLinks: testLinks.count };
}
