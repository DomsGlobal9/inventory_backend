/**
 * Reel links (PLAN-reel-links.md, 16 Nov): the pieces shown in one Instagram reel, behind one link.
 *
 * The shop picks the pieces; a shopper who opens the link sees the shop's logo and only those pieces, in the shop's
 * own online shop, and buys them the usual way.
 *
 *  - The link points at the REEL LINK (its code), never at products. The page reads the pieces fresh every time, so
 *    editing the pieces, a price change, an offer or a piece selling out all show without the link changing.
 *  - The short link (go.scaleezy.com) goes to /_look/<code> on the shop's host, which sends the shopper on to the
 *    shop's CURRENT address. A shop that changes its address (only possible while closed) keeps every old reel working.
 *  - It never expires: a reel stays on Instagram for years. The shop switches a link off, or deletes it.
 *  - This module only READS products, stock and prices. Its own tables are reel_links and reel_link_items.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { links } from '../links';
import { newCode, CODE_SHAPE } from '../links/rules';
import { ELIGIBLE_PRODUCT } from '../storefront-catalogue.service';
import { literal } from '../../utils/likeText';

export const MAX_PIECES = 12;
const TITLE_MAX = 80;
const URL_MAX = 500;
const OWNER_MODULE = 'reel-links';

export class ReelLinkError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new ReelLinkError(status, message); };

export type Actor = { id: string; clientId: string };

// ── Addresses ──────────────────────────────────────────────────────────────────────────────

const shopBase = () => env.SHOP_BASE_URL?.replace(/\/+$/, '') ?? null;

/** Where a reel link's short link goes: the shop host's own "find this reel" address. */
const lookTarget = (code: string) => (shopBase() ? `${shopBase()}/_look/${code}` : null);

/** The page itself, on the shop's current address. */
const lookUrl = (slug: string | null, code: string) => (shopBase() && slug ? `${shopBase()}/${slug}/look/${code}` : null);

/** The bio page: every reel link of the shop, newest first. */
const bioUrl = (slug: string | null) => (shopBase() && slug ? `${shopBase()}/${slug}/reels` : null);

async function shopOf(clientId: string) {
  return prisma.onlineShop.findUnique({ where: { clientId }, select: { slug: true, isLive: true, locationIds: true } });
}

// ── Checking what the shop sends ──────────────────────────────────────────────────────────

function checkTitle(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!t) fail(400, 'Give the reel link a title. The shopper sees it at the top of the page.');
  if (t.length > TITLE_MAX) fail(400, `Keep the title to ${TITLE_MAX} letters.`);
  return t;
}

function checkReelUrl(raw: unknown): string | null {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return null;
  if (typeof raw !== 'string') return fail(400, 'The reel address should be a web address.');
  const text = raw.trim();
  if (text.length > URL_MAX) fail(400, 'That reel address is too long.');
  let u: URL;
  try { u = new URL(text); } catch { return fail(400, 'That is not a web address. Copy it from Instagram with Share, then Copy link.'); }
  if (u.protocol !== 'https:') fail(400, 'The reel address must start with https://');
  if (u.username || u.password) fail(400, 'The reel address must not contain a user name or password.');
  return u.toString();
}

type PieceIn = { productId: string; colour: string | null };

function readPieces(raw: unknown, { atLeastOne = true } = {}): PieceIn[] {
  if (!Array.isArray(raw)) return fail(400, 'Choose the pieces shown in the reel.');
  const out: PieceIn[] = [];
  for (const r of raw) {
    const productId = typeof r === 'string' ? r : (r && typeof r === 'object' ? (r as any).productId : null);
    const colourRaw = r && typeof r === 'object' ? (r as any).colour : null;
    if (typeof productId !== 'string' || !productId.trim()) fail(400, 'One of the pieces is missing. Remove it and add it again.');
    if (colourRaw != null && typeof colourRaw !== 'string') fail(400, 'The colour of a piece should be one of its colours.');
    if (out.some(p => p.productId === productId)) continue; // the same piece twice is the same piece
    out.push({ productId: productId.trim(), colour: typeof colourRaw === 'string' && colourRaw.trim() ? colourRaw.trim() : null });
  }
  if (atLeastOne && out.length === 0) fail(400, 'Add at least one piece from the reel.');
  if (out.length > MAX_PIECES) fail(400, `A reel link can hold up to ${MAX_PIECES} pieces.`);
  return out;
}

