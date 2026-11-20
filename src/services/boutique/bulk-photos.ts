import { prisma } from '../../lib/prisma';
import * as productPhotos from '../product-photos';
import { problem, type Actor } from './index';

/**
 * Photos for many items at once through the boutique API (20 Nov 2026, PLAN-boutique-backend.md #6): the same service
 * as Inventory's Bulk photos.
 *   match:     which item (and colour) each file name is for -- "SLK-0001.jpg", "SLK-0001-green-2.jpg" -- nothing is
 *              uploaded; then upload each file with POST /photos (10 at a time) and attach it with PUT /items/{code}.
 *   from link: a photo already online (https) fetched by ScaleEzy, checked to be a real picture, stored, and attached to
 *              the item's colour (every size of it). Never a private or local address.
 * products:write.
 */
const mustWrite = (a: Actor) => { if (!a.can.includes('products:write')) throw problem('This person may not change items.', 403); };
async function said<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e: any) {
    if (e?.statusCode || e?.status) throw problem(String(e.message), e.statusCode ?? e.status);
    throw e;
  }
}

/** { fileNames: [...] } (up to 1,000): each file matched to an item by its code, with the colour and position. */
export async function match(a: Actor, body: any) {
  mustWrite(a);
  const names = body?.fileNames ?? body?.names;
  if (!Array.isArray(names) || !names.length) throw problem('Send fileNames: the names of the photo files.');
  const out: any = await said(() => productPhotos.match(a.clientId, names) as any);
  const ids = [...new Set((out.files ?? []).flatMap((f: any) => f.variantIds ?? []))] as string[];
  const codes = new Map((ids.length ? await prisma.productVariant.findMany({ where: { id: { in: ids }, clientId: a.clientId }, select: { id: true, boutiqueRef: true, variantCode: true } }) : [])
    .map(v => [v.id, v.boutiqueRef ?? v.variantCode]));
  return {
    files: (out.files ?? []).map((f: any) => ({
      name: f.name, status: f.status, reason: f.reason ?? null, itemName: f.productTitle ?? null, colour: f.colour ?? null, position: f.position ?? null,
      itemCodes: (f.variantIds ?? []).map((id: string) => codes.get(id)).filter(Boolean), alreadyThere: !!f.already
    })),
    // Draft items with no photo that this folder does not cover either: what still needs a picture.
    draftsStillWithoutPhotos: (out.withoutPhotos ?? []).length
  };
}

/** { itemCode, url, position? }: a photo already online, put on that item's colour. */
export async function fromLink(a: Actor, body: any) {
  mustWrite(a);
  const code = String(body?.itemCode ?? '').trim();
  const v = await prisma.productVariant.findFirst({ where: { clientId: a.clientId, boutiqueDeletedAt: null, OR: [{ boutiqueRef: code }, { variantCode: code }, { sku: code }] }, select: { productId: true, colorName: true } });
  if (!v) throw problem(`${code || 'That item'}: no such item in this shop.`, 404);
  return said(() => productPhotos.fromLink(a.clientId, { productId: v.productId, colour: v.colorName, url: body?.url, position: body?.position }) as any);
}
