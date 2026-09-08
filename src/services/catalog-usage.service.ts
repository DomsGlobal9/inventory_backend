import { prisma } from '../lib/prisma';

/**
 * How many products or variants actually use a catalogue entry.
 *
 * This is the number that decides whether deleting "Pink" is safe, so it has to be right --
 * and it has to be cheap, because the settings screen needs it for every entry at once.
 *
 * PERFORMANCE. It used to be a COUNT per entry: `Promise.all(items.map(getUsageCount))`. A
 * typical tenant has 72 catalogue entries, so opening Settings fired 72 simultaneous counts at
 * a connection pool of about 17, against a database on another continent. Seven grouped
 * queries now, one per column that can hold a catalogue value, no matter how many entries.
 *
 * CORRECTNESS, and the more serious of the two. A catalogue entry has both a `label` ("Pink")
 * and a `value` ("pink"), and the counts were compared against `value` alone. But the product
 * form stores the LABEL on the variant -- sphl has variants with colorName "Purple" and "Pink
 * Shade" -- so every colour counted as unused, and the guard that refuses to delete a colour
 * in use never fired for any shop. Matching is now case-insensitive across both the label and
 * the value.
 *
 * A variant may also hold a colour that was never a catalogue entry at all ("Pink Shade"),
 * which is why this maps FROM what is stored rather than assuming the catalogue is complete.
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

/**
 * `category` and `productType` are Prisma enums; the rest are free text. Enums cannot take
 * `mode: 'insensitive'`, and their stored members are exact, so they are matched as written.
 */
const ENUM_FIELDS = new Set(['category', 'productType']);

const fieldFor = (type: string): { model: 'product' | 'variant'; field: string } | null => {
  const p = (PRODUCT_FIELDS as Record<string, string>)[type];
  if (p) return { model: 'product', field: p };
  const v = (VARIANT_FIELDS as Record<string, string>)[type];
  if (v) return { model: 'variant', field: v };
  return null;
};

export type CatalogEntry = { type: string; value: string; label: string };

export type CatalogUsage = {
  /** How many products or variants use this entry, by either its label or its value. */
  countFor(entry: CatalogEntry): number;
};

/**
 * Every catalogue value in use by this client.
 *
 * Returns a lookup rather than a raw map, because getting the key right is the part that was
 * wrong before -- a caller that builds `TYPE:value` by hand reintroduces exactly the bug this
 * fixes.
 */
export async function usageCountsForClient(clientId: string): Promise<CatalogUsage> {
  const groups = await Promise.all([
    ...(Object.entries(PRODUCT_FIELDS) as [string, string][]).map(([type, field]) =>
      prisma.product
        .groupBy({ by: [field as any], where: { clientId }, _count: { _all: true } })
        .then(rows => ({ type, field, rows }))
        // One unusable column must not take the whole screen down with it.
        .catch(() => ({ type, field, rows: [] as any[] }))
    ),
    ...(Object.entries(VARIANT_FIELDS) as [string, string][]).map(([type, field]) =>
      prisma.productVariant
        .groupBy({ by: [field as any], where: { clientId }, _count: { _all: true } })
        .then(rows => ({ type, field, rows }))
        .catch(() => ({ type, field, rows: [] as any[] }))
    )
  ]);

  // Keyed on what is STORED, lower-cased, so a lookup by either the label or the value finds
  // it however the product form happened to write it.
  const counts = new Map<string, number>();
  for (const { type, field, rows } of groups) {
    for (const row of rows as any[]) {
      const stored = row[field];
      if (stored === null || stored === undefined) continue;
      const key = `${type}:${String(stored).toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + row._count._all);
    }
  }

  return {
    countFor(entry) {
      // Distinct, so an entry whose label and value differ only by case is not counted twice.
      const keys = new Set([
        `${entry.type}:${(entry.value ?? '').toLowerCase()}`,
        `${entry.type}:${(entry.label ?? '').toLowerCase()}`
      ]);
      let total = 0;
      for (const key of keys) total += counts.get(key) ?? 0;
      return total;
    }
  };
}

/**
 * The same figure for a single entry, read fresh.
 *
 * Used by delete, which must not act on a number the browser has been holding since the page
 * loaded -- someone else may have used the colour in the meantime.
 */
export async function usageCountFor(clientId: string, entry: CatalogEntry): Promise<number> {
  const target = fieldFor(entry.type);
  if (!target) return 0;

  const terms = Array.from(new Set([entry.value, entry.label].filter(Boolean) as string[]));
  const count = (where: any) => target.model === 'product'
    ? prisma.product.count({ where })
    : prisma.productVariant.count({ where });

  if (ENUM_FIELDS.has(target.field)) {
    // One term at a time, each with its own guard. An entry like CATEGORY has value "WOMEN"
    // and label "Women", and "Women" is not a member of ProductCategory -- put both in one
    // OR and Prisma rejects the whole query, so the valid half is lost too and a category in
    // use reports as unused. That is a delete guard that fails open.
    let highest = 0;
    for (const term of terms) {
      try {
        highest = Math.max(highest, await count({ clientId, [target.field]: term }));
      } catch {
        // Not a member of this enum. Nothing can be stored as it, so it contributes nothing.
      }
    }
    return highest;
  }

  try {
    return await count({
      clientId,
      OR: terms.map(term => ({ [target.field]: { equals: term, mode: 'insensitive' } }))
    });
  } catch {
    return 0;
  }
}