/**
 * Only the shop's own pieces that a shopper could see: active, not in the bin, not a material. The colour must be
 * one the piece really has (kept in the product's own spelling), or none.
 */
async function checkPieces(clientId: string, pieces: PieceIn[]): Promise<PieceIn[]> {
  if (pieces.length === 0) return pieces;
  const found = await prisma.product.findMany({
    where: { clientId, id: { in: pieces.map(p => p.productId) } },
    select: { id: true, title: true, status: true, trashedAt: true, sellInShop: true, variants: { select: { colorName: true } } }
  });
  const byId = new Map(found.map(p => [p.id, p]));
  return pieces.map(p => {
    const prod = byId.get(p.productId);
    // Another shop's piece reads exactly like a missing one: nothing about it is told.
    if (!prod) return fail(400, 'One of the pieces is no longer in your products. Remove it and try again.');
    if (prod.trashedAt) fail(400, `"${prod.title}" is in the bin. Restore it first, or leave it out.`);
    if (!prod.sellInShop) fail(400, `"${prod.title}" is a material, not for sale, so it cannot go in a reel link.`);
    if (prod.status !== 'ACTIVE') fail(400, `"${prod.title}" is not published yet. Publish it first, or leave it out.`);
    if (!p.colour) return p;
    const match = prod.variants.map(v => v.colorName).find(c => c && c.toLowerCase() === p.colour!.toLowerCase());
    if (!match) fail(400, `"${prod.title}" does not come in ${p.colour}. Choose one of its colours.`);
    return { productId: p.productId, colour: match ?? null };
  });
}

// ── The short link ─────────────────────────────────────────────────────────────────────────

/**
 * Makes the go.scaleezy.com link once. Never fatal: a reel link without a short link still works on its full shop
 * address, and the next time the list is opened it tries again.
 */
async function ensureShortLink(link: { id: string; clientId: string; code: string; shortCode: string | null }, by: string | null) {
  if (link.shortCode || !links.available()) return link.shortCode;
  const target = lookTarget(link.code);
  if (!target) return null;
  try {
    const [made] = await links.makeLinks({
      clientId: link.clientId, owner: { module: OWNER_MODULE, ref: link.id },
      links: [{ targetType: 'CAMPAIGN', target }], forever: true, createdById: by
    });
    // Two screens making it at the same moment: the first one written wins, the other link is never shown.
    const n = await prisma.reelLink.updateMany({ where: { id: link.id, shortCode: null }, data: { shortCode: made.code } });
    if (n.count === 1) return made.code;
    return (await prisma.reelLink.findUnique({ where: { id: link.id }, select: { shortCode: true } }))?.shortCode ?? null;
  } catch (e) {
    console.error('[reel-links] short link not made yet:', (e as Error)?.message);
    return null;
  }
}

const shortUrlOf = (code: string | null) => {
  if (!code || !links.available()) return null;
  try { return links.shortUrl(code); } catch { return null; }
};

// ── For the shop (signed in) ───────────────────────────────────────────────────────────────

/** Whether reel links can be made here, and the bio link. */
export async function overview(clientId: string) {
  const [shop, look, settings] = await Promise.all([
    shopOf(clientId),
    prisma.onlineShop.findUnique({ where: { clientId }, select: { displayName: true, logoUrl: true, accent: true } }),
    prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } }).catch(() => null)
  ]);
  return {
    shopReady: Boolean(shop?.slug),
    shopLive: Boolean(shop?.isLive),
    bioUrl: bioUrl(shop?.slug ?? null),
    shortLinks: links.available(),
    // For the phone preview beside the editor: the shop as a shopper sees it.
    shopName: look?.displayName?.trim() || settings?.businessName?.trim() || 'Your shop',
    logoUrl: look?.logoUrl ?? null,
    accent: look?.accent ?? null
  };
}

const PHOTO_SELECT = {
  where: { imageType: { not: 'RAW_UPLOAD' } },
  orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }],
  take: 1,
  select: { url: true }
} satisfies Prisma.Product$imagesArgs;

