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
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { inventoryMutationService } from '../inventory-mutation.service';
import { factorOf, isMeasured, KIND_KEYS, storedPrice, pricePerUnit, formatQty, type SoldBy } from '../../lib/units';

export type Actor = { clientId: string; name: string; can: string[] };
const problem = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode, message });

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
  const n = Number(String(q ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n)) throw problem(`The ${what} is not a number.`);
  const f = factorOf(soldBy);
  const base = Math.round(n * f);
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
      await tx.clientSettings.upsert({ where: { clientId }, create: { clientId, fabricsOn: true } as any, update: { fabricsOn: true } });
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
    const items = await prisma.productVariant.count({ where: { clientId: l.clientId, boutiqueRef: { not: null } } });
    return { tenant, state: 'boutique-only' as const, clientId: l.clientId, items };
  }
  return { tenant, state: 'taken' as const, clientId: l.clientId };
}

/** Is this boutique account linked to a real ScaleEzy shop (not just its own boutique-only shop)? */
export async function boutiqueTaken(tenant: string) {
  const s = await accountState(tenant);
  return s.state === 'taken';
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
      if (['inventory_products', 'inventory_product_variants', 'inventory_stocks', 'inventory_transactions', 'boutique_reservations'].includes(t)) {
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
export async function enableForClient(clientId: string, tenantIn: string, shopName: string | null = null) {
  const tenant = String(tenantIn ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(tenant)) throw problem('The boutique account is letters, numbers and hyphens, like lakshmi-boutique.');
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique-enable|${tenant}`}))`;
    const mine = await tx.boutiqueLink.findUnique({ where: { clientId } });
    if (mine && !mine.unlinkedAt && mine.tenant !== tenant) throw problem(`This shop already uses the boutique "${mine.tenant}". Disable it first.`, 409);
    if (mine && !mine.unlinkedAt && mine.tenant === tenant) return { linked: true, tenant, moved: 0, already: true };
    const theirs = await tx.boutiqueLink.findUnique({ where: { tenant } });
    let moved = 0;
    if (theirs && theirs.clientId !== clientId) {
      if (!theirs.unlinkedAt && !(await isBoutiqueOnlyShop(theirs.clientId, tx))) throw problem(`The boutique account "${tenant}" is already used by another shop.`, 409);
      if (await isBoutiqueOnlyShop(theirs.clientId, tx)) moved = await absorb(tx, theirs.clientId, clientId);
      await tx.boutiqueLink.delete({ where: { clientId: theirs.clientId } });
    }
    await tx.boutiqueLink.upsert({
      where: { clientId },
      create: { clientId, tenant, shopName: shopName ?? theirs?.shopName ?? null },
      update: { tenant, shopName: shopName ?? theirs?.shopName ?? undefined, unlinkedAt: null, linkedAt: new Date() }
    });
    await tx.clientSettings.upsert({ where: { clientId }, create: { clientId, fabricsOn: true } as any, update: { fabricsOn: true } });
    // The boutique adds fabrics and materials, so a ready-made-only shop now sells both (Add product then asks garment or fabric).
    await tx.clientSettings.updateMany({ where: { clientId, sells: 'READY_MADE' }, data: { sells: 'BOTH' } });
    // The boutique's items are priced by the boutique again (they were the shop's own while it was disabled).
    await tx.product.updateMany({ where: { clientId, importKey: { startsWith: 'boutique:' } }, data: { priceOwner: 'BOUTIQUE' } });
    return { linked: true, tenant, moved, already: false };
  }, { timeout: 120_000, maxWait: 15_000 });
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
export async function linkTrusted(tenant: string, clientId: string, shopName: string | null) {
  const r = await enableForClient(clientId, tenant, shopName);
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
export async function once<T>(clientId: string, requestId: unknown, run: (tx: Db) => Promise<{ status: number; answer: T }>) {
  const id = String(requestId ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(id)) throw problem('Every change needs a request id (8 to 100 letters, numbers, dots, dashes or colons), new for each change.');
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boutique|${clientId}|${id}`}))`;
    const seen = await tx.boutiqueRequest.findUnique({ where: { clientId_requestId: { clientId, requestId: id } } });
    if (seen) return { status: seen.status, answer: seen.answer as T, repeat: true };
    // A refusal throws and rolls everything back, unrecorded, so the corrected retry can still go through.
    const result = await run(tx);
    await tx.boutiqueRequest.create({ data: { clientId, requestId: id, status: result.status, answer: result.answer as any } });
    return { ...result, repeat: false };
  }, { timeout: 30_000, maxWait: 15_000 });
}

