/**
 * The boutique (CRM-B) on ScaleEzy Inventory: products and stock only (13 Nov 2026, PLAN-boutique-sync.md §0).
 *
 * The boutique keeps its own screens, orders, billing and pricing. For its items and their stock it calls this,
 * through /api/v1/boutique with a signed service pass naming the person. There is one inventory: what the boutique
 * cuts for a stitching order and what the online shop sells come off the same stock, through the one doorway
 * (applyMovement), with every check it already makes (stock below zero, the smallest cut, a held piece).
 *
 * Every write carries a request id: a repeat gets the first answer and changes nothing (once()).
 */
import { randomBytes, createHash } from 'node:crypto';
import { literal } from '../../utils/likeText';
import { Prisma, StorefrontEventType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { afterCommit } from '../../lib/afterCommit';
import { storefrontEventService } from '../storefront-event.service';
import { inventoryMutationService } from '../inventory-mutation.service';
import { factorOf, isMeasured, KIND_KEYS, storedPrice, pricePerUnit, formatQty, type SoldBy } from '../../lib/units';
import { barcodeOf, mustBeFree, newBarcode } from './barcodes';

export type Actor = { clientId: string; name: string; can: string[] };
export const problem = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode, message });

/*
 * A DELETED item that ScaleEzy keeps for its past records (services/boutique/remove.ts, 17 Nov 2026) carries a "#..."
 * tail on its code. An item code can never contain "#", so a lookup by code misses it and the code is free again.
 * codeOf gives back the code the boutique knew it by, for the movements and reports it is still part of.
 */
export const deletedRef = (code: string, id: string) => `${code}#${id.replace(/-/g, '').slice(0, 12)}`;
export const wasDeleted = (ref: string | null | undefined) => !!ref && ref.includes('#');
export const codeOf = <T extends string | null | undefined>(ref: T): T => (typeof ref === 'string' ? ref.split('#')[0] as T : ref);

/* ── units: the boutique's codes to ours ─────────────────────────────────────────────────────────── */

/** CRM-B `Unit` -> ours. A ROLL is counted as a piece (a whole roll); METER is our METRE (centimetres). */
const UNIT_MAP: Record<string, SoldBy> = {
  METER: 'METRE', METRE: 'METRE', PIECE: 'PIECE', PAIR: 'PAIR', PACKET: 'PACKET', BOX: 'BOX', SET: 'SET',
  KILOGRAM: 'KILOGRAM', GRAM: 'GRAM', STRING: 'STRING', UNIT: 'UNIT', ROLL: 'PIECE'
};
export function soldByOf(boutiqueUnit: unknown): SoldBy {
  const u = String(boutiqueUnit ?? 'PIECE').toUpperCase();
  const m = UNIT_MAP[u];
  if (!m) throw problem(`The unit "${boutiqueUnit}" is not known. Use METER, PIECE, PAIR, PACKET, BOX, SET, KILOGRAM, GRAM, STRING, UNIT or ROLL.`);
  return m;
}

/**
 * A boutique quantity (decimal, up to 3 places: 12.500 m) as our base units (1250 cm), or a plain refusal when it is
 * not a whole number of base units (12.505 m is not whole centimetres; 1.5 buttons is not a whole piece).
 */
export function baseQty(q: unknown, soldBy: SoldBy, what = 'quantity'): number {
  // Blank is not 0: a count sent without its number must not write the stock off (16 Nov review).
  if (q == null || (typeof q === 'string' && q.trim() === '') || (typeof q !== 'number' && typeof q !== 'string')) throw problem(`Give the ${what}.`);
  const n = Number(String(q).trim().replace(',', '.'));
  if (!Number.isFinite(n)) throw problem(`The ${what} is not a number.`);
  const f = factorOf(soldBy);
  const base = Math.round(n * f);
  // CRM-B's own limit (under 1,000,000,000) and safely inside the database's whole numbers, whatever the unit.
  if (Math.abs(base) > 1_000_000_000 || Math.abs(n) >= 1_000_000_000) throw problem(`The ${what} is too large.`);
  if (Math.abs(n * f - base) > 1e-6) {
    throw problem(f === 1 ? `The ${what} must be a whole number (${n} is not).` : `The ${what} must be in whole ${f === 100 ? 'centimetres' : 'grams'} (${n} is not).`);
  }
  return base;
}

/* ── linking and the request ledger ──────────────────────────────────────────────────────────────── */

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Which boutique, if any, this shop is linked to (the owner's Settings card, the Console). */
export async function linkState(clientId: string) {
  const l = await prisma.boutiqueLink.findUnique({ where: { clientId } });
  return l && !l.unlinkedAt ? { linked: true, tenant: l.tenant, shopName: l.shopName, linkedAt: l.linkedAt } : { linked: false };
}

/** A shop made by a boutique's first link (boutique-only): its id starts `boutique-` and nobody ever signs in to it. */
async function isBoutiqueOnlyShop(clientId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  return clientId.startsWith('boutique-') && (await tx.user.count({ where: { clientId } })) === 0;
}

/**
 * The boutique app connects (POST /link). Turning the boutique on for a ScaleEzy shop is ScaleEzy's job (the Platform
 * Console), so this only ever:
 *  - answers "already" for an account that is connected;
 *  - refuses an account ScaleEzy disconnected (it is not quietly given a new shop);
 *  - for a brand-new account, makes its boutique-only shop: an id, one store "Boutique", fabrics on, no logins or emails.
 */
export async function link(input: { tenant: unknown; shopName?: unknown; linkCode?: unknown }) {
  // Always small letters: "Lakshmi-Boutique" from the boutique app and "lakshmi-boutique" typed in the Console are one account.
  const tenant = String(input.tenant ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(tenant)) throw problem('Give the boutique account (tenant) as letters, numbers and dashes.');
  if (input.linkCode) throw problem('Connecting a boutique to an existing ScaleEzy shop is done by ScaleEzy. Ask ScaleEzy to enable the Boutique module for that shop.', 403);
  const existing = await prisma.boutiqueLink.findUnique({ where: { tenant } });
  if (existing && !existing.unlinkedAt) return { clientId: existing.clientId, tenant, linked: 'already' as const };
  if (existing) throw problem('This boutique account was disconnected by ScaleEzy. Contact ScaleEzy to connect it again.', 403);
  let clientId = `boutique-${slug(tenant)}`;
  // Free everywhere: a ScaleEzy client may already be called "boutique-lakshmi" (company "Boutique Lakshmi").
  while (await clientIdInUse(clientId)) clientId = `boutique-${slug(tenant)}-${randomBytes(3).toString('hex')}`;
  try {
    await prisma.$transaction(async tx => {
      await tx.boutiqueLink.create({ data: { clientId, tenant, shopName: input.shopName ? String(input.shopName).slice(0, 120) : null } });
      // Cloth by the metre is how a boutique counts most of its stock.
      // ...and it sells both (27 Nov 2026: said, not left unset for the screens to guess).
      await tx.clientSettings.upsert({ where: { clientId }, create: { clientId, fabricsOn: true, sells: 'BOTH' } as any, update: { fabricsOn: true, sells: 'BOTH' } as any });
      const store = await tx.stockLocation.findFirst({ where: { clientId, active: true } });
      if (!store) await tx.stockLocation.create({ data: { clientId, name: 'Boutique', code: `BTQ-${slug(tenant)}`.slice(0, 40), type: 'STORE' as any, active: true } });
    });
  } catch (e: any) {
    // Two first links at the same moment: the other one made the shop; this is the same link.
    const now = await prisma.boutiqueLink.findUnique({ where: { tenant } });
    if (now && !now.unlinkedAt) return { clientId: now.clientId, tenant, linked: 'already' as const };
    throw e;
  }
  return { clientId, tenant, linked: 'new' as const };
}

/** What the Console shows before enabling: is this boutique account free, already a shop of its own, or taken? */
export async function accountState(tenant: string) {
  const l = await prisma.boutiqueLink.findUnique({ where: { tenant } });
  if (!l) return { tenant, state: 'new' as const };
  if (l.unlinkedAt) return { tenant, state: 'free' as const, wasClientId: l.clientId };
  if (await isBoutiqueOnlyShop(l.clientId)) {
    const items = await prisma.productVariant.count({ where: { clientId: l.clientId, boutiqueRef: { not: null }, boutiqueDeletedAt: null } });
    return { tenant, state: 'boutique-only' as const, clientId: l.clientId, items };
  }
  return { tenant, state: 'taken' as const, clientId: l.clientId };
}

/** Is this boutique account linked to a real ScaleEzy shop (not just its own boutique-only shop)? */
export async function boutiqueTaken(tenant: string) {
  const s = await accountState(tenant);
  return s.state === 'taken';
}

/**
 * What the boutique really holds: these move whole or the switch-on is refused (nothing changed). Anything else that
 * clashes is a derived row (a day's totals) and is dropped. Since 16 Nov a boutique-only shop can also have suppliers,
 * purchase orders, receipts, places and shelves -- dropping those on a clash lost the boutique's buying history.
 */
const MUST_MOVE = [
  'inventory_products', 'inventory_product_variants', 'inventory_stocks', 'inventory_transactions', 'boutique_reservations',
  'inventory_locations', 'suppliers', 'supplier_products', 'purchase_orders', 'purchase_receipts', 'storage_spots', 'spot_stocks',
  // People are never "derived rows": a clash here refuses the switch-on instead of deleting them (17 Nov 2026).
  'customers', 'customer_boutique_profiles'
];

/**
 * Numbers that count per shop (SUP-, PO-, GRN-) would clash with the shop's own, and the shop's counters would later
 * hand out numbers the boutique's rows already have. So before moving, every such row of the boutique gets the next
 * number from the SHOP's counter, and the boutique's counters are dropped; a clashing place code gets a suffix.
 */
async function renumberForMove(tx: Prisma.TransactionClient, fromClientId: string, intoClientId: string) {
  const { generateSequentialCode } = await import('../../utils/codeGenerator');
  for (const s of await tx.supplier.findMany({ where: { clientId: fromClientId }, orderBy: { createdAt: 'asc' }, select: { id: true } })) {
    await tx.supplier.update({ where: { id: s.id }, data: { supplierCode: await generateSequentialCode(intoClientId, 'SUP', 'SUPPLIER', tx as any) } });
  }
  for (const o of await tx.purchaseOrder.findMany({ where: { clientId: fromClientId }, orderBy: { createdAt: 'asc' }, select: { id: true, poNumber: true } })) {
    const poNumber = await generateSequentialCode(intoClientId, 'PO', 'PURCHASE_ORDER', tx as any);
    await tx.purchaseOrder.update({ where: { id: o.id }, data: { poNumber } });
    // Stock rows name their order by number: keep them pointing at it.
    await tx.inventoryTransaction.updateMany({ where: { clientId: fromClientId, referenceType: 'PO', referenceId: o.poNumber }, data: { referenceId: poNumber } });
  }
  for (const r of await tx.purchaseReceipt.findMany({ where: { clientId: fromClientId }, orderBy: { createdAt: 'asc' }, select: { id: true } })) {
    await tx.purchaseReceipt.update({ where: { id: r.id }, data: { receiptNumber: await generateSequentialCode(intoClientId, 'GRN', 'PURCHASE_RECEIPT', tx as any) } });
  }
  await moveCustomers(tx, fromClientId, intoClientId);
  await tx.clientSequence.deleteMany({ where: { clientId: fromClientId } });
  const theirs = new Set((await tx.stockLocation.findMany({ where: { clientId: intoClientId }, select: { code: true } })).map(l => l.code));
  for (const l of await tx.stockLocation.findMany({ where: { clientId: fromClientId }, select: { id: true, code: true } })) {
    if (theirs.has(l.code)) await tx.stockLocation.update({ where: { id: l.id }, data: { code: `${l.code}-B${randomBytes(2).toString('hex')}`.slice(0, 50) } });
  }
}

/**
 * The boutique-only shop's customers (17 Nov 2026: the boutique sends its people, services/boutique/customers.ts).
 *
 * They were not thought of when the move was written: their numbers (CUS-000001...) clash with the shop's own, and a
 * clash on a table outside MUST_MOVE DELETES the boutique-only shop's rows -- every customer gone, and each deletion
 * then told the boutique app to wipe that person. So, before the move:
 *   - a number the shop already has is the same person: the boutique's people on that copy are put on the shop's
 *     customer (which is never changed), and the boutique-only copy goes;
 *   - everyone else gets the shop's next customer number and moves with the rest.
 * A boutique-only copy that somehow has bills, points or addresses of its own is not joined by guesswork: the
 * switch-on is refused, in words, with nothing changed.
 */
async function moveCustomers(tx: Prisma.TransactionClient, fromClientId: string, intoClientId: string) {
  const { generateSequentialCode } = await import('../../utils/codeGenerator');
  const { sameName } = await import('./customers');
  const mine = await tx.customer.findMany({
    where: { clientId: fromClientId }, orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, phone: true, externalCustomerId: true, deletedAt: true,
      _count: { select: { salesOrders: true, loyaltyEntries: true, storeCreditEntries: true, addresses: true, pastPurchases: true } }
    }
  });
  // Out of the way first: the shop's next number (CUS-000007, say) may be one a later boutique customer still holds.
  for (const c of mine) await tx.customer.update({ where: { id: c.id }, data: { customerCode: `MOVING-${c.id}` } });
  for (const c of mine) {
    const twin = c.deletedAt ? null
      : c.phone ? await tx.customer.findFirst({ where: { clientId: intoClientId, phone: c.phone, deletedAt: null }, select: { id: true, name: true } })
        : c.externalCustomerId ? await tx.customer.findFirst({ where: { clientId: intoClientId, externalCustomerId: c.externalCustomerId }, select: { id: true, name: true } })
          : null;
    if (!twin) {
      await tx.customer.update({ where: { id: c.id }, data: { customerCode: await generateSequentialCode(intoClientId, 'CUS', 'CUSTOMER', tx as any) } });
      continue;
    }
    const has = c._count;
    if (has.salesOrders || has.loyaltyEntries || has.storeCreditEntries || has.addresses || has.pastPurchases) {
      throw problem(`The boutique's customer ${c.name} has the same number as the shop's ${twin.name}, and has bills, points or addresses of their own. They cannot be joined automatically. Nothing was changed.`, 409);
    }
    // Their boutique people go onto the shop's customer first, so removing the copy tells nobody to wipe anyone.
    for (const p of await tx.customerBoutiqueProfile.findMany({ where: { clientId: fromClientId, customerId: c.id }, select: { id: true, boutiqueName: true } })) {
      await tx.customerBoutiqueProfile.update({ where: { id: p.id }, data: { customerId: twin.id, nameMatches: sameName(p.boutiqueName, twin.name) } });
    }
    await tx.customer.delete({ where: { id: c.id } });
  }
}

