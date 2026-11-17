/**
 * Deleting and archiving the boutique's items (CRM-B), one or many (17 Nov 2026).
 *
 * The boutique's inventory is the boutique's: it may DELETE an item, not only archive it. Until today
 * DELETE /items/{code} archived -- the item stayed in every list as ARCHIVED for ever and its code could never be
 * used again, which is not what anybody means by delete.
 *
 *   ARCHIVE  off sale, kept: its stock, holds and history stay, it still answers in lists as ARCHIVED, and it comes
 *            back with restore. (What DELETE used to do; now POST /items/{code}/archive.)
 *   DELETE   gone: from every list, lookup, alert and report of current stock, and its code is free for a new item.
 *
 * Two things ScaleEzy decides by itself when an item is deleted, because the boutique cannot know them:
 *
 *   NEVER USED (no movement, bill, purchase order, count or hold ever, and not on sale): erased, row and all.
 *   HAS A PAST: it cannot be erased -- the bills, the day book and the stock value it was part of must still add up.
 *            It is kept out of sight: alone on a product of its own in the bin, marked boutique_deleted_at, with a
 *            "#..." tail on its code (item codes cannot contain "#"), so every lookup by code misses it and the code
 *            is free. Its past movements still answer, under the code it had, marked itemDeleted.
 *
 * What stands in the way is said, never guessed at: stock still on the shelf, cloth held for stitching orders, a
 * purchase order that has not arrived, pieces kept for the shop's own customer orders. The first two are the
 * boutique's to give up -- `force: true` writes the stock off (a WRITE_OFF movement, so the books show where it
 * went) and lets the holds go. The last two are promises to somebody else and are never forced.
 *
 * Each item is deleted inside its own savepoint, so in a bulk call one refusal undoes nothing else.
 */
import { supabase } from '../../lib/supabase';
import { afterCommit } from '../../lib/afterCommit';
import { inventoryMutationService } from '../inventory-mutation.service';
import { factorOf, formatQty, type SoldBy } from '../../lib/units';
import {
  type Actor, type Db, type Touched, problem, archiveColour, archiveItem, shelfFor, carryColour, tellShops, onSale, upsertItem, deletedRef
} from './index';

const MAX_AT_ONCE = 200;
const CODE = /^[A-Za-z0-9._/-]{1,50}$/;
const OPEN_ORDER = ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] as const;

export type Blocker = {
  code: 'HAS_STOCK' | 'HELD_FOR_ORDERS' | 'ON_PURCHASE_ORDER' | 'SHOP_ORDERS_WAITING';
  message: string;
  /** true: `force: true` clears it and deletes. false: it must be dealt with first. */
  canForce: boolean;
  [more: string]: unknown;
};
type Refusal = Error & { statusCode: number; details: { code: string; blockers?: Blocker[]; canForce?: boolean } };
const refuse = (message: string, statusCode: number, code: string, more: Record<string, unknown> = {}): Refusal =>
  Object.assign(new Error(message), { statusCode, message, details: { code, ...more } }) as Refusal;

const mayDelete = (actor: Actor) => {
  if (!actor.can.includes('products:delete')) {
    throw refuse('This person may not delete items: the pass needs products:delete. (DELETE removes an item for good since 17 Nov 2026; to take one off sale and keep it, use POST /items/{itemCode}/archive.)', 403, 'NOT_ALLOWED');
  }
};

/** What one delete did, for its answer. `photos` are files to remove once the change is safely committed. */
type Done = { answer: Record<string, unknown>; touched: Touched; photos: string[] };

/**
 * Delete one item inside the caller's transaction. Refusals throw (with `details`), leaving nothing changed.
 * The caller decides what a refusal costs: the single call fails; the bulk call rolls back that one row.
 */
