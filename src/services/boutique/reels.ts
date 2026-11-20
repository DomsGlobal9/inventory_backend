import { prisma } from '../../lib/prisma';
import * as reelLinks from '../reel-links';
import { problem, type Actor } from './index';

/**
 * Reel links through the boutique API (20 Nov 2026, PLAN-boutique-backend.md #17; the owner: "in reel links there is
 * option to off but no remove or delete"). The same reel links as Inventory's Reel links screen -- one link per
 * Instagram reel with only the pieces it shows -- with pieces named by the boutique's codes instead of our ids.
 * Reading needs nothing; making, changing, switching and deleting need reels:write.
 *
 * Shoppers open them through Shop API v1 (/shop/v1/<slug>/looks/<code>, /shop/v1/<slug>/reels), as in Inventory.
 */
const mustWrite = (a: Actor) => { if (!a.can.includes('reels:write')) throw problem('This person may not make or change reel links.', 403); };

/** The reel-link engine's own refusals carry their own status and sentence: passed on as they are. */
async function said<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof reelLinks.ReelLinkError) throw problem(e.message, e.statusCode);
    throw e;
  }
}

// No Inventory user made it: the boutique's person is not one of our users, so "made by" stays empty.
const engineActor = (a: Actor): reelLinks.Actor => ({ id: null as unknown as string, clientId: a.clientId });

/**
 * Pieces as the boutique names them: { code, colour? }. code is a design's product code, or any one item's code,
 * barcode or SKU (then the item's own colour is used unless colour is given). Turned into the engine's productIds,
 * checked against this shop and refused by code.
 */
async function toPieces(clientId: string, raw: unknown) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw problem('pieces is a list of { code, colour }.');
  if (raw.length > reelLinks.MAX_PIECES) throw problem(`A reel link can hold up to ${reelLinks.MAX_PIECES} pieces.`);
  const out: { productId: string; colour: string | null }[] = [];
  for (const p of raw) {
    const code = String((typeof p === 'string' ? p : p?.code) ?? '').trim();
    if (!code) throw problem('Each piece needs its code (a product code, or an item code, barcode or SKU).');
    const colour = typeof p === 'object' && p && typeof p.colour === 'string' && p.colour.trim() ? p.colour.trim() : null;
    const product = await prisma.product.findFirst({ where: { clientId, productCode: code }, select: { id: true } });
    if (product) { out.push({ productId: product.id, colour }); continue; }
    const select = { productId: true, colorName: true } as const;
    const v = await prisma.productVariant.findFirst({ where: { clientId, barcode: code, boutiqueDeletedAt: null }, select })
      ?? await prisma.productVariant.findFirst({ where: { clientId, boutiqueDeletedAt: null, OR: [{ boutiqueRef: code }, { variantCode: code }, { sku: code }] }, select });
    if (!v) throw problem(`${code}: no such item or design in this shop.`, 404);
    out.push({ productId: v.productId, colour: colour ?? v.colorName ?? null });
  }
  return out;
}

/** One reel link as the boutique sees it: the engine's answer, each piece also by the codes of its items. */
async function view(clientId: string, r: any) {
  const ids = (r.pieces ?? []).map((p: any) => p.productId);
  const vs = ids.length ? await prisma.productVariant.findMany({ where: { clientId, productId: { in: ids }, boutiqueDeletedAt: null }, select: { productId: true, boutiqueRef: true, variantCode: true } }) : [];
  const codes = new Map<string, string[]>();
  for (const v of vs) codes.set(v.productId, [...(codes.get(v.productId) ?? []), v.boutiqueRef ?? v.variantCode]);
  return { ...r, pieces: (r.pieces ?? []).map((p: any) => ({ ...p, itemCodes: codes.get(p.productId) ?? [] })) };
}

export const overview = (a: Actor) => said(() => reelLinks.overview(a.clientId));
export const list = (a: Actor) => said(() => reelLinks.list(a.clientId));
export const getOne = (a: Actor, id: string) => said(async () => view(a.clientId, await reelLinks.get(a.clientId, id)));

export async function create(a: Actor, body: any) {
  mustWrite(a);
  const pieces = await toPieces(a.clientId, body?.pieces ?? []);
  const title = body?.title ?? await reelLinks.nextTitle(a.clientId);
  return said(async () => view(a.clientId, await reelLinks.create(engineActor(a), { title, reelUrl: body?.reelUrl, pieces })));
}

/** Only what is sent: title, reelUrl, pieces (the whole list, in order). The link itself never changes. */
export async function change(a: Actor, id: string, body: any) {
  mustWrite(a);
  await said(() => reelLinks.get(a.clientId, id)); // 404 for another shop's, before anything is read from the body
  const pieces = await toPieces(a.clientId, body?.pieces);
  const next: Record<string, unknown> = {};
  if (body?.title !== undefined) next.title = body.title;
  if (body?.reelUrl !== undefined) next.reelUrl = body.reelUrl;
  if (pieces !== undefined) next.pieces = pieces;
  return said(async () => view(a.clientId, await reelLinks.update(engineActor(a), id, next)));
}

export async function setOn(a: Actor, id: string, on: boolean) {
  mustWrite(a);
  return said(async () => view(a.clientId, await reelLinks.setActive(engineActor(a), id, on)));
}

/** Gone from the list and the bio page. The link keeps answering shoppers, with "no longer available". */
export async function remove(a: Actor, id: string) {
  mustWrite(a);
  return said(() => reelLinks.remove(engineActor(a), id));
}