/** Tables a boutique-only shop's rows are NOT moved through: settings, links and logins are handled one by one. */
const NOT_MOVED = new Set(['client_settings', 'boutique_links', 'boutique_link_codes', 'users']);

/**
 * Move everything a boutique-only shop holds -- items, stock, holds, history, places, request records -- into a real
 * ScaleEzy shop, inside the caller's transaction. Refused, before anything moves, when an item code or SKU already
 * exists in the target shop. Derived rows that clash (daily totals and the like) are left behind and removed.
 */
async function absorb(tx: Prisma.TransactionClient, fromClientId: string, intoClientId: string) {
  const clash = await tx.$queryRaw<{ sku: string }[]>`
    SELECT a.sku FROM inventory_product_variants a JOIN inventory_product_variants b ON b.sku = a.sku
    WHERE a.client_id = ${fromClientId} AND b.client_id = ${intoClientId} LIMIT 5`;
  if (clash.length) throw problem(`The shop already has items with the boutique's codes (${clash.map(c => c.sku).join(', ')}). Rename them in one place first.`, 409);
  await renumberForMove(tx, fromClientId, intoClientId);
  const tables = await tx.$queryRaw<{ table_name: string }[]>`
    SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  let moved = 0;
  for (const { table_name: t } of tables) {
    if (NOT_MOVED.has(t)) continue;
    await tx.$executeRawUnsafe('SAVEPOINT absorb_t');
    try {
      moved += await tx.$executeRawUnsafe(`UPDATE "${t}" SET client_id = $1 WHERE client_id = $2`, intoClientId, fromClientId);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT absorb_t');
    } catch {
      // A clash on a derived row (one per shop per day, say): keep the target's, drop the boutique-only shop's.
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT absorb_t');
      if (MUST_MOVE.includes(t)) {
        throw problem(`The boutique's ${t.replace(/_/g, ' ')} could not be moved into the shop. Nothing was changed.`, 409);
      }
      await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE client_id = $1`, fromClientId);
    }
  }
  await tx.clientSettings.deleteMany({ where: { clientId: fromClientId } });
  return moved;
}

/**
 * ScaleEzy turns the Boutique module on for a shop (the Platform Console, or onboarding): the boutique account is
 * connected to this shop at once. An account that has been running as its own boutique-only shop brings everything
 * with it. Refused when the shop already has another boutique, or the account belongs to another real shop.
 */
export async function enableForClient(clientId: string, tenantIn: string, shopName: string | null = null, opts: { handOver?: boolean; freshStoreIds?: string[] } = {}) {
  const r = await linkForClient(clientId, tenantIn, shopName);
  // Only the stores the boutique brought, and the one onboarding has just made, may be tidied away when empty: a
  // shop's own store is never touched, even an empty new branch.
  const candidates = [...r.movedStoreIds, ...(opts.freshStoreIds ?? [])];
  const stores = r.already || !candidates.length ? { removed: [] as string[] } : await tidyEmptyStores(clientId, candidates);
  const handedOver = opts.handOver ? await handOverShop(clientId) : null;
  return { ...r, storesRemoved: stores.removed, ...(handedOver ? { handedOver } : {}) };
}

async function linkForClient(clientId: string, tenantIn: string, shopName: string | null) {
  const tenant = String(tenantIn ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(tenant)) throw problem('The boutique account is letters, numbers and hyphens, like lakshmi-boutique.');
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique-enable|${tenant}`}))`;
    const mine = await tx.boutiqueLink.findUnique({ where: { clientId } });
    if (mine && !mine.unlinkedAt && mine.tenant !== tenant) throw problem(`This shop already uses the boutique "${mine.tenant}". Disable it first.`, 409);
    if (mine && !mine.unlinkedAt && mine.tenant === tenant) return { linked: true, tenant, moved: 0, already: true, movedStoreIds: [] as string[] };
    // Another boutique than the one this shop had before: the old one's people are known by ITS ids, and the new
    // boutique's "C-1" must never be taken for the old boutique's "C-1". The matching rows go; the customers stay.
    if (mine && mine.tenant !== tenant) await tx.customerBoutiqueProfile.deleteMany({ where: { clientId } });
    const theirs = await tx.boutiqueLink.findUnique({ where: { tenant } });
    let moved = 0;
    let movedStoreIds: string[] = [];
    if (theirs && theirs.clientId !== clientId) {
      if (!theirs.unlinkedAt && !(await isBoutiqueOnlyShop(theirs.clientId, tx))) throw problem(`The boutique account "${tenant}" is already used by another shop.`, 409);
      if (await isBoutiqueOnlyShop(theirs.clientId, tx)) {
        movedStoreIds = (await tx.stockLocation.findMany({ where: { clientId: theirs.clientId }, select: { id: true } })).map(s => s.id);
        moved = await absorb(tx, theirs.clientId, clientId);
      }
      await tx.boutiqueLink.delete({ where: { clientId: theirs.clientId } });
    }
    await tx.boutiqueLink.upsert({
      where: { clientId },
      create: { clientId, tenant, shopName: shopName ?? theirs?.shopName ?? null },
      update: { tenant, shopName: shopName ?? theirs?.shopName ?? undefined, unlinkedAt: null, linkedAt: new Date() }
    });
    await tx.clientSettings.upsert({ where: { clientId }, create: { clientId, fabricsOn: true } as any, update: { fabricsOn: true } });
    // The boutique adds fabrics and materials, so a ready-made-only shop now sells both (Add product then asks garment or fabric).
    await tx.clientSettings.updateMany({ where: { clientId, OR: [{ sells: 'READY_MADE' }, { sells: null }] }, data: { sells: 'BOTH' } });
    // The boutique's items are priced by the boutique again (they were the shop's own while it was disabled).
    await tx.product.updateMany({ where: { clientId, importKey: { startsWith: 'boutique:' } }, data: { priceOwner: 'BOUTIQUE' } });
    return { linked: true, tenant, moved, already: false, movedStoreIds };
  }, { timeout: 120_000, maxWait: 15_000 });
}

/** Is anything at all pointing at this store? Every column that can hold a store id, read from the database itself. */
async function storeInUse(tx: Db, storeId: string) {
  const cols = await tx.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name <> 'inventory_locations' AND table_name <> 'online_shops'
       AND column_name ~ '(^|_)location_ids?$' AND column_name NOT LIKE 'shopify_%'`;
  for (const c of cols) {
    const where = c.data_type === 'ARRAY' ? `$1 = ANY("${c.column_name}")` : `"${c.column_name}" = $1`;
    const n = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${c.table_name}" WHERE ${where}`, storeId);
    if (Number(n[0]?.n ?? 0) > 0) return c.table_name;
  }
  return null;
}

/**
 * After a boutique is connected to a shop, an EMPTY store is removed and the shop keeps one main store (code
 * MAIN-STORE) that holds the stock.
 *
 *  - A boutique joining as a new client (23 Nov 2026): onboarding made an empty "Main Store" a moment before the
 *    boutique's own place, stock and all, moved in. The app opens on MAIN-STORE and its Inventory page counts that one
 *    place, so every item read "out of stock" (Jyoti Atelier, live). Now the boutique's place becomes the main store.
 *  - A retail shop taking in an empty boutique test shop (Swathy Reddy, 24 Nov): the boutique's empty "Boutique" place
 *    would have come along as a second store. Now it goes.
 *
 * A store is removed only when nothing at all points to it: no stock, movement, order, price, shelf, till sale, offer,
 * person or website limited to it. The online shop's own list of places is updated. Safe to run again.
 */
export async function tidyEmptyStores(clientId: string, candidateIds: string[]) {
  return prisma.$transaction(async tx => {
    const stores = await tx.stockLocation.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } });
    if (stores.length < 2) return { removed: [] as string[] };
    const used: typeof stores = [], empty: typeof stores = [];
    // Only candidates can count as empty: every other store of the shop is kept whatever it holds.
    for (const s of stores) ((!candidateIds.includes(s.id) || (await storeInUse(tx, s.id))) ? used : empty).push(s);
    // Nothing used anywhere yet: keep the main store (or the oldest) and remove the other empty ones.
    const keep = used.length ? used : [stores.find(s => s.code === 'MAIN-STORE') ?? stores[0]];
    const gone = empty.filter(s => !keep.includes(s));
    if (!gone.length) return { removed: [] as string[] };
    const mainGone = gone.find(s => s.code === 'MAIN-STORE');
    for (const s of gone) {
      await tx.$executeRaw`UPDATE online_shops SET location_ids = array_remove(location_ids, ${s.id}) WHERE client_id = ${clientId}`;
      await tx.stockLocation.delete({ where: { id: s.id } });
    }
    // The shop always keeps a main store: the oldest store still in use, with the main store's address and phone when
    // it has none.
    if (!keep.some(s => s.code === 'MAIN-STORE')) {
      const heir = keep.filter(s => s.active)[0] ?? keep[0];
      await tx.stockLocation.update({
        where: { id: heir.id },
        data: { code: 'MAIN-STORE', ...(heir.address || !mainGone?.address ? {} : { address: mainGone.address }), ...(heir.phone || !mainGone?.phone ? {} : { phone: mainGone.phone }) }
      });
    }
    return { removed: gone.map(s => s.name) };
  }, { timeout: 60_000 });
}