async function deleteOne(tx: Db, actor: Actor, itemCode: string, force: boolean): Promise<Done> {
  if (!CODE.test(itemCode)) throw refuse(`"${itemCode}" is not an item code (letters, numbers, dots, dashes or slashes, up to 50).`, 400, 'BAD_CODE');
  // The same queue a save of this code waits in: a delete and a save of one code never interleave.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique-item|${actor.clientId}|${itemCode}`}))::text`;
  const seen = await tx.productVariant.findFirst({ where: { clientId: actor.clientId, boutiqueRef: itemCode }, select: { id: true } });
  if (!seen) throw refuse(`No item ${itemCode} in this shop. (If it was deleted before, it is already gone.)`, 404, 'NOT_FOUND');
  // Locked, then read: a till sale or a hold landing between the checks below and the delete would otherwise be lost.
  await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${seen.id} FOR UPDATE`;
  const v = await tx.productVariant.findUniqueOrThrow({ where: { id: seen.id }, include: { product: true } });
  const soldBy = v.product.soldBy as SoldBy;
  const f = factorOf(soldBy);
  const say = (n: number) => formatQty(n, soldBy);

  // ── what stands in the way ────────────────────────────────────────────────────────────────
  const [stocks, holds, orderLines, shopHolds, payHolds] = await Promise.all([
    tx.inventoryStock.findMany({ where: { variantId: v.id }, include: { location: { select: { name: true } } } }),
    tx.boutiqueReservation.findMany({ where: { clientId: actor.clientId, variantId: v.id, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }),
    tx.purchaseOrderItem.findMany({ where: { variantId: v.id, po: { status: { in: [...OPEN_ORDER] as any } } }, select: { orderedQty: true, receivedQty: true, po: { select: { poNumber: true, status: true } } } }),
    tx.inventoryReservation.aggregate({ where: { variantId: v.id, status: { in: ['ACTIVE', 'PARTIALLY_FULFILLED'] as any } }, _sum: { reservedQty: true }, _count: true }),
    tx.onlinePaymentHold.aggregate({ where: { variantId: v.id, releasedAt: null }, _sum: { quantity: true }, _count: true })
  ]);
  const onHand = stocks.reduce((n, s) => n + s.quantity, 0);
  const reserved = stocks.reduce((n, s) => n + s.reservedQty, 0);
  const held = holds.reduce((n, h) => n + h.quantity, 0);
  // Reserved beyond the boutique's own holds is the shop's: pieces of customer orders not packed yet, or being paid for.
  const forShop = Math.max(0, reserved - held, shopHolds._sum.reservedQty ?? 0, payHolds._sum.quantity ?? 0);
  const waiting = orderLines.filter(l => l.orderedQty > l.receivedQty || l.po.status === 'DRAFT');

  const blockers: Blocker[] = [];
  if (forShop > 0 || shopHolds._count > 0 || payHolds._count > 0) {
    blockers.push({ code: 'SHOP_ORDERS_WAITING', canForce: false, quantity: forShop / f,
      message: `${say(forShop)} of ${itemCode} is kept for the shop's own customer orders that are not packed yet. It can be deleted once those orders are done. Archive it for now to stop selling it.` });
  }
  if (waiting.length) {
    const numbers = [...new Set(waiting.map(l => l.po.poNumber))];
    blockers.push({ code: 'ON_PURCHASE_ORDER', canForce: false, purchaseOrders: numbers,
      message: `${itemCode} is on ${numbers.length === 1 ? 'purchase order' : 'purchase orders'} ${numbers.join(', ')}, not fully received. Receive or cancel ${numbers.length === 1 ? 'it' : 'them'} first.` });
  }
  if (held > 0) {
    const refs = [...new Set(holds.map(h => h.orderRef))];
    blockers.push({ code: 'HELD_FOR_ORDERS', canForce: true, quantity: held / f, orderRefs: refs,
      message: `${say(held)} of ${itemCode} is held for ${refs.length === 1 ? 'order' : 'orders'} ${refs.slice(0, 5).join(', ')}${refs.length > 5 ? ` and ${refs.length - 5} more` : ''}. Release the holds first, or send force: true to release them and delete.` });
  }
  if (onHand !== 0) {
    blockers.push({ code: 'HAS_STOCK', canForce: true, quantity: onHand / f,
      byLocation: stocks.filter(s => s.quantity !== 0).map(s => ({ locationId: s.locationId, name: s.location?.name ?? null, stock: s.quantity / f })),
      message: `${itemCode} still has ${say(onHand)} in stock. Use it up or count it to zero first, or send force: true to write it off and delete.` });
  }
  const fixed = blockers.filter(b => !b.canForce);
  if (fixed.length || (blockers.length && !force)) {
    const first = (fixed[0] ?? blockers[0]);
    throw refuse(first.message, 409, first.code, { blockers, canForce: fixed.length === 0 });
  }

  // ── force: give up what is the boutique's to give up ──────────────────────────────────────
  let writtenOff = 0, released = 0;
  const releasedFor: string[] = [];
  if (blockers.length) {
    // Writing stock off is a stock change, whoever asks for it and by whatever door.
    if (!actor.can.includes('stock:write')) throw refuse('Deleting an item that still has stock or holds also needs stock:write on the pass (its stock is written off).', 403, 'NOT_ALLOWED');
    for (const h of holds) {
      await tx.boutiqueReservation.update({ where: { id: h.id }, data: { status: 'RELEASED' } });
      await tx.inventoryStock.update({ where: { variantId_locationId: { variantId: v.id, locationId: h.locationId } }, data: { reservedQty: { decrement: h.quantity } } });
      released += h.quantity;
      if (!releasedFor.includes(h.orderRef)) releasedFor.push(h.orderRef);
    }
    for (const s of stocks) {
      if (s.quantity === 0) continue;
      // Through the one doorway, so the stock value, the day book and the item's history all show where it went.
      await inventoryMutationService.applyMovement({
        clientId: actor.clientId, variantId: v.id, locationId: s.locationId,
        movementType: 'ADJUSTMENT' as any, reason: 'MANUAL_ADJUSTMENT' as any, quantityDelta: -s.quantity,
        referenceType: 'BOUTIQUE', notes: `written off: ${itemCode} deleted by ${actor.name}`, tx, allowNegative: true,
        boutique: { kind: 'WRITE_OFF', actorName: actor.name }
      } as any);
      writtenOff += s.quantity;
    }
  }
  // Wherever it sat on the shelves, it sits there no longer.
  await tx.spotStock.deleteMany({ where: { variantId: v.id } });

  // ── erase, or keep out of sight ───────────────────────────────────────────────────────────
  const touched: Touched = new Map();
  const [moves, transfers, counted, bought, received, sold, reservedEver, heldEver, paidFor, events, onShopify] = await Promise.all([
    tx.inventoryTransaction.count({ where: { variantId: v.id } }),
    tx.inventoryTransfer.count({ where: { variantId: v.id } }),
    tx.stockCountItem.count({ where: { variantId: v.id } }),
    tx.purchaseOrderItem.count({ where: { variantId: v.id } }),
    tx.purchaseReceiptItem.count({ where: { variantId: v.id } }),
    tx.salesOrderItem.count({ where: { variantId: v.id } }),
    tx.inventoryReservation.count({ where: { variantId: v.id } }),
    tx.boutiqueReservation.count({ where: { variantId: v.id } }),
    tx.onlinePaymentHold.count({ where: { variantId: v.id } }),
    tx.inventoryEvent.count({ where: { variantId: v.id } }),
    tx.shopifyIdMap.count({ where: { variantId: v.id } })
  ]);
  const hasPast = moves + transfers + counted + bought + received + sold + reservedEver + heldEver + paidFor + events > 0;
  // On sale somewhere: the till, the online shop and Shopify are told through the same road archiving uses, which
  // needs the row to still be there to speak of.
  const onSaleNow = onSale(v.product) || onShopify > 0;
  const photos: string[] = [];
  let historyKept = hasPast || onSaleNow;

  if (!historyKept) {
    const files = await tx.productImage.findMany({ where: { variantId: v.id }, select: { storagePath: true } });
    await tx.$executeRawUnsafe('SAVEPOINT erase_item');
    try {
      await tx.inventoryStock.deleteMany({ where: { variantId: v.id } });
      await tx.productVariant.delete({ where: { id: v.id } });
      // Its design, when this was the last colour on it and the boutique made it.
      const left = await tx.productVariant.count({ where: { productId: v.productId } });
      if (left === 0 && (v.product.priceOwner === 'BOUTIQUE' || v.product.importKey?.startsWith('boutique'))) {
        const more = await tx.productImage.findMany({ where: { productId: v.productId }, select: { storagePath: true } });
        await tx.$executeRawUnsafe('SAVEPOINT erase_design');
        try {
          await tx.product.delete({ where: { id: v.productId } });
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT erase_design');
          files.push(...more);
        } catch {
          // Something of the shop's still points at the empty design (a reel link, a review): it is binned instead.
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT erase_design');
          await tx.product.update({ where: { id: v.productId }, data: { status: 'TRASHED' as any, trashedAt: new Date(), previousStatus: null, importKey: deletedRef('boutique-deleted', v.id) } });
        }
      }
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT erase_item');
      for (const x of files) if (x.storagePath) photos.push(x.storagePath);
    } catch {
      // The database knows of a record we did not ask about: then it has a past after all, and is kept.
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT erase_item');
      historyKept = true;
    }
  }

  if (historyKept) {
    // Off sale first, the way archiving does it (a colour of a live design moves to a shelf of its own; the last
    // live colour archives the design), so every channel hears exactly what it hears for an archive.
    await archiveColour(tx, actor.clientId, v, touched);
    let now = await tx.productVariant.findUniqueOrThrow({ where: { id: v.id }, include: { product: true } });
    // Alone on its product: an archived design can still hold other colours, and they are not being deleted.
    if (await tx.productVariant.count({ where: { productId: now.productId, id: { not: now.id } } }) > 0) {
      const shelf = await shelfFor(tx, actor.clientId, now.product, itemCode);
      await tx.productVariant.update({ where: { id: now.id }, data: { productId: shelf.id } });
      await carryColour(tx, now.id, shelf.id);
      now = await tx.productVariant.findUniqueOrThrow({ where: { id: v.id }, include: { product: true } });
    }
    if (!touched.has(now.productId)) touched.set(now.productId, onSale(now.product));
    // In the bin, under a key no new design or shelf will ever ask for: a new item with this code starts clean.
    await tx.product.update({ where: { id: now.productId }, data: {
      status: 'TRASHED' as any, trashedAt: now.product.trashedAt ?? new Date(),
      previousStatus: now.product.status === 'TRASHED' ? now.product.previousStatus : now.product.status,
      importKey: deletedRef('boutique-deleted', v.id)
    } });
    await tx.shopifyIdMap.deleteMany({ where: { variantId: v.id } });
    await tx.productVariant.update({ where: { id: v.id }, data: {
      boutiqueDeletedAt: new Date(), boutiqueRef: deletedRef(itemCode, v.id), sku: deletedRef(v.sku, v.id), variantCode: deletedRef(v.variantCode, v.id)
    } });
  }

  return {
    touched, photos,
    answer: {
      itemCode, deleted: true, historyKept,
      ...(writtenOff ? { stockWrittenOff: writtenOff / f, stockWrittenOffText: say(writtenOff) } : {}),
      ...(released ? { holdsReleased: released / f, orderRefs: releasedFor } : {})
    }
  };
}