/* ── items ───────────────────────────────────────────────────────────────────────────────────────── */

export type ItemInput = {
  itemCode: unknown; name: unknown; designGroup?: unknown; kind?: unknown; unit?: unknown;
  color?: unknown; colorHex?: unknown; size?: unknown; widthCm?: unknown;
  sellingPrice?: unknown; purchasePrice?: unknown; gstPercent?: unknown; hsnCode?: unknown;
  imageUrls?: unknown; sellInShop?: unknown;
  /** The boutique's group and sort of thing (CRM-B Category / CatalogItem.item_type), and its other details. */
  category?: unknown; itemType?: unknown; brand?: unknown; materialType?: unknown; reorderLevel?: unknown;
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
  const name = String(input.name ?? '').trim();
  if (!name) throw problem(`${itemCode}: give the item a name.`);
  const askedCategory = input.category ? String(input.category).trim().toUpperCase() : null;
  const category = askedCategory ? (askedCategory in BOUTIQUE_CATEGORIES ? askedCategory : 'OTHER') : null;
  const itemType = input.itemType ? String(input.itemType).trim().toUpperCase() : 'MATERIAL';
  if (NOT_STOCK_ITEM_TYPES.includes(itemType)) throw problem(`${itemCode}: a ${itemType.toLowerCase().replace('_', ' ')} is not kept as stock, so it is not added here.`);
  if (!STOCK_ITEM_TYPES.includes(itemType)) throw problem(`${itemCode}: the sort of item "${input.itemType}" is not known. Use ${STOCK_ITEM_TYPES.join(', ')}.`);
  const soldBy = soldByOf(input.unit ?? (category ? BOUTIQUE_CATEGORIES[category] : undefined));
  // A finished garment is ready to wear; cloth, trims and everything used to make one is not a garment yet.
  const productType = category === 'FINISHED' ? 'READY_TO_WEAR' : 'UNSTITCHED';
  const brand = input.brand ? String(input.brand).trim().slice(0, 100) : null;
  const material = input.materialType ? String(input.materialType).trim().slice(0, 100) : null;
  // A kind we do not know yet (the boutique added one) is kept as OTHER rather than refusing the item.
  const askedKind = input.kind ? String(input.kind).trim().toUpperCase().replace(/[\s/-]+/g, '_') : (category ? KIND_OF_CATEGORY[category] ?? null : null);
  const kind = askedKind && !KIND_KEYS.includes(askedKind) ? 'OTHER' : askedKind;
  const kindNote = askedKind && kind !== askedKind ? `The kind "${input.kind}" is not known here yet, so it is kept as Other.` : undefined;
  const price = input.sellingPrice == null || input.sellingPrice === '' ? 0 : storedPrice(input.sellingPrice, soldBy);
  if (price === null) throw problem(`${itemCode}: a price per ${soldBy === 'METRE' ? 'metre' : 'unit'} must be in whole rupees for this unit (${input.sellingPrice} is not).`);
  const cost = input.purchasePrice == null || input.purchasePrice === '' ? null : storedPrice(input.purchasePrice, soldBy);
  if (cost === null && input.purchasePrice != null && input.purchasePrice !== '') throw problem(`${itemCode}: the purchase price must be in whole rupees per ${soldBy === 'METRE' ? 'metre' : 'unit'}.`);
  const gst = input.gstPercent == null || input.gstPercent === '' ? null : Math.round(Number(input.gstPercent) * 100);
  if (gst !== null && !(Number.isInteger(gst) && gst >= 0 && gst <= 10000)) throw problem(`${itemCode}: GST must be between 0 and 100%.`);
  const hsn = input.hsnCode ? String(input.hsnCode).trim() : null;
  if (hsn && !/^\d{4}$|^\d{6}$|^\d{8}$/.test(hsn)) throw problem(`${itemCode}: an HSN code is 4, 6 or 8 digits.`);
  const width = input.widthCm == null || input.widthCm === '' ? null : Math.round(Number(input.widthCm));
  if (width !== null && !(width > 0 && width < 1000)) throw problem(`${itemCode}: the width is in centimetres, above 0.`);
  const sellInShop = input.sellInShop === true;
  const design = String(input.designGroup ?? '').trim() || itemCode;
  const importKey = `boutique:${design}`.slice(0, 120);
  const colour = input.color ? String(input.color).trim().slice(0, 50) : 'Default';
  const size = input.size ? String(input.size).trim().slice(0, 30) : 'Free';
  const images = Array.isArray(input.imageUrls) ? input.imageUrls.filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 10) : [];

  {
    let product = await tx.product.findUnique({ where: { clientId_importKey: { clientId: actor.clientId, importKey } } });
    if (product && product.soldBy !== soldBy) {
      const has = await tx.inventoryStock.aggregate({ where: { clientId: actor.clientId, variant: { productId: product.id } }, _sum: { quantity: true } });
      if ((has._sum.quantity ?? 0) !== 0) throw problem(`${itemCode}: this design already has stock in ${product.soldBy.toLowerCase()}s, so its unit cannot change to ${soldBy.toLowerCase()}.`, 409);
    }
    const productData = {
      title: name.slice(0, 200), soldBy, kind, widthCm: width, sellInShop, priceOwner: 'BOUTIQUE',
      basePrice: price, hsnCode: hsn, taxRateBps: gst, productType: productType as any,
      boutiqueCategory: category, itemType, ...(brand ? { brand } : {}), ...(material ? { fabric: material } : {})
    };
    if (!product) {
      const n = await tx.product.count({ where: { clientId: actor.clientId } });
      const code = `BTQ-${String(n + 1).padStart(5, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      product = await tx.product.create({ data: { clientId: actor.clientId, importKey, productCode: code, slug: code.toLowerCase(), category: 'WOMEN' as any, status: 'ACTIVE' as any, publishedAt: new Date(), ...productData } as any });
    } else {
      product = await tx.product.update({ where: { id: product.id }, data: productData as any });
    }
    const existing = await tx.productVariant.findFirst({ where: { clientId: actor.clientId, boutiqueRef: itemCode } });
    const reorder = input.reorderLevel == null || input.reorderLevel === '' ? null : baseQty(input.reorderLevel, soldBy, 'reorder level');
    if (reorder !== null && reorder < 0) throw problem(`${itemCode}: the reorder level cannot be below 0.`);
    const variantData = { colorName: colour, hexCode: hex(input.colorHex), size, sellingPrice: price, ...(cost !== null ? { costPrice: cost } : {}), ...(reorder !== null ? { reorderLevel: reorder } : {}) };
    const variant = existing
      ? await tx.productVariant.update({ where: { id: existing.id }, data: { ...variantData, productId: product.id } })
      : await tx.productVariant.create({ data: { clientId: actor.clientId, productId: product.id, boutiqueRef: itemCode, sku: `${itemCode}`.slice(0, 60), variantCode: `BV-${itemCode}`.slice(0, 60), reorderLevel: isMeasured(soldBy) ? 1000 : (itemType === 'MACHINE' || itemType === 'ASSET' ? 0 : 5), ...variantData } as any });
    if (images.length) {
      const have = new Set((await tx.productImage.findMany({ where: { productId: product.id, variantId: variant.id }, select: { url: true } })).map(i => i.url));
      let order = have.size;
      for (const url of images) if (!have.has(url)) await tx.productImage.create({ data: { productId: product.id, variantId: variant.id, url, imageType: 'GALLERY' as any, orderIndex: order++, isPrimary: order === 1 } });
    }
    return { status: existing ? 200 : 201, answer: { success: true, data: { ...itemView(product, variant), ...(kindNote ? { note: kindNote } : {}) } } };
  }
}

/** Archive an item: it stops being sold and offered, but stays for its history and any open order. */
export async function archiveItem(tx: Db, actor: Actor, itemCode: string) {
  if (!actor.can.includes('products:write')) throw problem('This person may not archive items.', 403);
  const v = await tx.productVariant.findFirst({ where: { clientId: actor.clientId, boutiqueRef: itemCode }, include: { product: true } });
  if (!v) throw problem(`No item ${itemCode} in this shop.`, 404);
  const others = await tx.productVariant.count({ where: { productId: v.productId, id: { not: v.id }, boutiqueRef: { not: null } } });
  if (others === 0) await tx.product.update({ where: { id: v.productId }, data: { status: 'ARCHIVED' as any } });
  return { status: 200, answer: { success: true, data: { itemCode, archived: true } } };
}

function itemView(p: any, v: any, stock?: { quantity: number; reserved: number }) {
  return {
    itemCode: v.boutiqueRef, productCode: p.productCode, name: p.title, kind: p.kind, unit: p.soldBy,
    colour: v.colorName, colourHex: v.hexCode, size: v.size, widthCm: p.widthCm,
    sellingPrice: pricePerUnit(Number(v.sellingPrice ?? p.basePrice ?? 0), p.soldBy),
    purchasePrice: v.costPrice != null ? pricePerUnit(Number(v.costPrice), p.soldBy) : null,
    sellInShop: p.sellInShop, status: p.status, category: p.boutiqueCategory ?? null, itemType: p.itemType ?? null, productType: p.productType,
    ...(stock ? { stock: stock.quantity / factorOf(p.soldBy), reserved: stock.reserved / factorOf(p.soldBy), free: (stock.quantity - stock.reserved) / factorOf(p.soldBy), stockText: formatQty(stock.quantity, p.soldBy) } : {})
  };
}

/** Items with their stock (all stores), searched by name or code, a page at a time. */
export async function listItems(actor: Actor, q: { search?: unknown; page?: unknown; limit?: unknown; itemCode?: unknown }) {
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  const search = String(q.search ?? '').trim();
  const where: Prisma.ProductVariantWhereInput = {
    clientId: actor.clientId, boutiqueRef: q.itemCode ? String(q.itemCode) : { not: null },
    ...(search ? { OR: [{ boutiqueRef: { contains: search, mode: 'insensitive' } }, { product: { title: { contains: search, mode: 'insensitive' } } }] } : {})
  };
  const [rows, total] = await Promise.all([
    prisma.productVariant.findMany({ where, include: { product: true, stocks: true }, orderBy: { createdAt: 'asc' }, skip: (page - 1) * limit, take: limit }),
    prisma.productVariant.count({ where })
  ]);
  return { items: rows.map(v => itemView(v.product, v, { quantity: v.stocks.reduce((n, s) => n + s.quantity, 0), reserved: v.stocks.reduce((n, s) => n + s.reservedQty, 0) })), page, limit, total };
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
};
export const MOVEMENT_KINDS = Object.keys(KINDS);

async function variantOf(clientId: string, itemCode: unknown, tx: Prisma.TransactionClient = prisma) {
  const v = await tx.productVariant.findFirst({ where: { clientId, boutiqueRef: String(itemCode ?? '') }, include: { product: true } });
  if (!v) throw problem(`No item ${String(itemCode ?? '')} in this shop. Add it first.`, 404);
  return v;
}
async function storeOf(clientId: string, locationId: unknown, tx: Prisma.TransactionClient = prisma) {
  if (locationId) {
    const l = await tx.stockLocation.findFirst({ where: { id: String(locationId), clientId } });
    if (!l) throw problem('That store is not in this shop.', 404);
    return l.id;
  }
  const l = await tx.stockLocation.findFirst({ where: { clientId, active: true }, orderBy: { createdAt: 'asc' } });
  if (!l) throw problem('This shop has no store yet.', 409);
  return l.id;
}


/** One stock movement from the boutique, through the one doorway. Quantity in the item's unit (12.5 m). */
export async function move(tx: Db, actor: Actor, input: { itemCode: unknown; kind: unknown; quantity: unknown; locationId?: unknown; orderRef?: unknown; unitCost?: unknown; notes?: unknown }) {
  const kind = String(input.kind ?? '').toUpperCase();
  const k = KINDS[kind];
  if (!k) throw problem(`The movement "${input.kind}" is not known. Use ${MOVEMENT_KINDS.join(', ')}.`);
  if (!actor.can.includes(k.perm)) throw problem(`This person may not record ${kind.toLowerCase()} movements.`, 403);
  {
    const v = await variantOf(actor.clientId, input.itemCode, tx);
    const qty = baseQty(input.quantity, v.product.soldBy as SoldBy);
    if (qty <= 0) throw problem('The quantity must be more than 0.');
    const locationId = await storeOf(actor.clientId, input.locationId, tx);
    if (k.sign < 0) {
      await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${v.id} FOR UPDATE`;
      const row = await tx.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: v.id, locationId } } });
      const free = (row?.quantity ?? 0) - (row?.reservedQty ?? 0);
      if (qty > free) throw problem(`Only ${formatQty(Math.max(0, free), v.product.soldBy)} of ${v.product.title} is free here${row?.reservedQty ? ` (${formatQty(row.reservedQty, v.product.soldBy)} is held for orders)` : ''}.`, 409);
    }
    const orderRef = input.orderRef ? String(input.orderRef).slice(0, 80) : null;
    const unitCost = input.unitCost == null || input.unitCost === '' ? undefined : storedPrice(input.unitCost, v.product.soldBy);
    if (unitCost === null) throw problem('The cost must be in whole rupees per metre for cloth.');
    const r = await inventoryMutationService.applyMovement({
      clientId: actor.clientId, variantId: v.id, locationId, movementType: (k.sign > 0 ? 'IN' : 'OUT') as any, reason: k.reason,
      quantityDelta: k.sign * qty, unitCost: unitCost ?? undefined, referenceType: 'BOUTIQUE', referenceId: orderRef ?? undefined,
      notes: `${kind.toLowerCase().replace('_', ' ')} by ${actor.name}${input.notes ? `: ${String(input.notes).slice(0, 200)}` : ''}`, tx,
      boutique: { kind, orderRef, actorName: actor.name }
    });
    return { status: 200, answer: { success: true, data: { itemCode: v.boutiqueRef, kind, quantity: qty / factorOf(v.product.soldBy), stockHere: (r?.quantity ?? 0) / factorOf(v.product.soldBy), stockText: formatQty(r?.quantity ?? 0, v.product.soldBy) } } };
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
    const row = await tx.inventoryStock.findUnique({ where: { variantId_locationId: { variantId: v.id, locationId } } });
    const delta = counted - (row?.quantity ?? 0);
    if (delta !== 0) {
      await inventoryMutationService.applyMovement({ clientId: actor.clientId, variantId: v.id, locationId, movementType: 'ADJUSTMENT' as any, reason: 'AUDIT_CORRECTION', quantityDelta: delta, referenceType: 'BOUTIQUE', notes: `count by ${actor.name}`, tx, boutique: { kind: 'COUNT', actorName: actor.name } });
    }
    return { status: 200, answer: { success: true, data: { itemCode: v.boutiqueRef, counted: counted / factorOf(v.product.soldBy), difference: delta / factorOf(v.product.soldBy) } } };
  }
}