/** Item codes as the boutique app takes them: letters and digits first, then . _ / - , up to 50. */
const ITEM_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$/;

/**
 * "The boutique app runs this whole shop" (24 Nov 2026, Swathy Reddy: the owner works only in the boutique app).
 *
 * The boutique app sees only items with a boutique item code, so products made in Inventory were invisible to it, and
 * sending one of their SKUs from the app would have made a second item. Here every product of the shop is handed to
 * the boutique: each colour/size gets its SKU as its item code (the SKU is unique in the shop; its variant code when
 * the SKU is not a valid item code), prices become the boutique's, and a product with no boutique category gets one
 * from how it is sold (by the piece: FINISHED, by the metre: FABRIC). Stock, orders, customers and history stay
 * exactly where they are. Safe to run again: an item that already has its code is left alone.
 */
export async function handOverShop(clientId: string) {
  const link = await prisma.boutiqueLink.findUnique({ where: { clientId } });
  if (!link || link.unlinkedAt) throw problem('Enable the Boutique module for this shop first.', 409);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique-handover|${clientId}`}))`;
    const taken = new Set((await tx.productVariant.findMany({ where: { clientId, boutiqueRef: { not: null } }, select: { boutiqueRef: true } })).map(v => v.boutiqueRef!.toUpperCase()));
    const todo = await tx.productVariant.findMany({ where: { clientId, boutiqueRef: null, boutiqueDeletedAt: null }, select: { id: true, sku: true, variantCode: true, productId: true }, orderBy: { createdAt: 'asc' } });
    const skipped: string[] = [];
    let coded = 0;
    for (const v of todo) {
      const code = [v.sku, v.variantCode].find(c => c && ITEM_CODE.test(c) && !taken.has(c.toUpperCase()));
      if (!code) { skipped.push(v.sku ?? v.variantCode ?? v.id); continue; }
      await tx.productVariant.update({ where: { id: v.id }, data: { boutiqueRef: code } });
      taken.add(code.toUpperCase());
      coded++;
    }
    const priced = await tx.product.updateMany({ where: { clientId, priceOwner: { not: 'BOUTIQUE' }, variants: { some: { boutiqueRef: { not: null } } } }, data: { priceOwner: 'BOUTIQUE' } });
    await tx.product.updateMany({ where: { clientId, boutiqueCategory: null, soldBy: 'PIECE' }, data: { boutiqueCategory: 'FINISHED' } });
    await tx.product.updateMany({ where: { clientId, boutiqueCategory: null, soldBy: 'METRE' as any }, data: { boutiqueCategory: 'FABRIC' } });
    return { itemsCoded: coded, pricesHanded: priced.count, skipped };
  }, { timeout: 120_000 });
}

/** ScaleEzy turns the Boutique module off: the boutique can no longer reach the shop. Products and stock stay. */
export async function disableForClient(clientId: string) {
  return prisma.$transaction(async tx => {
    const r = await tx.boutiqueLink.updateMany({ where: { clientId, unlinkedAt: null }, data: { unlinkedAt: new Date() } });
    // With no boutique to set them, its items' prices become the shop's to change (until it is enabled again).
    const freed = r.count ? (await tx.product.updateMany({ where: { clientId, priceOwner: 'BOUTIQUE' }, data: { priceOwner: 'INVENTORY' } })).count : 0;
    // Cloth held for its stitching orders goes back on sale: with the boutique gone, nobody could ever cut or release it.
    let holdsFreed = 0;
    if (r.count) {
      const holds = await tx.boutiqueReservation.findMany({ where: { clientId, status: 'ACTIVE' } });
      for (const h of holds) {
        await tx.inventoryStock.updateMany({ where: { variantId: h.variantId, locationId: h.locationId }, data: { reservedQty: { decrement: h.quantity } } });
        await tx.boutiqueReservation.update({ where: { id: h.id }, data: { status: 'RELEASED' } });
        holdsFreed++;
      }
    }
    return { linked: false, changed: r.count > 0, pricesFreed: freed, holdsFreed };
  });
}

/** Is this id used by anything at all: a login, a shop's settings, a store, a product or a boutique link? */
export async function clientIdInUse(clientId: string, db: Db | typeof prisma = prisma) {
  const [links, users, settings, stores, products] = await Promise.all([
    db.boutiqueLink.count({ where: { clientId } }), db.user.count({ where: { clientId } }), db.clientSettings.count({ where: { clientId } }),
    db.stockLocation.count({ where: { clientId } }), db.product.count({ where: { clientId } })
  ]);
  return links + users + settings + stores + products > 0;
}

/** Kept for onboarding's older call: the same as enabling from the Console. */
export async function linkTrusted(tenant: string, clientId: string, shopName: string | null, freshStoreIds: string[] = []) {
  const r = await enableForClient(clientId, tenant, shopName, { freshStoreIds });
  return { linked: true, tenant: r.tenant, moved: r.moved };
}

/** The shop a boutique is linked to, or a refusal. */
export async function linkedShop(tenant: string) {
  const l = await prisma.boutiqueLink.findUnique({ where: { tenant: String(tenant).trim().toLowerCase() } });
  if (!l || l.unlinkedAt) throw problem('This boutique is not linked to a ScaleEzy shop yet.', 403);
  return l.clientId;
}

/**
 * Run a write once per request id. A repeat (a retry over a bad network) gets the first answer and changes nothing.
 * Two copies arriving at the same moment queue on a lock for that id, so the second always sees the first.
 */
export type Db = Prisma.TransactionClient;
const requestIdOk = (requestId: unknown) => {
  const id = String(requestId ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(id)) throw problem('Every change needs a request id (8 to 100 letters, numbers, dots, dashes or colons), new for each change.');
  return id;
};
const PENDING = 102;
const reused = () => problem('This request id was already used for a different change. Use a new request id for a new change; send the same id only to repeat the same change.', 409);
/** A request id's fingerprint: the call and its body, keys in a fixed order, hashed. */
export function fingerprintOf(method: string, path: string, body: unknown) {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(`${method.toUpperCase()} ${path} ${JSON.stringify(stable(body ?? null))}`).digest('hex').slice(0, 40);
}

export async function once<T>(clientId: string, requestId: unknown, run: (tx: Db) => Promise<{ status: number; answer: T }>, fingerprint?: string) {
  const id = requestIdOk(requestId);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique|${clientId}|${id}`}))`;
    const seen = await tx.boutiqueRequest.findUnique({ where: { clientId_requestId: { clientId, requestId: id } } });
    if (seen) {
      if (seen.fingerprint && fingerprint && seen.fingerprint !== fingerprint) throw reused();
      if (seen.status === PENDING) throw problem('This change is still being saved. Ask again in a moment with the same request id.', 409);
      return { status: seen.status, answer: seen.answer as T, repeat: true };
    }
    // A refusal throws and rolls everything back, unrecorded, so the corrected retry can still go through.
    const result = await run(tx);
    await tx.boutiqueRequest.create({ data: { clientId, requestId: id, status: result.status, answer: result.answer as any, fingerprint: fingerprint ?? null } });
    return { ...result, repeat: false };
    // Long batches (100 hold lines, a row with many opening places) on a far database need more than 30 s.
  }, { timeout: 120_000, maxWait: 20_000 });
}

/**
 * For changes made by code that keeps its own transactions (purchase orders, shelves): the request id is claimed
 * first (PENDING), the change runs, then its answer is stored. A retry while it runs is told to wait; a refusal or a
 * crash frees the id; a claim left by a server that stopped mid-change is freed after 5 minutes.
 */
export async function onceOutside<T>(clientId: string, requestId: unknown, fingerprint: string, run: () => Promise<{ status: number; answer: T }>) {
  const id = requestIdOk(requestId);
  const key = { clientId_requestId: { clientId, requestId: id } };
  const claimed = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique|${clientId}|${id}`}))`;
    const seen = await tx.boutiqueRequest.findUnique({ where: key });
    if (seen) {
      if (seen.fingerprint && seen.fingerprint !== fingerprint) throw reused();
      if (seen.status !== PENDING) return { status: seen.status, answer: seen.answer as T, repeat: true };
      if (Date.now() - seen.createdAt.getTime() < 5 * 60_000) throw problem('This change is still being saved. Ask again in a moment with the same request id.', 409);
      await tx.boutiqueRequest.delete({ where: key });
    }
    await tx.boutiqueRequest.create({ data: { clientId, requestId: id, status: PENDING, answer: { pending: true }, fingerprint } });
    return null;
  });
  if (claimed) return claimed;
  try {
    const result = await run();
    await prisma.boutiqueRequest.update({ where: key, data: { status: result.status, answer: result.answer as any } });
    return { ...result, repeat: false };
  } catch (e) {
    await prisma.boutiqueRequest.delete({ where: key }).catch(() => undefined);
    throw e;
  }
}

/* ── items ───────────────────────────────────────────────────────────────────────────────────────── */

export type ItemInput = {
  itemCode: unknown; name: unknown; designGroup?: unknown; kind?: unknown; unit?: unknown;
  color?: unknown; colorHex?: unknown; size?: unknown; widthCm?: unknown;
  sellingPrice?: unknown; purchasePrice?: unknown; gstPercent?: unknown; hsnCode?: unknown;
  imageUrls?: unknown; sellInShop?: unknown;
  /** Sold online too (default true). false: at the till only, not in the online shop, websites or Shopify (26 Nov 2026). */
  sellOnline?: unknown;
  /** Cut cloth of this item may be returned at the till (metre items; 25 Nov 2026). Default false. */
  cutReturnable?: unknown;
  /** The selling price already includes GST (default true). false: GST is added on top -- the till keeps such an item
   * off sale until it is priced including GST (POS's rule). Stored as the product's priceIsExclusive. */
  priceIncludesGst?: unknown;
  /** The boutique's group and sort of thing (CRM-B Category / CatalogItem.item_type), and its other details. */
  category?: unknown; itemType?: unknown; brand?: unknown; materialType?: unknown; reorderLevel?: unknown;
  /** true archives the item, false brings it back on sale, left out keeps it as it is. */
  archived?: unknown;
  /** CRM-B's status words: ACTIVE is archived:false, INACTIVE is archived:true. */
  status?: unknown;
  subCategory?: unknown; description?: unknown; minStock?: unknown; rackLocation?: unknown;
  /** true: only add, never change -- an item code already in use is refused (two people taking the same next code). */
  ifNew?: unknown;
  /** The maker's own barcode, if the item carries one. Left out, a new item gets an SVM barcode of ours. */
  barcode?: unknown;
};

/**
 * Everything a boutique stocks (CRM-B inventory_app): cloth, laces and borders, beads, stones, threads, buttons,
 * packaging, glue, needles, sewing machines -- and the garments it finishes for stock. Its groups, with the unit each
 * is counted in when the boutique does not say (CRM-B DEFAULT_UNIT_BY_CATEGORY).
 */
export const BOUTIQUE_CATEGORIES: Record<string, SoldBy> = {
  FABRIC: 'METRE', BORDER: 'METRE', LINING: 'METRE', EMBELLISHMENT: 'PIECE', STITCHING: 'PIECE', PACKAGING: 'PIECE',
  MAGGAM: 'PIECE', DESIGN: 'PIECE', FINISHED: 'PIECE', OTHER: 'UNIT'
};
/** What can be counted on a shelf. Documents, software and clothing-category headings are not stock. */
export const STOCK_ITEM_TYPES = ['MATERIAL', 'CONSUMABLE', 'TOOL', 'MACHINE', 'ASSET'];
const NOT_STOCK_ITEM_TYPES = ['DOCUMENT', 'SYSTEM', 'PRODUCT_CATEGORY'];
/** Our kind for a boutique group, when the boutique gives a group but no kind. */
const KIND_OF_CATEGORY: Record<string, string> = { FABRIC: 'FABRIC', BORDER: 'BORDER', LINING: 'LINING' };

