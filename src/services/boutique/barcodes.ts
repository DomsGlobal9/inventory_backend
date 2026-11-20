import { prisma } from '../../lib/prisma';
import { generateUniqueCode } from '../../utils/codeGenerator';
import { problem, listItems, type Actor, type Db } from './index';
import { encodable } from './code128';

/**
 * Barcodes for boutique items (20 Nov 2026, PLAN-boutique-backend.md part 1). Every item gets one, exactly like an
 * item added in Inventory's own app: "SVM-" and 8 characters, printed as Code 128. A maker's own barcode (the one
 * already printed on a bolt of cloth or a box of beads) may be given instead. A barcode is unique across ScaleEzy,
 * and within a shop it may not be another item's code either, so a scan always finds exactly one item.
 */
const SHAPE = /^[A-Za-z0-9._/-]{4,48}$/;

/** A barcode sent with an item: trimmed and checked, or null when none was sent. */
export function barcodeOf(raw: unknown, itemCode: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const code = String(raw).trim();
  if (!SHAPE.test(code) || !encodable(code)) throw problem(`${itemCode}: a barcode is 4 to 48 letters, digits, dots, dashes or slashes.`);
  return code;
}

/** Refuses a barcode another item already carries, or one that is another item's code in this shop. */
export async function mustBeFree(tx: Db, clientId: string, code: string, variantId: string | null, itemCode: string) {
  // Two saves with the same barcode at the same moment (any shop): queued, so the second is told, not crashed.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`barcode|${code}`}))::text`;
  const other = { ...(variantId ? { id: { not: variantId } } : {}) };
  // Unique across all shops: whose it is is not said, only that it is taken.
  if (await tx.productVariant.count({ where: { barcode: code, ...other } })) throw problem(`${itemCode}: the barcode ${code} is already on another item.`, 409);
  if (await tx.productVariant.count({ where: { clientId, ...other, OR: [{ sku: code }, { variantCode: code }, { boutiqueRef: code }] } })) {
    throw problem(`${itemCode}: ${code} is already another item's code in this shop, so a scan could not tell them apart.`, 409);
  }
}

/** A new SVM barcode nobody has. */
export const newBarcode = (tx: Db) => generateUniqueCode('SVM', 8, async code => (await tx.productVariant.count({ where: { barcode: code } })) > 0);

/**
 * Gives a barcode to every boutique item of the shop that has none (items added before 20 Nov), up to 100 a call.
 * Says how many it gave and how many are still without, so a caller repeats until none are left.
 */
export async function fillMissing(tx: Db, actor: Actor) {
  if (!actor.can.includes('products:write')) throw problem('This person may not change items.', 403);
  const without = await tx.productVariant.findMany({
    where: { clientId: actor.clientId, boutiqueRef: { not: null }, boutiqueDeletedAt: null, barcode: null },
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: 100
  });
  for (const v of without) {
    await tx.productVariant.update({ where: { id: v.id }, data: { barcode: await newBarcode(tx), barcodeType: 'INTERNAL_CODE128' } });
  }
  const left = await tx.productVariant.count({ where: { clientId: actor.clientId, boutiqueRef: { not: null }, boutiqueDeletedAt: null, barcode: null } });
  return { status: 200, answer: { success: true, data: { given: without.length, stillWithout: left } } };
}

/**
 * The item a scanner read: its barcode, or its item code, SKU or BV- code typed in by hand. Only this shop's
 * boutique items; a shop item that is not a boutique item says so, rather than "not found".
 */
export async function scan(actor: Actor, raw: unknown) {
  const code = String(raw ?? '').trim();
  if (!code || code.length > 60) throw problem('Send code: what the scanner read (or the item code).');
  const select = { boutiqueRef: true, barcode: true, boutiqueDeletedAt: true } as const;
  // A barcode match wins over a code match (older Inventory items were never checked against boutique codes).
  const hit = await prisma.productVariant.findFirst({ where: { clientId: actor.clientId, barcode: code }, select })
    ?? await prisma.productVariant.findFirst({ where: { clientId: actor.clientId, OR: [{ boutiqueRef: code }, { sku: code }, { variantCode: code }] }, select, orderBy: { createdAt: 'asc' } });
  if (!hit) throw problem(`Nothing in this shop has the code ${code}.`, 404);
  if (!hit.boutiqueRef || hit.boutiqueDeletedAt) throw problem(`${code} is ${hit.boutiqueDeletedAt ? 'an item that was deleted' : 'one of the shop\'s own items, not a boutique item'}.`, 404);
  const r = await listItems(actor, { itemCode: hit.boutiqueRef, limit: 1 });
  if (!r.items.length) throw problem(`Nothing in this shop has the code ${code}.`, 404);
  return { matchedBy: hit.barcode === code ? 'barcode' : 'code', item: r.items[0] };
}