/** Move stock between two stores of the shop (to a tailor's place, say). */
export async function transfer(tx: Db, actor: Actor, input: { itemCode: unknown; quantity: unknown; fromLocationId: unknown; toLocationId: unknown; orderRef?: unknown }) {
  if (!actor.can.includes('stock:write') && !actor.can.includes('stitching:issue')) throw problem('This person may not move stock.', 403);
  {
    const v = await variantOf(actor.clientId, input.itemCode, tx);
    const qty = baseQty(input.quantity, v.product.soldBy as SoldBy);
    if (qty <= 0) throw problem('The quantity must be more than 0.');
    const from = await storeOf(actor.clientId, input.fromLocationId, tx);
    const to = await storeOf(actor.clientId, input.toLocationId, tx);
    if (from === to) throw problem('Choose two different stores.');
    const orderRef = input.orderRef ? String(input.orderRef).slice(0, 80) : undefined;
    await inventoryMutationService.applyMovement({ clientId: actor.clientId, variantId: v.id, locationId: from, movementType: 'OUT' as any, reason: 'TRANSFER', quantityDelta: -qty, referenceType: 'BOUTIQUE', referenceId: orderRef, notes: `moved by ${actor.name}`, tx, boutique: { kind: 'TRANSFER', orderRef: orderRef ?? null, actorName: actor.name } });
    await inventoryMutationService.applyMovement({ clientId: actor.clientId, variantId: v.id, locationId: to, movementType: 'IN' as any, reason: 'TRANSFER', quantityDelta: qty, referenceType: 'BOUTIQUE', referenceId: orderRef, notes: `moved by ${actor.name}`, tx, boutique: { kind: 'TRANSFER', orderRef: orderRef ?? null, actorName: actor.name } });
    return { status: 200, answer: { success: true, data: { itemCode: v.boutiqueRef, moved: qty / factorOf(v.product.soldBy) } } };
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
export async function reserve(tx: Db, actor: Actor, input: { itemCode: unknown; quantity: unknown; orderRef: unknown; locationId?: unknown }) {
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
    const free = (row?.quantity ?? 0) - (row?.reservedQty ?? 0);
    if (qty > free) throw problem(`Only ${formatQty(Math.max(0, free), v.product.soldBy)} of ${v.product.title} is free to hold here.`, 409);
    await tx.inventoryStock.update({ where: { variantId_locationId: { variantId: v.id, locationId } }, data: { reservedQty: { increment: qty } } });
    const res = await tx.boutiqueReservation.create({ data: { clientId: actor.clientId, variantId: v.id, locationId, orderRef, quantity: qty, actorName: actor.name.slice(0, 80) } });
    return { status: 201, answer: { success: true, data: { reservationId: res.id, itemCode: v.boutiqueRef, orderRef, held: qty / factorOf(v.product.soldBy) } } };
  }
}

async function heldOne(tx: Prisma.TransactionClient, clientId: string, reservationId: unknown) {
  const r = await tx.boutiqueReservation.findFirst({ where: { id: String(reservationId ?? ''), clientId } });
  if (!r) throw problem('That hold was not found.', 404);
  if (r.status !== 'ACTIVE') throw problem(`That hold is already ${r.status.toLowerCase()}.`, 409);
  await tx.$queryRaw`SELECT id FROM inventory_product_variants WHERE id = ${r.variantId} FOR UPDATE`;
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
    await tx.boutiqueReservation.update({ where: { id: r.id }, data: rest === 0 || freeRest ? { status: 'ISSUED' } : { quantity: rest } });
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
  const rows = await prisma.inventoryTransaction.findMany({ where: { clientId: actor.clientId, variantId: v.id }, orderBy: { createdAt: 'desc' }, take: Math.min(200, Math.max(1, limit)) });
  const f = factorOf(v.product.soldBy);
  return rows.map((t: any) => ({ at: t.createdAt, kind: t.boutiqueKind ?? t.reason, quantity: t.quantity / f, orderRef: t.boutiqueOrderRef ?? null, by: t.actorName ?? null, notes: t.notes ?? null }));
}