const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toUpperCase() : null);

/**
 * Add or change one boutique item. One design (designGroup) is one product; each item is a colour of it (a variant)
 * keyed by its item code, so sending the same item again changes it, never duplicates it. Prices are the
 * boutique's (priceOwner BOUTIQUE) and are stored per base unit like every other product.
 */
export async function upsertItem(tx: Db, actor: Actor, input: ItemInput) {
  if (!actor.can.includes('products:write')) throw problem('This person may not add or change items.', 403);
  const itemCode = String(input.itemCode ?? '').trim();
  if (!/^[A-Za-z0-9._/-]{1,50}$/.test(itemCode)) throw problem('Every item needs its item code (letters, numbers, dots, dashes or slashes).');
  // Given = the field was sent (null or "" included, which clears it where clearing makes sense).
  const given = (k: keyof ItemInput) => input[k] !== undefined;

  // The same item code saved twice at the same moment: queued, so the second sees the first -- an update, or
  // "already in use" with ifNew -- never a duplicate-key crash. The design is locked below, once it is known.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique-item|${actor.clientId}|${itemCode}`}))::text`;
  const existing = await tx.productVariant.findFirst({ where: { clientId: actor.clientId, boutiqueRef: itemCode }, include: { product: true } });
  if (existing && input.ifNew === true) throw problem(`${itemCode}: this item code is already in use. Ask for the next code again.`, 409);
  const P: any = existing?.product;

  /*
   * 16 Nov: a field left out of a save KEEPS its value for an item that exists (it used to fall back to the
   * default: a save without sellingPrice set the price to 0, one without unit turned cloth into pieces). The
   * defaults below apply to new items only.
   */
  const name = given('name') ? String(input.name ?? '').trim() : (P?.title ?? '');
  if (!name) throw problem(`${itemCode}: give the item a name.`);
  const askedCategory = input.category ? String(input.category).trim().toUpperCase() : null;
  const category = askedCategory ? (askedCategory in BOUTIQUE_CATEGORIES ? askedCategory : 'OTHER') : (P?.boutiqueCategory ?? null);
  const itemType = input.itemType ? String(input.itemType).trim().toUpperCase() : (P?.itemType ?? 'MATERIAL');
  if (NOT_STOCK_ITEM_TYPES.includes(itemType)) throw problem(`${itemCode}: a ${itemType.toLowerCase().replace('_', ' ')} is not kept as stock, so it is not added here.`);
  if (!STOCK_ITEM_TYPES.includes(itemType)) throw problem(`${itemCode}: the sort of item "${input.itemType}" is not known. Use ${STOCK_ITEM_TYPES.join(', ')}.`);
  const soldBy: SoldBy = input.unit != null && input.unit !== '' ? soldByOf(input.unit) : P ? P.soldBy : soldByOf(category ? BOUTIQUE_CATEGORIES[category] : undefined);
  // A finished garment is ready to wear; cloth, trims and everything used to make one is not a garment yet.
  const productType = askedCategory ? (category === 'FINISHED' ? 'READY_TO_WEAR' : 'UNSTITCHED') : (P?.productType ?? (category === 'FINISHED' ? 'READY_TO_WEAR' : 'UNSTITCHED'));
  const brand = input.brand ? String(input.brand).trim().slice(0, 100) : null;
  const material = input.materialType ? String(input.materialType).trim().slice(0, 100) : null;
  // A kind we do not know yet (the boutique added one) is kept as OTHER rather than refusing the item.
  const askedKind = input.kind ? String(input.kind).trim().toUpperCase().replace(/[\s/-]+/g, '_') : (P ? null : (category ? KIND_OF_CATEGORY[category] ?? null : null));
  const kind = askedKind ? (KIND_KEYS.includes(askedKind) ? askedKind : 'OTHER') : (P ? P.kind : null);
  const kindNote = askedKind && kind !== askedKind ? `The kind "${input.kind}" is not known here yet, so it is kept as Other.` : undefined;
  for (const [k, v] of [['selling price', input.sellingPrice], ['purchase price', input.purchasePrice]] as const) {
    if (v != null && v !== '' && !(Number(v) >= 0 && Number(v) <= 10_000_000)) throw problem(`${itemCode}: the ${k} must be between 0 and 1,00,00,000 rupees.`);
  }
  const unitWord = soldBy === 'METRE' ? 'metre' : soldBy === 'KILOGRAM' ? 'kilogram' : 'unit';
  // Prices are kept per base unit to the paisa: whole rupees a metre (per cm), multiples of 10 rupees a kilogram (per g).
  const priceRule = soldBy === 'METRE' ? 'in whole rupees' : soldBy === 'KILOGRAM' ? 'a multiple of 10 rupees' : 'in rupees, to 2 decimals';
  const priceGiven = input.sellingPrice != null && input.sellingPrice !== '';
  const price = priceGiven ? storedPrice(input.sellingPrice, soldBy) : null;
  if (priceGiven && price === null) throw problem(`${itemCode}: a price per ${unitWord} must be ${priceRule} (${input.sellingPrice} is not).`);
  const cost = input.purchasePrice == null || input.purchasePrice === '' ? null : storedPrice(input.purchasePrice, soldBy);
  if (cost === null && input.purchasePrice != null && input.purchasePrice !== '') throw problem(`${itemCode}: the purchase price per ${unitWord} must be ${priceRule}.`);
  const gst = input.gstPercent == null || input.gstPercent === '' ? null : Math.round(Number(input.gstPercent) * 100);
  if (gst !== null && !(Number.isInteger(gst) && gst >= 0 && gst <= 10000)) throw problem(`${itemCode}: GST must be between 0 and 100%.`);
  const hsn = input.hsnCode ? String(input.hsnCode).trim() : null;
  if (hsn && !/^\d{4}$|^\d{6}$|^\d{8}$/.test(hsn)) throw problem(`${itemCode}: an HSN code is 4, 6 or 8 digits.`);
  const width = input.widthCm == null || input.widthCm === '' ? null : Math.round(Number(input.widthCm));
  if (width !== null && !(width > 0 && width < 1000)) throw problem(`${itemCode}: the width is in centimetres, above 0.`);
  if (given('sellInShop') && typeof input.sellInShop !== 'boolean') throw problem(`${itemCode}: "sellInShop" is true or false.`);
  const sellInShop = typeof input.sellInShop === 'boolean' ? input.sellInShop : (P ? P.sellInShop : false);
  if (given('sellOnline') && typeof input.sellOnline !== 'boolean') throw problem(`${itemCode}: "sellOnline" is true or false.`);
  if (given('cutReturnable') && typeof input.cutReturnable !== 'boolean') throw problem(`${itemCode}: "cutReturnable" is true or false.`);
  if (given('priceIncludesGst') && typeof input.priceIncludesGst !== 'boolean') throw problem(`${itemCode}: "priceIncludesGst" is true or false.`);
  const keptDesign = P ? (P.boutiqueDesign ?? (P.importKey?.startsWith('boutique:') ? P.importKey.slice(9) : null)) : null;
  const design = String(input.designGroup ?? '').trim() || keptDesign || itemCode;
  const importKey = `boutique:${design}`.slice(0, 120);
  const colour = input.color ? String(input.color).trim().slice(0, 50) : (existing?.colorName ?? 'Default');
  const size = input.size ? String(input.size).trim().slice(0, 30) : (existing?.size ?? 'Free');
  const images = Array.isArray(input.imageUrls) ? input.imageUrls.filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 10) : [];

  let wantArchived: unknown = input.archived == null ? null : input.archived;
  if (wantArchived !== null && typeof wantArchived !== 'boolean') throw problem(`${itemCode}: "archived" is true or false.`);
  if (input.status != null && input.status !== '') {
    const st = String(input.status).trim().toUpperCase();
    if (st !== 'ACTIVE' && st !== 'INACTIVE') throw problem(`${itemCode}: the status is ACTIVE or INACTIVE.`);
    const asked = st === 'INACTIVE';
    if (wantArchived !== null && wantArchived !== asked) throw problem(`${itemCode}: "status" and "archived" disagree.`);
    wantArchived = asked;
  }
  const subCategory = input.subCategory ? String(input.subCategory).trim().slice(0, 100) : null;
  const description = input.description ? String(input.description).trim().slice(0, 5000) : null;
  const rack = input.rackLocation ? String(input.rackLocation).trim().slice(0, 100) : null;
  // A barcode can be changed, never taken off: a printed label must keep scanning to something.
  const ownBarcode = barcodeOf(input.barcode, itemCode);

  {
    // Two new colours of one new design saved at the same moment make one design, not two.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique-design|${actor.clientId}|${importKey}`}))::text`;
    // A new code must not be a code the shop already uses for an item of its own (a SKU): that is a clash, said so.
    if (!existing) {
      const taken = await tx.productVariant.findFirst({ where: { clientId: actor.clientId, OR: [{ sku: itemCode.slice(0, 60) }, { variantCode: `BV-${itemCode}`.slice(0, 60) }, { barcode: itemCode }] }, select: { sku: true } });
      if (taken) throw problem(`${itemCode}: the shop already uses this code for an item of its own. Give this item a different code.`, 409);
    }
    // The unit of an existing item: its stock, holds, orders and every stored number are in that unit.
    let convert: ((base: number) => number) | null = null, convertPrice: ((perBase: number) => number) | null = null;
    if (existing && P.soldBy !== soldBy) {
      const own = await tx.inventoryStock.aggregate({ where: { variantId: existing.id }, _sum: { quantity: true, reservedQty: true } });
      if ((own._sum.quantity ?? 0) !== 0 || (own._sum.reservedQty ?? 0) !== 0) throw problem(`${itemCode}: this item already has stock in ${P.soldBy.toLowerCase()}s, so its unit cannot change to ${soldBy.toLowerCase()}.`, 409);
      const siblings = await tx.productVariant.count({ where: { productId: existing.productId, id: { not: existing.id } } });
      const openLines = await tx.purchaseOrderItem.count({ where: { variantId: existing.id, po: { status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] } } } });
      if (siblings || openLines) throw problem(`${itemCode}: its unit cannot change while ${siblings ? 'its design has other colours' : 'a purchase order for it is open'}. Make a new item in the new unit instead.`, 409);
      // Same figure in the item's own unit: 10 m reorder level stays 10 (pieces now), 450 a metre stays 450 a piece.
      const from = factorOf(P.soldBy), to = factorOf(soldBy);
      convert = (base: number) => Math.round((base / from) * to);
      convertPrice = (perBase: number) => Math.round(perBase * from / to * 100) / 100;
    }
    const productData = {
      title: name.slice(0, 200), soldBy, kind, sellInShop, ...(given('sellOnline') ? { sellOnline: input.sellOnline as boolean } : {}), priceOwner: 'BOUTIQUE', productType: productType as any,
      boutiqueCategory: category, itemType, boutiqueDesign: design,
      ...(price !== null ? { basePrice: price } : !existing ? { basePrice: 0 } : convertPrice ? { basePrice: convertPrice(Number(P.basePrice ?? 0)) } : {}),
      ...(given('widthCm') || !existing ? { widthCm: width } : {}),
      ...(given('hsnCode') || !existing ? { hsnCode: hsn } : {}),
      ...(given('gstPercent') || !existing ? { taxRateBps: gst } : {}),
      ...(typeof input.cutReturnable === 'boolean' ? { cutReturnable: input.cutReturnable } : {}),
      ...(typeof input.priceIncludesGst === 'boolean' ? { priceIsExclusive: !input.priceIncludesGst } : {}),
      ...(brand ? { brand } : {}), ...(material ? { fabric: material } : {}),
      ...(subCategory ? { boutiqueSubCategory: subCategory } : {}), ...(description ? { description } : {})
    };
    const touched: Touched = new Map();
    if (existing) touched.set(existing.productId, onSale(existing.product));
    let product: any;
    if (existing && isShelf(existing.product) && existing.product.status === 'ARCHIVED' && wantArchived !== false) {
      // An archived colour lives on a shelf of its own (archiveColour); it is changed there and stays archived.
      product = await tx.product.update({ where: { id: existing.productId }, data: productData as any });
    } else {
      product = await tx.product.findUnique({ where: { clientId_importKey: { clientId: actor.clientId, importKey } } });
      if (product && !touched.has(product.id)) touched.set(product.id, onSale(product));
      if (product && product.soldBy !== soldBy && product.id !== existing?.productId) {
        const has = await tx.inventoryStock.aggregate({ where: { clientId: actor.clientId, variant: { productId: product.id } }, _sum: { quantity: true } });
        if ((has._sum.quantity ?? 0) !== 0) throw problem(`${itemCode}: this design already has stock in ${product.soldBy.toLowerCase()}s, so its unit cannot change to ${soldBy.toLowerCase()}.`, 409);
      }
      if (!product) {
        const code = await newProductCode(tx, actor.clientId);
        // A colour moving to a design that does not exist yet: the new design starts from its old design's price,
        // width, GST and HSN (fields left out keep their values), then anything sent now.
        const carried = P ? { basePrice: P.basePrice ?? 0, widthCm: P.widthCm, hsnCode: P.hsnCode, taxRateBps: P.taxRateBps, brand: P.brand, fabric: P.fabric, description: P.description, boutiqueSubCategory: P.boutiqueSubCategory } : {};
        product = await tx.product.create({ data: { clientId: actor.clientId, importKey, productCode: code, slug: code.toLowerCase(), category: 'WOMEN' as any, status: 'ACTIVE' as any, publishedAt: new Date(), ...carried, ...productData } as any });
      } else {
        product = await tx.product.update({ where: { id: product.id }, data: productData as any });
      }
      // A live colour joining an archived design (a new colour, one brought back, or one moved in) brings the
      // design back -- but only that colour: the design's archived colours go to shelves of their own first.
      const comingIn = !existing || existing.productId !== product.id;
      if (product.status === 'ARCHIVED' && wantArchived !== true && (comingIn || wantArchived === false)) {
        product = await reviveDesign(tx, actor.clientId, product, existing?.id);
      }
    }
    const reorder = input.reorderLevel == null || input.reorderLevel === '' ? null : baseQty(input.reorderLevel, soldBy, 'reorder level');
    if (reorder !== null && reorder < 0) throw problem(`${itemCode}: the reorder level cannot be below 0.`);
    const minimum = input.minStock == null || input.minStock === '' ? null : baseQty(input.minStock, soldBy, 'minimum stock');
    if (minimum !== null && minimum < 0) throw problem(`${itemCode}: the minimum stock cannot be below 0.`);
    if (ownBarcode && ownBarcode !== existing?.barcode) await mustBeFree(tx, actor.clientId, ownBarcode, existing?.id ?? null, itemCode);
    const barcode = ownBarcode ?? (existing?.barcode ? null : await newBarcode(tx));
    const variantData = {
      colorName: colour, size,
      ...(barcode ? { barcode, barcodeType: 'INTERNAL_CODE128' } : {}),
      ...(given('colorHex') || !existing ? { hexCode: hex(input.colorHex) } : {}),
      ...(price !== null ? { sellingPrice: price } : !existing ? { sellingPrice: 0 } : convertPrice ? { sellingPrice: convertPrice(Number(existing.sellingPrice ?? 0)) } : {}),
      ...(cost !== null ? { costPrice: cost } : convertPrice && existing?.costPrice != null ? { costPrice: convertPrice(Number(existing.costPrice)) } : {}),
      ...(reorder !== null ? { reorderLevel: reorder } : convert && existing ? { reorderLevel: convert(existing.reorderLevel ?? 0) } : {}),
      ...(minimum !== null ? { minStock: minimum } : convert && existing?.minStock != null ? { minStock: convert(existing.minStock) } : {}),
      ...(convertPrice && existing ? { averageCost: convertPrice(Number(existing.averageCost ?? 0)) } : {}),
      ...(rack ? { rackNote: rack } : {})
    };
    const variant = existing
      ? await tx.productVariant.update({ where: { id: existing.id }, data: { ...variantData, productId: product.id } as any })
      : await tx.productVariant.create({ data: { clientId: actor.clientId, productId: product.id, boutiqueRef: itemCode, sku: `${itemCode}`.slice(0, 60), variantCode: `BV-${itemCode}`.slice(0, 60), reorderLevel: isMeasured(soldBy) ? 1000 : (itemType === 'MACHINE' || itemType === 'ASSET' ? 0 : 5), ...variantData } as any });
    if (existing && existing.productId !== product.id) {
      await carryColour(tx, existing.id, product.id);
      // A shelf left empty by a colour brought back goes to the bin; archiving it again takes it out.
      if (isShelf(existing.product)) await tx.product.update({ where: { id: existing.productId }, data: { trashedAt: new Date(), previousStatus: existing.product.status } });
      // A design whose last colour moved to another design is archived: a design on sale with no colours is nothing to sell.
      else if (!(await tx.productVariant.count({ where: { productId: existing.productId } }))) await tx.product.update({ where: { id: existing.productId }, data: { status: 'ARCHIVED' as any } });
    }
    if (images.length) {
      const have = new Set((await tx.productImage.findMany({ where: { productId: product.id, variantId: variant.id }, select: { url: true } })).map(i => i.url));
      let order = have.size;
      for (const url of images) if (!have.has(url)) await tx.productImage.create({ data: { productId: product.id, variantId: variant.id, url, imageType: 'GALLERY' as any, orderIndex: order++, isPrimary: order === 1 } });
    }
    if (wantArchived === true) await archiveColour(tx, actor.clientId, variant, touched);
    const now = await tx.productVariant.findUniqueOrThrow({ where: { id: variant.id }, include: { product: true } });
    if (!touched.has(now.productId)) touched.set(now.productId, false);
    tellShops(actor.clientId, touched);
    return { status: existing ? 200 : 201, answer: { success: true, data: { ...itemView(now.product, now), ...(kindNote ? { note: kindNote } : {}) } } };
  }
}