/** After the change is committed: the shop's channels hear of it, and an erased item's photographs are removed. */
function settle(clientId: string, done: Done) {
  tellShops(clientId, done.touched);
  if (done.photos.length) {
    afterCommit(() => {
      void supabase.storage.from('inventory-images').remove(done.photos)
        .then(({ error }) => { if (error) console.error(`[boutique] could not remove ${done.photos.length} photograph(s) of a deleted item:`, error.message); })
        .catch(err => console.error('[boutique] could not remove a deleted item\'s photographs', err));
    });
  }
}

/** DELETE /items/{itemCode}: delete one item for good. `force` writes off its stock and lets its holds go. */
export async function deleteItem(tx: Db, actor: Actor, itemCode: string, opts: { force?: boolean } = {}) {
  mayDelete(actor);
  const done = await deleteOne(tx, actor, String(itemCode ?? '').trim(), opts.force === true);
  settle(actor.clientId, done);
  return { status: 200, answer: { success: true, data: done.answer } };
}

const codesOf = (raw: unknown): unknown[] => {
  if (!Array.isArray(raw) || raw.length === 0) throw refuse('Send itemCodes: a list of 1 to 200 item codes.', 400, 'BAD_LIST');
  if (raw.length > MAX_AT_ONCE) throw refuse(`At most ${MAX_AT_ONCE} items at once: this list has ${raw.length}. Send it in parts.`, 400, 'TOO_MANY');
  return raw;
};