/** Pieces in a reel link (or a search result), with what the shop needs to choose: photo, price, stock, colours. */
async function describePieces(clientId: string, productIds: string[]) {
  if (productIds.length === 0) return new Map<string, any>();
  const shop = await shopOf(clientId);
  const locations = shop?.locationIds?.length ? shop.locationIds : undefined;
  const rows = await prisma.product.findMany({
    where: { clientId, id: { in: productIds } },
    select: {
      id: true, title: true, productCode: true, status: true, trashedAt: true, sellInShop: true, soldBy: true,
      images: PHOTO_SELECT,
      variants: {
        select: {
          colorName: true, size: true, sellingPrice: true,
          images: PHOTO_SELECT,
          stocks: { where: locations ? { locationId: { in: locations } } : {}, select: { quantity: true, reservedQty: true } }
        }
      }
    }
  });
  const out = new Map<string, any>();
  for (const p of rows) {
    const prices = p.variants.map(v => Number(v.sellingPrice)).filter(n => Number.isFinite(n) && n > 0);
    const free = p.variants.reduce((t, v) => t + v.stocks.reduce((s, st) => s + Math.max(0, st.quantity - st.reservedQty), 0), 0);
    const colours: string[] = [];
    for (const v of p.variants) if (v.colorName && !colours.some(c => c.toLowerCase() === v.colorName!.toLowerCase())) colours.push(v.colorName);
    const sizes = [...new Set(p.variants.map(v => v.size).filter(Boolean))];
    out.set(p.id, {
      productId: p.id, title: p.title, productCode: p.productCode, soldBy: p.soldBy,
      photo: p.images[0]?.url ?? p.variants.find(v => v.images[0])?.images[0]?.url ?? null,
      priceFrom: prices.length ? Math.min(...prices) : null,
      priceTo: prices.length ? Math.max(...prices) : null,
      inStock: free,
      colours, sizes,
      // Why a shopper would not see it, in words; null when they would.
      hidden: p.trashedAt ? 'In the bin' : !p.sellInShop ? 'A material, not for sale' : p.status !== 'ACTIVE' ? 'Not published' : null
    });
  }
  return out;
}

/** Search for pieces to add: the shop's published, for-sale products, by name, code or SKU. */
export async function searchPieces(clientId: string, raw: unknown) {
  const q = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
  // Prisma's `contains`, and `equals` with mode 'insensitive', are an ILIKE that does not escape: "%" or "_" matched
  // everything, and a backslash at the end broke the query.
  const like = literal(q);
  const rows = await prisma.product.findMany({
    where: {
      clientId, ...ELIGIBLE_PRODUCT,
      ...(q ? {
        OR: [
          { title: { contains: like, mode: 'insensitive' } },
          { productCode: { contains: like, mode: 'insensitive' } },
          { variants: { some: { OR: [{ sku: { equals: like, mode: 'insensitive' } }, { sku: { contains: like, mode: 'insensitive' } }, { barcode: q }] } } }
        ]
      } : {})
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { id: true }
  });
  const described = await describePieces(clientId, rows.map(r => r.id));
  return rows.map(r => described.get(r.id)).filter(Boolean);
}

/** The shop's reel links, newest first, with how many people opened each. */
export async function list(clientId: string) {
  const [shop, rows] = await Promise.all([
    shopOf(clientId),
    prisma.reelLink.findMany({
      where: { clientId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, clientId: true, code: true, title: true, active: true, shortCode: true, createdAt: true, createdById: true,
        items: { orderBy: { position: 'asc' }, take: 1, select: { product: { select: { images: PHOTO_SELECT } } } },
        _count: { select: { items: true } }
      }
    })
  ]);
  // A link made while short links were not set up yet gets one now.
  for (const r of rows) if (!r.shortCode) r.shortCode = await ensureShortLink(r, null);
  const [stats, people] = await Promise.all([
    links.statsForMany(clientId, OWNER_MODULE, rows.map(r => r.id)),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.createdById).filter(Boolean) as string[])] } }, select: { id: true, name: true } })
  ]);
  const nameOf = new Map(people.map(p => [p.id, p.name]));
  return rows.map(r => ({
    id: r.id, code: r.code, title: r.title, active: r.active, createdAt: r.createdAt,
    createdBy: r.createdById ? nameOf.get(r.createdById) ?? null : null,
    pieces: r._count.items,
    cover: r.items[0]?.product.images[0]?.url ?? null,
    shortUrl: shortUrlOf(r.shortCode),
    pageUrl: lookUrl(shop?.slug ?? null, r.code),
    opened: stats.get(r.id)?.totalTaps ?? 0
  }));
}