/*
 * Archiving one colour. A colour has no archived mark of its own -- every sales channel (the online shop, the
 * till, Shopify, the feed, reel links) decides on the PRODUCT's status. So an archived colour of a design that
 * still has live colours moves to a "shelf": a one-colour product of its own (import key boutique-archived:<code>),
 * a copy of the design, ARCHIVED. Its stock, holds and history are on the colour, so they go with it. The last
 * live colour of a design archives the design itself. Before 16 Nov a design with two colours could never be
 * archived: the colour stayed on sale and the answer still said archived.
 */
export const SHELF = 'boutique-archived:';
export type Touched = Map<string, boolean>; // product id -> was it on sale before this change
const isShelf = (p: { importKey: string | null }) => !!p.importKey?.startsWith(SHELF);
export const onSale = (p: { status: string; sellInShop: boolean; trashedAt: Date | null }) => p.status === 'ACTIVE' && p.sellInShop && !p.trashedAt;

async function newProductCode(tx: Db, clientId: string) {
  const n = await tx.product.count({ where: { clientId } });
  return `BTQ-${String(n + 1).padStart(5, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** The archived one-colour copy of a design for this colour: made the first time, reused after. */
export async function shelfFor(tx: Db, clientId: string, design: any, ref: string) {
  const key = `${SHELF}${ref}`.slice(0, 120);
  const { id: _id, productCode: _c, slug: _s, importKey: _k, createdAt: _a, updatedAt: _u, status: _st, trashedAt: _t, previousStatus: _p, ...details } = design;
  const found = await tx.product.findUnique({ where: { clientId_importKey: { clientId, importKey: key } } });
  if (found) return tx.product.update({ where: { id: found.id }, data: { ...details, status: 'ARCHIVED' as any, trashedAt: null, previousStatus: null } });
  const code = await newProductCode(tx, clientId);
  return tx.product.create({ data: { ...details, clientId, importKey: key, productCode: code, slug: code.toLowerCase(), status: 'ARCHIVED' as any } });
}

/** A colour changed product: its photos go with it, and its Shopify link is dropped (the next push puts it right). */
export async function carryColour(tx: Db, variantId: string, productId: string) {
  await tx.productImage.updateMany({ where: { variantId }, data: { productId } });
  await tx.shopifyIdMap.deleteMany({ where: { variantId } });
}

export async function archiveColour(tx: Db, clientId: string, seen: { id: string; productId: string }, touched: Touched): Promise<void> {
  // The design is locked first, then read again: two of its last colours archived at the same moment would
  // otherwise each see the other still live, both move to shelves, and leave an empty design on sale.
  await tx.$queryRaw`SELECT id FROM inventory_products WHERE id = ${seen.productId} FOR UPDATE`;
  const v = await tx.productVariant.findUniqueOrThrow({ where: { id: seen.id }, include: { product: true } });
  if (v.productId !== seen.productId) return archiveColour(tx, clientId, v, touched); // it moved while we waited
  if (v.product.status === 'ARCHIVED') return; // already archived: nothing to do, and the answer is the same
  if (!touched.has(v.productId)) touched.set(v.productId, onSale(v.product));
  const others = await tx.productVariant.count({ where: { productId: v.productId, id: { not: v.id } } });
  if (others === 0) {
    await tx.product.update({ where: { id: v.productId }, data: { status: 'ARCHIVED' as any } });
    return;
  }
  const shelf = await shelfFor(tx, clientId, v.product, v.boutiqueRef ?? v.id);
  touched.set(shelf.id, false);
  await tx.productVariant.update({ where: { id: v.id }, data: { productId: shelf.id } });
  await carryColour(tx, v.id, shelf.id);
}

/** An archived design comes back for one colour: every other colour on it is still archived, so each gets a shelf. */
async function reviveDesign(tx: Db, clientId: string, design: any, keepId?: string) {
  const rest = await tx.productVariant.findMany({ where: { productId: design.id, ...(keepId ? { id: { not: keepId } } : {}) }, select: { id: true, boutiqueRef: true } });
  for (const o of rest) {
    const shelf = await shelfFor(tx, clientId, design, o.boutiqueRef ?? o.id);
    await tx.productVariant.update({ where: { id: o.id }, data: { productId: shelf.id } });
    await carryColour(tx, o.id, shelf.id);
  }
  return tx.product.update({ where: { id: design.id }, data: { status: 'ACTIVE' as any } });
}

/** Once the change has committed, the shop's other channels hear about every design it touched that is or was on sale. */
export function tellShops(clientId: string, touched: Touched) {
  afterCommit(() => {
    void (async () => {
      for (const [productId, was] of touched) {
        const p = await prisma.product.findUnique({ where: { id: productId }, select: { status: true, sellInShop: true, trashedAt: true, sellOnline: true } });
        // The online channels: switched to till only, it leaves them like a product off sale (PLAN-sell-online.md).
        const is = !!p && onSale(p as any) && p.sellOnline !== false;
        if (!was && !is) continue; // materials, and archived on both sides: no channel ever had it
        await storefrontEventService.productChanged(clientId, productId, is ? StorefrontEventType.PRODUCT_UPDATED : StorefrontEventType.PRODUCT_UNPUBLISHED);
      }
    })().catch(err => console.error('[boutique] could not tell the shop channels', err));
  });
}

/**
 * Archive an item: it stops being sold and offered, but stays for its history and any open order.
 * POST /items/{itemCode}/archive (and PUT archived:true). Until 17 Nov 2026 this was also what DELETE did; DELETE now
 * deletes (services/boutique/remove.ts).
 */
export async function archiveItem(tx: Db, actor: Actor, itemCode: string) {
  if (!actor.can.includes('products:write')) throw problem('This person may not archive items.', 403);
  const v = await tx.productVariant.findFirst({ where: { clientId: actor.clientId, boutiqueRef: itemCode }, include: { product: true } });
  if (!v) throw problem(`No item ${itemCode} in this shop.`, 404);
  const touched: Touched = new Map();
  await archiveColour(tx, actor.clientId, v, touched);
  tellShops(actor.clientId, touched);
  return { status: 200, answer: { success: true, data: { itemCode, archived: true } } };
}

type StockRow = { locationId: string; quantity: number; reservedQty: number; location?: { name: string } | null };
type ItemExtra = { stocks: StockRow[]; heldForOrders: number; images?: string[]; supplier?: { id: string; name: string } | null };

/**
 * One item as the boutique sees it. With `extra`, its stock: the total, per place, what is held -- split into the
 * boutique's own holds for stitching orders and what the shop holds for its online orders -- what is free, and the
 * reorder flags (free at or below the reorder level; free below the minimum stock).
 */
export function itemView(p: any, v: any, extra?: ItemExtra) {
  const f = factorOf(p.soldBy);
  const base = {
    itemCode: v.boutiqueRef, productCode: p.productCode, name: p.title, kind: p.kind, unit: p.soldBy,
    colour: v.colorName, colourHex: v.hexCode, size: v.size, widthCm: p.widthCm,
    sellingPrice: pricePerUnit(Number(v.sellingPrice ?? p.basePrice ?? 0), p.soldBy),
    purchasePrice: v.costPrice != null ? pricePerUnit(Number(v.costPrice), p.soldBy) : null,
    gstPercent: p.taxRateBps != null ? p.taxRateBps / 100 : null, hsnCode: p.hsnCode ?? null,
    priceIncludesGst: p.priceIsExclusive !== true, cutReturnable: p.cutReturnable === true,
    // The owner may put an item in ScaleEzy's bin: it is off sale there, so it is IN_BIN here, whatever its status was.
    sellInShop: p.sellInShop, sellOnline: p.sellOnline !== false, status: p.trashedAt ? 'IN_BIN' : p.status, inBin: !!p.trashedAt, category: p.boutiqueCategory ?? null, subCategory: p.boutiqueSubCategory ?? null,
    itemType: p.itemType ?? null, productType: p.productType, designGroup: p.boutiqueDesign ?? (p.importKey?.startsWith('boutique:') ? p.importKey.slice(9) : null),
    description: p.description ?? null, brand: p.brand ?? null, materialType: p.fabric ?? null,
    reorderLevel: (v.reorderLevel ?? 0) / f, minStock: v.minStock != null ? v.minStock / f : null, rackLocation: v.rackNote ?? null,
    barcode: v.barcode ?? null
  };
  if (!extra) return base;
  const quantity = extra.stocks.reduce((n, s) => n + s.quantity, 0);
  const reserved = extra.stocks.reduce((n, s) => n + s.reservedQty, 0);
  const free = quantity - reserved;
  return {
    ...base,
    ...(extra.images ? { imageUrls: extra.images } : {}),
    supplier: extra.supplier ?? null,
    stock: quantity / f, reserved: reserved / f, free: free / f, stockText: formatQty(quantity, p.soldBy),
    heldForOrders: extra.heldForOrders / f, heldByShop: Math.max(0, reserved - extra.heldForOrders) / f,
    outOfStock: free <= 0, reorderDue: free <= (v.reorderLevel ?? 0), belowMinimum: v.minStock != null && free < v.minStock,
    byLocation: extra.stocks.filter(s => s.quantity !== 0 || s.reservedQty !== 0).map(s => ({
      locationId: s.locationId, name: s.location?.name ?? null, stock: s.quantity / f, reserved: s.reservedQty / f, free: (s.quantity - s.reservedQty) / f
    }))
  };
}

/** Each of these colours' stock, photos and the boutique's own active holds, for itemView. */
async function extrasFor(clientId: string, variantIds: string[]) {
  if (!variantIds.length) return new Map<string, ItemExtra>();
  const [stocks, holds, images, suppliers] = await Promise.all([
    prisma.inventoryStock.findMany({ where: { variantId: { in: variantIds } }, include: { location: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
    prisma.boutiqueReservation.groupBy({ by: ['variantId'], where: { clientId, variantId: { in: variantIds }, status: 'ACTIVE' }, _sum: { quantity: true } }),
    prisma.productImage.findMany({ where: { variantId: { in: variantIds } }, orderBy: [{ orderIndex: 'asc' }], select: { variantId: true, url: true } }),
    // The item's supplier: the preferred link (set by the boutique, or the shop's own choice).
    prisma.supplierProduct.findMany({ where: { variantId: { in: variantIds }, isPreferred: true }, select: { variantId: true, supplier: { select: { id: true, name: true } } } })
  ]);
  const out = new Map<string, ItemExtra>();
  for (const id of variantIds) out.set(id, { stocks: [], heldForOrders: 0, images: [] });
  for (const s of stocks) out.get(s.variantId)!.stocks.push(s as any);
  for (const h of holds) out.get(h.variantId)!.heldForOrders = h._sum.quantity ?? 0;
  for (const i of images) out.get(i.variantId!)?.images!.push(i.url);
  for (const sp of suppliers) { const e = out.get(sp.variantId); if (e && !e.supplier) e.supplier = sp.supplier; }
  return out;
}

/** Items with their stock (all stores), searched by name or code, a page at a time. */
/** Items per page when the boutique does not say (16 Nov: the boutique team asked for 20). At most 100. */
export const ITEMS_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
const wholeAtLeast1 = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? n : null; };

/**
 * The boutique's items, a page at a time: 20 a page unless `limit` says otherwise (1 to 100), oldest first, with the
 * total and the number of pages, so a screen can draw page buttons. Same items in the same order on every call: ties
 * on the time an item was added (a bulk import adds many in one moment) are broken by its id, so no item ever shows
 * on two pages or on none. A page past the end is an empty page, not an error.
 */
const listOf = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(x => String(x).trim().toUpperCase()).filter(Boolean);
const yes = (v: unknown) => v === true || v === 'true' || v === '1';

/** The colour ids whose free stock (all places) is at or below their reorder level. */
async function reorderDueIds(clientId: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT v.id FROM inventory_product_variants v LEFT JOIN inventory_stocks s ON s.variant_id = v.id
    JOIN inventory_products p ON p.id = v.product_id
    WHERE v.client_id = ${clientId} AND v.boutique_ref IS NOT NULL AND p.trashed_at IS NULL
    GROUP BY v.id, v.reorder_level HAVING COALESCE(SUM(s.quantity - s.reserved_qty), 0) <= v.reorder_level`;
  return rows.map(r => r.id);
}