/**
 * One row of a bulk call, inside its own savepoint: what it did is kept, or -- on a refusal -- undone, and the
 * refusal becomes that row's answer. Anything that is not a refusal (a fault of ours) stops the whole call, changing
 * nothing at all, because a half-finished bulk change nobody can describe is worse than none.
 */
async function eachRow(tx: Db, raw: unknown[], run: (itemCode: string) => Promise<Record<string, unknown>>) {
  const results: Record<string, unknown>[] = [];
  const taken = new Set<string>();
  for (const [i, one] of raw.entries()) {
    const itemCode = typeof one === 'string' ? one.trim() : '';
    if (!itemCode) { results.push({ row: i + 1, itemCode: typeof one === 'string' ? one : null, ok: false, status: 400, code: 'BAD_CODE', message: 'Each entry must be an item code (text).' }); continue; }
    if (taken.has(itemCode)) { results.push({ row: i + 1, itemCode, ok: false, status: 400, code: 'DUPLICATE', message: 'This item code is in the list twice; it was taken once.' }); continue; }
    taken.add(itemCode);
    await tx.$executeRawUnsafe('SAVEPOINT bulk_row');
    try {
      results.push({ row: i + 1, ok: true, ...(await run(itemCode)) });
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT bulk_row');
    } catch (e: any) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bulk_row');
      if (!e?.statusCode) throw e;
      results.push({ row: i + 1, itemCode, ok: false, status: e.statusCode, code: e.details?.code ?? (e.statusCode === 404 ? 'NOT_FOUND' : 'REFUSED'), message: e.message,
        ...(e.details?.blockers ? { blockers: e.details.blockers, canForce: e.details.canForce } : {}) });
    }
  }
  return results;
}

