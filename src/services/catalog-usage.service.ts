import { prisma } from '../lib/prisma';

/**
 * How many products or variants actually use a catalogue entry.
 *
 * This is the number that decides whether deleting "Pink" is safe, so it has to be right --
 * and it has to be cheap, because the settings screen needs it for every entry at once.
 *
 * It used to be a COUNT per entry: `Promise.all(items.map(getUsageCount))`. A typical tenant
 * has 72 catalogue entries, so opening Settings fired 72 simultaneous counts at a connection
 * pool of about 17, against a database on another continent. Same shape as the platform
 * console's front page before it was rewritten, and it degrades the same way -- worse for the
 * shops with the richest catalogue, i.e. the ones using the product most.
 *
 * Seven grouped queries now, one per column that can hold a catalogue value, no matter how
 * many entries there are.
 */

/** Which column each catalogue type is actually stored in. */
const PRODUCT_FIELDS = {
  CATEGORY: 'category',
  PRODUCT_TYPE: 'productType',
  DRESS_TYPE: 'dressType',
  MATERIAL: 'fabric',
  DESIGN_TYPE: 'craft'
} as const;

const VARIANT_FIELDS = {
  SIZE: 'size',
  COLOR: 'colorName'
} as const;

const keyOf = (type: string, value: string) => `${type}:${value}`;

/**
 * Every catalogue value in use by this client, as a map of "TYPE:value" -> count.
 *
 * A value absent from the map is used by nothing. Callers should read it as `?? 0` rather
 * than treating a missing key as unknown -- a grouped query returns no row for a value
 * nothing references, which is exactly a count of zero.
 */
export async function usageCountsForClient(clientId: string): Promise<Map<string, number>> {
  const productGroups = await Promise.all(
    (Object.entries(PRODUCT_FIELDS) as [string, string][]).map(([type, field]) =>
      prisma.product
        .groupBy({ by: [field as any], where: { clientId }, _count: { _all: true } })
        .then(rows => ({ type, field, rows }))
        // One unusable column (an enum that has since changed, say) must not take the whole
        // screen down with it. The previous per-item version swallowed errors the same way.
        .catch(() => ({ type, field, rows: [] as any[] }))
    )
  );

  const variantGroups = await Promise.all(
    (Object.entries(VARIANT_FIELDS) as [string, string][]).map(([type, field]) =>
      prisma.productVariant
        .groupBy({ by: [field as any], where: { clientId }, _count: { _all: true } })
        .then(rows => ({ type, field, rows }))
        .catch(() => ({ type, field, rows: [] as any[] }))
    )
  );

  const counts = new Map<string, number>();
  for (const { type, field, rows } of [...productGroups, ...variantGroups]) {
    for (const row of rows as any[]) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      counts.set(keyOf(type, String(value)), row._count._all);
    }
  }
  return counts;
}

/**
 * The same figure for a single entry, read fresh.
 *
 * Used by delete, which must not act on a number the browser has been holding since the page
 * loaded -- someone else may have used the colour in the meantime.
 */
export async function usageCountFor(clientId: string, type: string, value: string): Promise<number> {
  try {
    const productField = (PRODUCT_FIELDS as Record<string, string>)[type];
    if (productField) {
      return await prisma.product.count({ where: { clientId, [productField]: value } as any });
    }
    const variantField = (VARIANT_FIELDS as Record<string, string>)[type];
    if (variantField) {
      return await prisma.productVariant.count({ where: { clientId, [variantField]: value } as any });
    }
    return 0;
  } catch {
    // A value that cannot even be compared against the column (a stale enum member) is used
    // by nothing, which is the safe reading for everything except delete -- and delete is
    // guarded by the database's own foreign keys underneath this.
    return 0;
  }
}