export type ItemQuery = {
  search?: unknown; page?: unknown; limit?: unknown; itemCode?: unknown; itemCodes?: string[];
  category?: unknown; itemType?: unknown; status?: unknown; reorderDue?: unknown; locationId?: unknown;
};

/** The where-clause every item list and count shares: the boutique's items, narrowed by the filters asked for. */
export async function itemWhere(actor: Actor, q: ItemQuery): Promise<Prisma.ProductVariantWhereInput> {
  const search = String(q.search ?? '').trim().slice(0, 100);
  // Prisma's `contains` is a LIKE that does not escape: "%" or "_" typed would match everything.
  const like = literal(search);
  const categories = listOf(q.category), types = listOf(q.itemType);
  const status = String(q.status ?? '').toUpperCase();
  if (status && !['ACTIVE', 'ARCHIVED', 'IN_BIN'].includes(status)) throw problem('status is ACTIVE, ARCHIVED or IN_BIN.');
  const and: Prisma.ProductVariantWhereInput[] = [];
  if (search) and.push({ OR: [
    { boutiqueRef: { contains: like, mode: 'insensitive' } }, { colorName: { contains: like, mode: 'insensitive' } },
    { product: { title: { contains: like, mode: 'insensitive' } } }
  ] });
  if (categories.length) and.push({ product: { boutiqueCategory: { in: categories } } });
  if (types.length) and.push({ product: { itemType: { in: types } } });
  if (status === 'IN_BIN') and.push({ product: { trashedAt: { not: null } } });
  else if (status) and.push({ product: { status: status as any, trashedAt: null } });
  if (yes(q.reorderDue)) and.push({ id: { in: await reorderDueIds(actor.clientId) } });
  if (q.locationId) and.push({ stocks: { some: { locationId: String(q.locationId), quantity: { gt: 0 } } } });
  return {
    clientId: actor.clientId,
    boutiqueRef: q.itemCodes ? { in: q.itemCodes } : q.itemCode ? String(q.itemCode) : { not: null },
    // A deleted item kept for its records is in no list, whatever is searched for or filtered on.
    boutiqueDeletedAt: null,
    ...(and.length ? { AND: and } : {})
  };
}

/**
 * The boutique's items, a page at a time: 20 a page unless `limit` says otherwise (1 to 100), oldest first, with the
 * total and the number of pages, so a screen can draw page buttons. Same items in the same order on every call: ties
 * on the time an item was added (a bulk import adds many in one moment) are broken by its id, so no item ever shows
 * on two pages or on none. A page past the end is an empty page, not an error.
 * Filters (16 Nov, CRM-B's checklist): search also matches the colour; category and itemType (one or a comma list);
 * status ACTIVE or ARCHIVED; reorderDue=1; locationId (only what has stock there).
 */