async function own(clientId: string, id: string) {
  const r = typeof id === 'string' && id ? await prisma.reelLink.findFirst({ where: { id, clientId, deletedAt: null } }) : null;
  if (!r) fail(404, 'That reel link is no longer here. It may have been deleted.');
  return r!;
}

/** One reel link with its pieces, for the edit screen. */
export async function get(clientId: string, id: string) {
  const r = await own(clientId, id);
  const [shop, items, stats] = await Promise.all([
    shopOf(clientId),
    prisma.reelLinkItem.findMany({ where: { reelLinkId: r.id }, orderBy: { position: 'asc' } }),
    links.statsForMany(clientId, OWNER_MODULE, [r.id])
  ]);
  const shortCode = r.shortCode ?? await ensureShortLink(r, null);
  const described = await describePieces(clientId, items.map(i => i.productId));
  return {
    id: r.id, code: r.code, title: r.title, reelUrl: r.reelUrl, active: r.active, createdAt: r.createdAt,
    shortUrl: shortUrlOf(shortCode), pageUrl: lookUrl(shop?.slug ?? null, r.code),
    opened: stats.get(r.id)?.totalTaps ?? 0,
    // A colour the piece no longer comes in (renamed, or its last variant removed) falls back to none, so the reel
    // link can still be saved; the screen then shows the piece's own first colour.
    pieces: items.map(i => {
      const d = described.get(i.productId);
      const colour = i.colour && d ? d.colours.find((c: string) => c.toLowerCase() === i.colour!.toLowerCase()) ?? null : null;
      return { ...d, colour };
    }).filter(p => p.productId)
  };
}

async function needShop(clientId: string) {
  const shop = await shopOf(clientId);
  if (!shop?.slug) fail(409, 'Choose your online shop address first, in Settings, Online shop. Reel links open in your online shop.');
}

async function writeItems(tx: Prisma.TransactionClient, reelLinkId: string, pieces: PieceIn[]) {
  await tx.reelLinkItem.deleteMany({ where: { reelLinkId } });
  if (pieces.length) {
    await tx.reelLinkItem.createMany({ data: pieces.map((p, i) => ({ reelLinkId, productId: p.productId, colour: p.colour, position: i })) });
  }
}

/** The title a new reel link starts with: "Reel 1", "Reel 2", ... counting every one the shop has made. */
export async function nextTitle(clientId: string) {
  const n = await prisma.reelLink.count({ where: { clientId } });
  return `Reel ${n + 1}`;
}

