import { prisma } from '../../lib/prisma';

/**
 * Items the boutique app knows (a colour with a boutique item code) can be changed on ScaleEzy's own screens too.
 *
 * Until 27 Nov 2026 a boutique item was read-only here (name, price, GST, colours...). The owner, 27 Nov: "when we
 * shifted to boutique to manage Swathy Reddy we are unable to change in inventory -- in ours also can able to change".
 * So both sides change them now, and the latest save wins. Each change made here is written to boutique_shop_edits;
 * the boutique app reads them (GET /internal/boutique/items/changed) and updates its own copy, so the two never
 * quietly drift apart. The functions keep their old names so every caller stays as it was.
 */

/** Equal for a person: blank, null and missing are one; numbers by value; text without outer spaces. */
function same(a: unknown, b: unknown) {
  const norm = (v: unknown) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
  const x = norm(a), y = norm(b);
  if (x === null || y === null) return x === y;
  if (x instanceof Date || y instanceof Date) return new Date(x as any).getTime() === new Date(y as any).getTime();
  const nx = Number(x), ny = Number(y);
  if (typeof x !== 'boolean' && typeof y !== 'boolean' && Number.isFinite(nx) && Number.isFinite(ny) && String(x).trim() !== '' && String(y).trim() !== '') return nx === ny;
  return String(x).trim() === String(y).trim();
}

/** Our field -> the boutique API's name for it (what GET /items shows). */
const PRODUCT_FIELDS: Record<string, string> = {
  title: 'name', basePrice: 'sellingPrice', soldBy: 'unit', kind: 'kind', widthCm: 'widthCm', productType: 'productType',
  hsnCode: 'hsnCode', taxRateBps: 'gstPercent', description: 'description', brand: 'brand', fabric: 'materialType',
  sellInShop: 'sellInShop', sellOnline: 'sellOnline', status: 'status', cutReturnable: 'cutReturnable', priceIsExclusive: 'priceIncludesGst'
};
const VARIANT_FIELDS: Record<string, string> = {
  sellingPrice: 'sellingPrice', costPrice: 'purchasePrice', colorName: 'colour', hexCode: 'colourHex', size: 'size',
  reorderLevel: 'reorderLevel', hsnCode: 'hsnCode', taxRateBps: 'gstPercent', barcode: 'barcode'
};

type Db = Pick<typeof prisma, 'boutiqueShopEdit' | 'product' | 'productVariant'>;
type Edit = { variantId: string; itemCode: string };

async function write(db: Db, clientId: string, items: Edit[], kind: 'CHANGED' | 'ADDED' | 'DELETED', fields: string[] | null) {
  if (!items.length) return;
  await db.boutiqueShopEdit.createMany({
    data: items.map(i => ({ clientId, variantId: i.variantId, itemCode: i.itemCode, kind, ...(fields ? { fields } : {}) }))
  });
}

/** The colours of a product that the boutique app knows. */
async function knownColours(db: Db, clientId: string, productId: string): Promise<Edit[]> {
  const rows = await db.productVariant.findMany({ where: { clientId, productId, boutiqueRef: { not: null }, boutiqueDeletedAt: null }, select: { id: true, boutiqueRef: true } });
  return rows.map(r => ({ variantId: r.id, itemCode: r.boutiqueRef! }));
}

/**
 * A product edit made in ScaleEzy: when the product has colours the boutique app knows and a field it shows really
 * changes, the change is noted for each of them. Called before the write; a note for a write that then fails only
 * makes the boutique read an unchanged item again. Never refuses anything.
 */
export async function guardProductPrice(clientId: string, productId: string, data: Record<string, unknown>, db: Db = prisma) {
  const asked = Object.keys(PRODUCT_FIELDS).filter(k => data[k] !== undefined);
  if (!asked.length) return;
  const items = await knownColours(db, clientId, productId);
  if (!items.length) return;
  const p: any = await db.product.findFirst({ where: { id: productId, clientId } });
  if (!p) return;
  const changed = [...new Set(asked.filter(k => !same(data[k], p[k])).map(k => PRODUCT_FIELDS[k]))];
  if (changed.length) await write(db, clientId, items, 'CHANGED', changed);
}

/** A colour edit made in ScaleEzy (one colour, a bulk price update, a file import): noted when the boutique app knows it. */
export async function guardVariantPrice(clientId: string, where: { id?: string; sku?: string }, data: Record<string, unknown>, db: Db = prisma) {
  const asked = Object.keys(VARIANT_FIELDS).filter(k => data[k] !== undefined);
  if (!asked.length) return;
  const v: any = await db.productVariant.findFirst({ where: { clientId, ...where } });
  if (!v?.boutiqueRef || v.boutiqueDeletedAt) return;
  const changed = [...new Set(asked.filter(k => !same(data[k], v[k])).map(k => VARIANT_FIELDS[k]))];
  if (changed.length) await write(db, clientId, [{ variantId: v.id, itemCode: v.boutiqueRef }], 'CHANGED', changed);
}

/** Archive, bin or restore in ScaleEzy: the boutique app sees the item's status change. */
export async function noteProductStatus(clientId: string, productId: string) {
  await write(prisma, clientId, await knownColours(prisma, clientId, productId), 'CHANGED', ['status']);
}

/** Read before a product is deleted for good: afterwards its colours are gone. Call the returned function once it is. */
export async function beforeProductDelete(clientId: string, productId: string) {
  const items = await knownColours(prisma, clientId, productId);
  return () => write(prisma, clientId, items, 'DELETED', null);
}

/**
 * A colour the boutique app knows may be deleted here like any other (no stock, no history, no purchase orders --
 * the usual rules), except while cloth of it is kept for a stitching order in the boutique app.
 * Returns what to note once the delete has gone through.
 */
export async function guardColourDelete(clientId: string, variantId: string) {
  const v = await prisma.productVariant.findFirst({ where: { id: variantId, clientId }, select: { id: true, boutiqueRef: true, boutiqueDeletedAt: true } });
  if (!v?.boutiqueRef || v.boutiqueDeletedAt) return async () => undefined;
  const held = await prisma.boutiqueReservation.count({ where: { clientId, variantId, status: 'ACTIVE' } });
  if (held) throw Object.assign(new Error('Cloth of this colour is kept for a stitching order in your boutique app. Use it or let it go there first, then delete it here.'), { statusCode: 409 });
  const item = { variantId: v.id, itemCode: v.boutiqueRef };
  return () => write(prisma, clientId, [item], 'DELETED', null);
}

/** Colours may be added here to a boutique item too; the boutique app is told (see shareNewWithBoutique). */
export function guardNewColours(_product: { priceOwner?: string | null }) { /* no longer refused (27 Nov 2026) */ }

/** Used by the hand-over and by new colours of a handed-over shop: the boutique app is told they exist. */
export async function noteAdded(db: Db, clientId: string, items: Edit[]) {
  await write(db, clientId, items, 'ADDED', null);
}

/** For a colour that was just given its boutique item code because it belongs to a boutique item. */
export async function noteAddedColour(clientId: string, variantId: string) {
  const v = await prisma.productVariant.findFirst({ where: { id: variantId, clientId }, select: { id: true, boutiqueRef: true } });
  if (v?.boutiqueRef) await write(prisma, clientId, [{ variantId: v.id, itemCode: v.boutiqueRef }], 'ADDED', null);
}