/** POST /items/delete: delete up to 200 items, each on its own. One refusal undoes nothing else. */
export async function deleteItems(tx: Db, actor: Actor, input: { itemCodes?: unknown; force?: unknown }) {
  mayDelete(actor);
  if (input.force !== undefined && typeof input.force !== 'boolean') throw refuse('force is true or false.', 400, 'BAD_FORCE');
  const raw = codesOf(input.itemCodes);
  const settled: Done[] = [];
  const results = await eachRow(tx, raw, async itemCode => {
    const done = await deleteOne(tx, actor, itemCode, input.force === true);
    settled.push(done);
    return done.answer;
  });
  // Only the rows that went through: a rolled-back row must not have its photographs removed.
  for (const done of settled) settle(actor.clientId, done);
  const deleted = results.filter(r => r.ok).length;
  return { status: 200, answer: { success: true, data: { deleted, refused: results.length - deleted, results } } };
}

/** POST /items/{itemCode}/restore: an archived item comes back on sale (only that colour, as with PUT archived:false). */
export async function restoreItem(tx: Db, actor: Actor, itemCode: string) {
  if (!actor.can.includes('products:write')) throw problem('This person may not bring items back.', 403);
  const code = String(itemCode ?? '').trim();
  const v = await tx.productVariant.findFirst({ where: { clientId: actor.clientId, boutiqueRef: code }, select: { id: true } });
  if (!v) throw refuse(`No item ${code} in this shop. (A deleted item cannot be brought back: add it again with PUT.)`, 404, 'NOT_FOUND');
  const r = await upsertItem(tx, actor, { itemCode: code, name: undefined, archived: false });
  return { status: 200, answer: r.answer };
}

/**
 * POST /items/archive: archive (or, with archived:false, bring back) up to 200 items, each on its own.
 * The same thing PUT archived:true / false does to one item, without sending the item again.
 */
export async function archiveItems(tx: Db, actor: Actor, input: { itemCodes?: unknown; archived?: unknown }) {
  if (!actor.can.includes('products:write')) throw problem('This person may not archive items.', 403);
  if (input.archived !== undefined && typeof input.archived !== 'boolean') throw refuse('archived is true (archive) or false (bring back).', 400, 'BAD_ARCHIVED');
  const back = input.archived === false;
  const raw = codesOf(input.itemCodes);
  const results = await eachRow(tx, raw, async itemCode => {
    if (!CODE.test(itemCode)) throw refuse(`"${itemCode}" is not an item code.`, 400, 'BAD_CODE');
    if (back) { await restoreItem(tx, actor, itemCode); return { itemCode, archived: false }; }
    await archiveItem(tx, actor, itemCode);
    return { itemCode, archived: true };
  });
  const done = results.filter(r => r.ok).length;
  return { status: 200, answer: { success: true, data: { [back ? 'restored' : 'archived']: done, refused: results.length - done, results } } };
}