export async function listItems(actor: Actor, q: ItemQuery) {
  const limit = Math.min(MAX_PER_PAGE, wholeAtLeast1(q.limit) ?? ITEMS_PER_PAGE);
  const page = wholeAtLeast1(q.page) ?? 1;
  const where = await itemWhere(actor, q);
  const [rows, total] = await Promise.all([
    prisma.productVariant.findMany({ where, include: { product: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
    prisma.productVariant.count({ where })
  ]);
  const extras = await extrasFor(actor.clientId, rows.map(r => r.id));
  const totalPages = Math.ceil(total / limit);
  return {
    items: rows.map(v => itemView(v.product, v, extras.get(v.id))),
    page, limit, total, totalPages, hasMore: page < totalPages
  };
}

/* ── stock ───────────────────────────────────────────────────────────────────────────────────────── */

/** Boutique movement -> our reason and direction. */
const KINDS: Record<string, { reason: any; sign: 1 | -1; perm: string }> = {
  PURCHASE: { reason: 'PURCHASE', sign: 1, perm: 'stock:write' },
  GOODS_RECEIPT: { reason: 'PURCHASE', sign: 1, perm: 'stock:write' },
  STOCK_IN: { reason: 'PURCHASE', sign: 1, perm: 'stock:write' },
  RETURN_UNUSED: { reason: 'MANUAL_ADJUSTMENT', sign: 1, perm: 'stitching:issue' },
  CUSTOMER_RETURN: { reason: 'CUSTOMER_RETURN', sign: 1, perm: 'stock:write' },
  ISSUE: { reason: 'MANUAL_ADJUSTMENT', sign: -1, perm: 'stitching:issue' },
  CONSUME: { reason: 'MANUAL_ADJUSTMENT', sign: -1, perm: 'stitching:issue' },
  WASTE: { reason: 'DAMAGE', sign: -1, perm: 'stitching:issue' },
  DAMAGE: { reason: 'DAMAGE', sign: -1, perm: 'stock:write' },
  SCRAP: { reason: 'DAMAGE', sign: -1, perm: 'stock:write' },
  SALE: { reason: 'SALE', sign: -1, perm: 'stock:write' },
  // CRM-B's own names for the same things
  CONSUMPTION: { reason: 'MANUAL_ADJUSTMENT', sign: -1, perm: 'stitching:issue' },
  RETURN: { reason: 'MANUAL_ADJUSTMENT', sign: 1, perm: 'stitching:issue' },
  SUPPLIER_RETURN: { reason: 'RETURN_TO_VENDOR', sign: -1, perm: 'stock:write' },
  // The quantity a new item starts with (CRM-B's "Opening stock").
  OPENING_STOCK: { reason: 'INITIAL_STOCK', sign: 1, perm: 'stock:write' },
};
/** Going out for an order: with an orderRef these take that order's holds on the item first (CRM-B "from the hold first"). */
const FROM_HOLD_FIRST = new Set(['ISSUE', 'CONSUME', 'CONSUMPTION', 'WASTE']);

/** The order's active holds on this colour at this place give up to `want`, oldest first. Returns how much they gave. */
async function takeFromHolds(tx: Db, clientId: string, variantId: string, locationId: string, orderRef: string, want: number) {
  const holds = await tx.boutiqueReservation.findMany({ where: { clientId, variantId, locationId, orderRef, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  let taken = 0;
  for (const h of holds) {
    if (taken >= want) break;
    const t = Math.min(h.quantity, want - taken);
    taken += t;
    await tx.boutiqueReservation.update({ where: { id: h.id }, data: t === h.quantity ? { status: 'ISSUED' } : { quantity: h.quantity - t } });
  }
  if (taken) await tx.inventoryStock.update({ where: { variantId_locationId: { variantId, locationId } }, data: { reservedQty: { decrement: taken } } });
  return taken;
}

/** Stage, garment and remarks the boutique sends with a movement, kept on the movement row. */
function metaOf(input: { stage?: unknown; garmentRef?: unknown; notes?: unknown }) {
  const m: Record<string, string> = {};
  if (input.stage) m.stage = String(input.stage).trim().slice(0, 60);
  if (input.garmentRef) m.garmentRef = String(input.garmentRef).trim().slice(0, 80);
  if (input.notes) m.remarks = String(input.notes).trim().slice(0, 500);
  return Object.keys(m).length ? m : undefined;
}
export const MOVEMENT_KINDS = Object.keys(KINDS);

export async function variantOf(clientId: string, itemCode: unknown, tx: Prisma.TransactionClient = prisma) {
  const v = await tx.productVariant.findFirst({ where: { clientId, boutiqueRef: String(itemCode ?? '') }, include: { product: true } });
  if (!v) throw problem(`No item ${String(itemCode ?? '')} in this shop. Add it first.`, 404);
  return v;
}
export async function storeOf(clientId: string, locationId: unknown, tx: Prisma.TransactionClient = prisma, allowSwitchedOff = false) {
  if (locationId) {
    const l = await tx.stockLocation.findFirst({ where: { id: String(locationId), clientId } });
    if (!l) throw problem('That store is not in this shop.', 404);
    // A removed place is kept only for its history: nothing goes in or out of it.
    if (!l.active && !allowSwitchedOff) throw problem(`${l.name} has been removed. Choose another place, or add it back first.`, 409);
    return l.id;
  }
  const l = await tx.stockLocation.findFirst({ where: { clientId, active: true }, orderBy: { createdAt: 'asc' } });
  if (!l) throw problem('This shop has no store yet.', 409);
  return l.id;
}


/** One stock movement from the boutique, through the one doorway. Quantity in the item's unit (12.5 m). */
export async function move(tx: Db, actor: Actor, input: { itemCode: unknown; kind: unknown; quantity: unknown; locationId?: unknown; orderRef?: unknown; unitCost?: unknown; notes?: unknown; stage?: unknown; garmentRef?: unknown }) {
  const kind = String(input.kind ?? '').toUpperCase();
  const k = KINDS[kind];
  if (!k) throw problem(`The movement "${input.kind}" is not known. Use ${MOVEMENT_KINDS.join(', ')}.`);
  if (!actor.can.includes(k.perm)) throw problem(`This person may not record ${kind.toLowerCase()} movements.`, 403);
  {
    const v = await variantOf(actor.clientId, input.itemCode, tx);
    const qty = baseQty(input.quantity, v.product.soldBy as SoldBy);
    if (qty <= 0) throw problem('The quantity must be more than 0.');
    const locationId = await storeOf(actor.clientId, input.locationId, tx);
    const orderRef = input.orderRef ? String(input.orderRef).slice(0, 80) : null;
    let fromHold = 0;
    if (k.sign < 0) {
      await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${v.id} FOR UPDATE`;
      const before = await tx.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: v.id, locationId } } });
      // Only what the stock can give: a hold larger than the stock cannot pay out more than is there.
      if (orderRef && FROM_HOLD_FIRST.has(kind)) fromHold = await takeFromHolds(tx, actor.clientId, v.id, locationId, orderRef, Math.min(qty, before?.quantity ?? 0));
      const row = fromHold ? await tx.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: v.id, locationId } } }) : before;
      const free = (row?.quantity ?? 0) - (row?.reservedQty ?? 0);
      if (qty > free) throw problem(`Only ${formatQty(Math.max(0, free), v.product.soldBy)} of ${v.product.title} is free here${row?.reservedQty ? ` (${formatQty(row.reservedQty, v.product.soldBy)} is held for orders)` : ''}.`, 409);
    }
    const unitCost = input.unitCost == null || input.unitCost === '' ? undefined : storedPrice(input.unitCost, v.product.soldBy);
    if (unitCost === null) throw problem('The cost must be in whole rupees per metre for cloth.');
    const r = await inventoryMutationService.applyMovement({
      clientId: actor.clientId, variantId: v.id, locationId, movementType: (k.sign > 0 ? 'IN' : 'OUT') as any, reason: k.reason,
      quantityDelta: k.sign * qty, unitCost: unitCost ?? undefined, referenceType: 'BOUTIQUE', referenceId: orderRef ?? undefined,
      notes: `${kind.toLowerCase().replace('_', ' ')} by ${actor.name}${input.notes ? `: ${String(input.notes).slice(0, 200)}` : ''}`, tx,
      boutique: { kind, orderRef, actorName: actor.name, meta: metaOf(input) }
    });
    const f = factorOf(v.product.soldBy);
    return { status: 200, answer: { success: true, data: { itemCode: v.boutiqueRef, kind, quantity: qty / f, fromHold: fromHold / f, stockHere: (r?.quantity ?? 0) / f, stockText: formatQty(r?.quantity ?? 0, v.product.soldBy) } } };
  }
}

/** A count: the length/number actually found. The difference is recorded as a correction. */
export async function count(tx: Db, actor: Actor, input: { itemCode: unknown; counted: unknown; locationId?: unknown }) {
  if (!actor.can.includes('stock:write')) throw problem('This person may not record counts.', 403);
  {
    const v = await variantOf(actor.clientId, input.itemCode, tx);
    const counted = baseQty(input.counted, v.product.soldBy as SoldBy, 'count');
    if (counted < 0) throw problem('A count cannot be below 0.');
    const locationId = await storeOf(actor.clientId, input.locationId, tx);
    // Locked before reading: a till sale between the read and the write would otherwise land the count on the wrong figure.
    await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${v.id} FOR UPDATE`;
    const row = await tx.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: v.id, locationId } } });
    const delta = counted - (row?.quantity ?? 0);
    if (delta !== 0) {
      await inventoryMutationService.applyMovement({ clientId: actor.clientId, variantId: v.id, locationId, movementType: 'ADJUSTMENT' as any, reason: 'AUDIT_CORRECTION', quantityDelta: delta, referenceType: 'BOUTIQUE', notes: `count by ${actor.name}`, tx, boutique: { kind: 'COUNT', actorName: actor.name } });
    }
    // Fewer found than the boutique holds here: its holds are cut to what is there, newest first, and said so
    // (CRM-B: "the hold is cut to stock and noted"). The shop's own holds for online orders are not touched.
    let holdsCut = 0;
    const mine = await tx.boutiqueReservation.findMany({ where: { clientId: actor.clientId, variantId: v.id, locationId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
    let over = mine.reduce((n, h) => n + h.quantity, 0) - counted;
    for (const h of mine) {
      if (over <= 0) break;
      const cut = Math.min(h.quantity, over);
      over -= cut; holdsCut += cut;
      await tx.boutiqueReservation.update({ where: { id: h.id }, data: cut === h.quantity ? { status: 'RELEASED' } : { quantity: h.quantity - cut } });
    }
    if (holdsCut) await tx.inventoryStock.update({ where: { variantId_locationId: { variantId: v.id, locationId } }, data: { reservedQty: { decrement: holdsCut } } });
    const f = factorOf(v.product.soldBy);
    return { status: 200, answer: { success: true, data: {
      itemCode: v.boutiqueRef, counted: counted / f, difference: delta / f,
      ...(holdsCut ? { holdsCut: holdsCut / f, note: `Fewer were found than were held, so the holds for orders were cut by ${formatQty(holdsCut, v.product.soldBy)}.` } : {})
    } } };
  }
}

/** Move stock between two stores of the shop (to a tailor's place, say). */
export async function transfer(tx: Db, actor: Actor, input: { itemCode: unknown; quantity: unknown; fromLocationId: unknown; toLocationId: unknown; orderRef?: unknown }) {
  if (!['stock:write', 'stitching:issue', 'stock:transfer'].some(c => actor.can.includes(c))) throw problem('This person may not move stock.', 403);
  {
    const v = await variantOf(actor.clientId, input.itemCode, tx);
    const qty = baseQty(input.quantity, v.product.soldBy as SoldBy);
    if (qty <= 0) throw problem('The quantity must be more than 0.');
    const from = await storeOf(actor.clientId, input.fromLocationId, tx);
    const to = await storeOf(actor.clientId, input.toLocationId, tx);
    if (from === to) throw problem('Choose two different stores.');
    const orderRef = input.orderRef ? String(input.orderRef).slice(0, 80) : undefined;
    await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${v.id} FOR UPDATE`;
    /*
     * Cloth held for an order goes to the tailor WITH its hold (16 Nov review): with the order named, that order's
     * holds here travel with the cloth, up to the quantity moved -- a whole hold keeps its id, a part becomes a new
     * hold at the new place. Without it, only free cloth can move (held cloth stays put, refused in words).
     */
    let carry = 0;
    const carried: { reservationId: string; quantity: number }[] = [];
    if (orderRef) {
      const holds = await tx.boutiqueReservation.findMany({ where: { clientId: actor.clientId, variantId: v.id, locationId: from, orderRef, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
      for (const h of holds) {
        if (carry >= qty) break;
        const part = Math.min(h.quantity, qty - carry);
        carry += part;
        if (part === h.quantity) { await tx.boutiqueReservation.update({ where: { id: h.id }, data: { locationId: to } }); carried.push({ reservationId: h.id, quantity: part }); }
        else {
          await tx.boutiqueReservation.update({ where: { id: h.id }, data: { quantity: h.quantity - part } });
          const made = await tx.boutiqueReservation.create({ data: { clientId: actor.clientId, variantId: v.id, locationId: to, orderRef, quantity: part, actorName: actor.name.slice(0, 80) } });
          carried.push({ reservationId: made.id, quantity: part });
        }
      }
      if (carry) await tx.inventoryStock.update({ where: { variantId_locationId: { variantId: v.id, locationId: from } }, data: { reservedQty: { decrement: carry } } });
    }
    const row = await tx.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: v.id, locationId: from } } });
    const free = (row?.quantity ?? 0) - (row?.reservedQty ?? 0);
    if (qty > free) throw problem(`Only ${formatQty(Math.max(0, free), v.product.soldBy)} of ${v.product.title} can move from here${row?.reservedQty ? ` (${formatQty(row.reservedQty, v.product.soldBy)} is held for orders; name the order to move its cloth)` : ''}.`, 409);
    await inventoryMutationService.applyMovement({ clientId: actor.clientId, variantId: v.id, locationId: from, movementType: 'OUT' as any, reason: 'TRANSFER', quantityDelta: -qty, referenceType: 'BOUTIQUE', referenceId: orderRef, notes: `moved by ${actor.name}`, tx, boutique: { kind: 'TRANSFER', orderRef: orderRef ?? null, actorName: actor.name } });
    await inventoryMutationService.applyMovement({ clientId: actor.clientId, variantId: v.id, locationId: to, movementType: 'IN' as any, reason: 'TRANSFER', quantityDelta: qty, referenceType: 'BOUTIQUE', referenceId: orderRef, notes: `moved by ${actor.name}`, tx, boutique: { kind: 'TRANSFER', orderRef: orderRef ?? null, actorName: actor.name } });
    if (carry) await tx.inventoryStock.update({ where: { variantId_locationId: { variantId: v.id, locationId: to } }, data: { reservedQty: { increment: carry } } });
    const f = factorOf(v.product.soldBy);
    return { status: 200, answer: { success: true, data: { itemCode: v.boutiqueRef, moved: qty / f, ...(carried.length ? { holdsMoved: carried.map(c => ({ ...c, quantity: c.quantity / f })) } : {}) } } };
  }
}

/* ── the boutique's places ──────────────────────────────────────────────────────────────────────── */

/** CRM-B StockLocation kinds. A shop floor is a STORE; the workroom places (cutting, tailor...) are WAREHOUSEs. */
const STORE_KINDS: Record<string, 'STORE' | 'WAREHOUSE'> = {
  MAIN_STORE: 'STORE', SHOWROOM: 'STORE', WAREHOUSE: 'WAREHOUSE', WORKSHOP: 'WAREHOUSE', CUTTING_UNIT: 'WAREHOUSE',
  EMBROIDERY_UNIT: 'WAREHOUSE', TAILOR: 'WAREHOUSE', FINISHING_UNIT: 'WAREHOUSE'
};

/** Add one of the boutique's places (a tailor, the cutting unit). The same name again is the same place. */
export async function addStore(tx: Db, actor: Actor, input: { name: unknown; kind?: unknown }) {
  if (!actor.can.includes('stock:write')) throw problem('This person may not add places.', 403);
  const name = String(input.name ?? '').trim().slice(0, 120);
  if (!name) throw problem('Give the place a name.');
  const kind = String(input.kind ?? 'WORKSHOP').toUpperCase();
  const type = STORE_KINDS[kind];
  if (!type) throw problem(`The kind of place "${input.kind}" is not known. Use ${Object.keys(STORE_KINDS).join(', ')}.`);
  const same = await tx.stockLocation.findFirst({ where: { clientId: actor.clientId, name: { equals: name, mode: 'insensitive' } } });
  if (same && !same.active) {
    const back = await tx.stockLocation.update({ where: { id: same.id }, data: { active: true } });
    return { status: 200, answer: { success: true, data: { id: back.id, name: back.name, type: back.type, broughtBack: true } } };
  }
  if (same) return { status: 200, answer: { success: true, data: { id: same.id, name: same.name, type: same.type } } };
  const code = `${kind.slice(0, 3)}-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12)}-${randomBytes(2).toString('hex')}`;
  const l = await tx.stockLocation.create({ data: { clientId: actor.clientId, name, code, type, active: true } });
  return { status: 201, answer: { success: true, data: { id: l.id, name: l.name, type: l.type } } };
}

/* ── holding cloth for a stitching order ─────────────────────────────────────────────────────────── */

/**
 * Hold cloth for a boutique order: it stays on the shelf but the online shop and the till cannot sell it. Refused
 * when not enough is free (in stock and not already held).
 */
export async function reserve(tx: Db, actor: Actor, input: { itemCode: unknown; quantity: unknown; orderRef: unknown; locationId?: unknown; allowShort?: unknown }) {
  if (!actor.can.includes('stitching:issue')) throw problem('This person may not hold cloth for orders.', 403);
  const orderRef = String(input.orderRef ?? '').trim().slice(0, 80);
  if (!orderRef) throw problem('Say which order the cloth is held for.');
  {
    const v = await variantOf(actor.clientId, input.itemCode, tx);
    await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${v.id} FOR UPDATE`;
    const qty = baseQty(input.quantity, v.product.soldBy as SoldBy);
    if (qty <= 0) throw problem('The quantity must be more than 0.');
    const locationId = await storeOf(actor.clientId, input.locationId, tx);
    const row = await tx.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: v.id, locationId } } });
    const free = Math.max(0, (row?.quantity ?? 0) - (row?.reservedQty ?? 0));
    const f = factorOf(v.product.soldBy);
    // allowShort (CRM-B's default at order confirmation): hold what is free and say what is short, instead of refusing.
    const held = input.allowShort === true ? Math.min(qty, free) : qty;
    if (held > free) throw problem(`Only ${formatQty(free, v.product.soldBy)} of ${v.product.title} is free to hold here.`, 409);
    if (held === 0) return { status: 200, answer: { success: true, data: { reservationId: null, itemCode: v.boutiqueRef, orderRef, held: 0, short: qty / f } } };
    await tx.inventoryStock.update({ where: { variantId_locationId: { variantId: v.id, locationId } }, data: { reservedQty: { increment: held } } });
    const res = await tx.boutiqueReservation.create({ data: { clientId: actor.clientId, variantId: v.id, locationId, orderRef, quantity: held, actorName: actor.name.slice(0, 80) } });
    return { status: 201, answer: { success: true, data: { reservationId: res.id, itemCode: v.boutiqueRef, orderRef, held: held / f, short: (qty - held) / f } } };
  }
}