export async function create(actor: Actor, body: any) {
  await needShop(actor.clientId);
  const title = checkTitle(body?.title);
  const reelUrl = checkReelUrl(body?.reelUrl);
  const pieces = await checkPieces(actor.clientId, readPieces(body?.pieces));
  let made: { id: string; clientId: string; code: string; shortCode: string | null } | null = null;
  for (let attempt = 0; attempt < 5 && !made; attempt++) {
    try {
      made = await prisma.$transaction(async tx => {
        const r = await tx.reelLink.create({
          data: { clientId: actor.clientId, code: newCode(), title, reelUrl, createdById: actor.id },
          select: { id: true, clientId: true, code: true, shortCode: true }
        });
        await writeItems(tx, r.id, pieces);
        return r;
      });
    } catch (e) {
      // A code that already exists (one in 3.5 million million): draw another.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }
  if (!made) fail(500, 'The reel link could not be made. Please try again.');
  await ensureShortLink(made!, actor.id);
  return get(actor.clientId, made!.id);
}

/** Title, reel address and pieces. The link never changes. */
export async function update(actor: Actor, id: string, body: any) {
  const r = await own(actor.clientId, id);
  const title = body?.title !== undefined ? checkTitle(body.title) : r.title;
  const reelUrl = body?.reelUrl !== undefined ? checkReelUrl(body.reelUrl) : r.reelUrl;
  const pieces = body?.pieces !== undefined ? await checkPieces(actor.clientId, readPieces(body.pieces)) : null;
  await prisma.$transaction(async tx => {
    // Locked first, so two people saving the same reel link at once leave one whole list, never a mix of both.
    await tx.$queryRaw`SELECT id FROM reel_links WHERE id = ${r.id} FOR UPDATE`;
    await tx.reelLink.update({ where: { id: r.id }, data: { title, reelUrl } });
    if (pieces) await writeItems(tx, r.id, pieces);
  });
  return get(actor.clientId, r.id);
}

/**
 * From the Products list: add the ticked pieces to an existing reel link (after the ones already in it), or make a
 * new one with them. Pieces already in the reel link stay where they are.
 */
export async function addPieces(actor: Actor, body: any) {
  const incoming = await checkPieces(actor.clientId, readPieces(body?.productIds));
  if (!body?.reelLinkId) {
    return create(actor, { title: body?.title || await nextTitle(actor.clientId), pieces: incoming });
  }
  const r = await own(actor.clientId, String(body.reelLinkId));
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM reel_links WHERE id = ${r.id} FOR UPDATE`;
    const have = await tx.reelLinkItem.findMany({ where: { reelLinkId: r.id }, orderBy: { position: 'asc' } });
    const fresh = incoming.filter(p => !have.some(h => h.productId === p.productId));
    const all = [...have.map(h => ({ productId: h.productId, colour: h.colour })), ...fresh];
    if (all.length > MAX_PIECES) {
      fail(400, `"${r.title}" has ${have.length} pieces. A reel link can hold up to ${MAX_PIECES}, so add at most ${Math.max(0, MAX_PIECES - have.length)} more.`);
    }
    await writeItems(tx, r.id, all);
  });
  return get(actor.clientId, r.id);
}

export async function setActive(actor: Actor, id: string, active: boolean) {
  const r = await own(actor.clientId, id);
  await prisma.reelLink.update({ where: { id: r.id }, data: { active } });
  return get(actor.clientId, r.id);
}

/** Gone from the list and the bio page. The link keeps answering, with "no longer available". */
export async function remove(actor: Actor, id: string) {
  const r = await own(actor.clientId, id);
  await prisma.reelLink.update({ where: { id: r.id }, data: { deletedAt: new Date(), active: false } });
  return { deleted: true };
}

// ── For shoppers (public, by code) ─────────────────────────────────────────────────────────

/** /_look/<code>: which shop address a reel link lives at now. Null for an unknown code. */
export async function slugForCode(raw: unknown): Promise<string | null> {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!CODE_SHAPE.test(code)) return null;
  const r = await prisma.reelLink.findUnique({ where: { code }, select: { clientId: true } });
  if (!r) return null;
  return (await shopOf(r.clientId))?.slug ?? null;
}

/**
 * A reel link as the shopper's page needs it: the title and its pieces in the shop's order, each with the colour
 * worn in the reel. `null` when there is no such reel link IN THIS SHOP (another shop's code reads as unknown).
 * `available: false` when it was switched off or deleted.
 */
export async function forShopper(clientId: string, raw: unknown) {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!CODE_SHAPE.test(code)) return null;
  const r = await prisma.reelLink.findFirst({
    where: { code, clientId },
    select: { title: true, active: true, deletedAt: true, items: { orderBy: { position: 'asc' }, select: { colour: true, product: { select: { productCode: true } } } } }
  });
  if (!r) return null;
  if (!r.active || r.deletedAt) return { available: false as const, title: null, pieces: [] };
  return { available: true as const, title: r.title, pieces: r.items.map(i => ({ productCode: i.product.productCode, colour: i.colour })) };
}

/** The bio page: the shop's switched-on reel links, newest first, each with its first piece's photo. */
export async function bioForShopper(clientId: string, limit = 60) {
  const rows = await prisma.reelLink.findMany({
    where: { clientId, active: true, deletedAt: null, items: { some: { product: ELIGIBLE_PRODUCT } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      code: true, title: true,
      items: { where: { product: ELIGIBLE_PRODUCT }, orderBy: { position: 'asc' }, take: 1, select: { product: { select: { images: PHOTO_SELECT } } } }
    }
  });
  return rows.map(r => ({ code: r.code, title: r.title, cover: r.items[0]?.product.images[0]?.url ?? null }));
}