async function heldOne(tx: Prisma.TransactionClient, clientId: string, reservationId: unknown) {
  const seen = await tx.boutiqueReservation.findFirst({ where: { id: String(reservationId ?? ''), clientId } });
  if (!seen) throw problem('That hold was not found.', 404);
  await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${seen.variantId} FOR UPDATE`;
  // Read again under the lock: a release and a cut of the same hold at the same moment must not both pay out.
  const r = (await tx.boutiqueReservation.findUnique({ where: { id: seen.id } }))!;
  if (r.status !== 'ACTIVE') throw problem(`That hold is already ${r.status.toLowerCase()}.`, 409);
  return r;
}

/**
 * Let held cloth go back to being sellable: all of it (an order cancelled before cutting), or part (the order needs
 * less). Matches CRM-B's release(item, quantity): a hold shrinks; it ends only when nothing is left in it.
 */
export async function release(tx: Db, actor: Actor, input: { reservationId: unknown; quantity?: unknown }) {
  if (!actor.can.includes('stitching:issue')) throw problem('This person may not release held cloth.', 403);
  {
    const r = await heldOne(tx, actor.clientId, input.reservationId);
    const v = await tx.productVariant.findUnique({ where: { id: r.variantId }, include: { product: true } });
    const qty = input.quantity == null ? r.quantity : baseQty(input.quantity, v!.product.soldBy as SoldBy);
    if (qty <= 0 || qty > r.quantity) throw problem(`Release between ${formatQty(1, v!.product.soldBy)} and the ${formatQty(r.quantity, v!.product.soldBy)} held.`);
    const left = r.quantity - qty;
    await tx.inventoryStock.update({ where: { variantId_locationId: { variantId: r.variantId, locationId: r.locationId } }, data: { reservedQty: { decrement: qty } } });
    await tx.boutiqueReservation.update({ where: { id: r.id }, data: left === 0 ? { status: 'RELEASED', quantity: r.quantity } : { quantity: left } });
    const f = factorOf(v!.product.soldBy);
    return { status: 200, answer: { success: true, data: { reservationId: r.id, released: qty / f, stillHeld: left / f, status: left === 0 ? 'RELEASED' : 'ACTIVE' } } };
  }
}

/**
 * Cut held cloth and hand it to the tailor: the stock comes off, recorded as ISSUE on the order. Like CRM-B's
 * issue(item, quantity), cutting can happen in stages: what is not issued stays held for the order, until a later
 * issue or release. `releaseRest: true` ends the hold and puts whatever is left back on sale in the same step.
 */
export async function issueHeld(tx: Db, actor: Actor, input: { reservationId: unknown; quantity?: unknown; releaseRest?: unknown }) {
  if (!actor.can.includes('stitching:issue')) throw problem('This person may not issue cloth.', 403);
  {
    const r = await heldOne(tx, actor.clientId, input.reservationId);
    const v = await tx.productVariant.findUnique({ where: { id: r.variantId }, include: { product: true } });
    const qty = input.quantity == null ? r.quantity : baseQty(input.quantity, v!.product.soldBy as SoldBy);
    if (qty <= 0 || qty > r.quantity) throw problem(`Issue between ${formatQty(1, v!.product.soldBy)} and the ${formatQty(r.quantity, v!.product.soldBy)} held.`);
    const rest = r.quantity - qty;
    const freeRest = input.releaseRest === true;
    await tx.inventoryStock.update({ where: { variantId_locationId: { variantId: r.variantId, locationId: r.locationId } }, data: { reservedQty: { decrement: freeRest ? r.quantity : qty } } });
    // Finished (all cut, or the rest let go): it keeps the quantity that was cut, so GET /holds?all=1 tells the truth.
    await tx.boutiqueReservation.update({ where: { id: r.id }, data: rest === 0 || freeRest ? { status: 'ISSUED', quantity: qty } : { quantity: rest } });
    await inventoryMutationService.applyMovement({ clientId: actor.clientId, variantId: r.variantId, locationId: r.locationId, movementType: 'OUT' as any, reason: 'MANUAL_ADJUSTMENT', quantityDelta: -qty, referenceType: 'BOUTIQUE', referenceId: r.orderRef, notes: `issued by ${actor.name}`, tx, boutique: { kind: 'ISSUE', orderRef: r.orderRef, actorName: actor.name } });
    const f = factorOf(v!.product.soldBy);
    return { status: 200, answer: { success: true, data: {
      reservationId: r.id, issued: qty / f,
      stillHeld: freeRest ? 0 : rest / f, backOnSale: freeRest ? rest / f : 0,
      status: rest === 0 || freeRest ? 'ISSUED' : 'ACTIVE'
    } } };
  }
}

/** An item's movements, newest first, with the boutique's names for them. */
export async function history(actor: Actor, itemCode: string, limit = 50) {
  const v = await variantOf(actor.clientId, itemCode);
  const rows = await prisma.inventoryTransaction.findMany({ where: { clientId: actor.clientId, variantId: v.id }, include: { location: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: Math.min(200, Math.max(1, limit)) });
  return rows.map(t => movementView(t, v.boutiqueRef, v.product.soldBy));
}

/** Where a movement came from, in the boutique's words: its own calls, or ScaleEzy (till, online shop, Shopify, the owner). */
export function sourceOf(t: { referenceType: string | null; reason: string; boutiqueKind?: string | null }) {
  if (t.referenceType === 'BOUTIQUE' || t.boutiqueKind) return 'BOUTIQUE';
  if (t.referenceType === 'ORDER' || t.referenceType === 'DISPATCH' || t.reason === 'SALE') return 'SCALEEZY_SALE';
  if (t.referenceType === 'SALES_RETURN' || t.reason === 'CUSTOMER_RETURN') return 'SCALEEZY_RETURN';
  if (t.referenceType === 'PO' || t.reason === 'PURCHASE_RECEIPT' || t.reason === 'SUPPLIER_DELIVERY') return 'SCALEEZY_PURCHASE';
  return 'SCALEEZY';
}

/** One movement row, quantities in the item's unit, with stock before and after at that place. */
export function movementView(t: any, itemCode: string | null, soldBy: string) {
  const f = factorOf(soldBy as SoldBy);
  const meta = (t.metadata && typeof t.metadata === 'object') ? t.metadata as Record<string, unknown> : {};
  return {
    // A movement of an item since deleted still answers, under the code it had, and says so.
    id: t.id, at: t.createdAt, itemCode: codeOf(itemCode), ...(wasDeleted(itemCode) ? { itemDeleted: true } : {}), kind: t.boutiqueKind ?? t.reason, source: sourceOf(t),
    quantity: t.quantity / f, stockBefore: t.balanceBefore / f, stockAfter: t.balanceAfter / f,
    locationId: t.locationId, location: t.location?.name ?? null,
    orderRef: t.boutiqueOrderRef ?? null, stage: meta.stage ?? null, garmentRef: meta.garmentRef ?? null,
    by: t.actorName ?? (t.referenceType === 'BOUTIQUE' ? null : 'ScaleEzy'), remarks: meta.remarks ?? null, notes: t.notes ?? null
  };
}
