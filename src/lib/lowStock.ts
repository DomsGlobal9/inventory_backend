/**
 * When a variant counts as low. One definition, in one place.
 *
 * There were two. Most of the product compared stock against the reorder level exactly --
 * the dashboard's count, the product page, the alerts that reach the bell, and reorder
 * suggestions. Two surfaces instead substituted 10 whenever the reorder level was 0: the
 * Inventory Overview badge and filter, and the supplier's item list.
 *
 * So the same variant could read "Low Stock" on one screen and healthy on another. Nothing
 * was visibly wrong only because product creation sets a reorder level of 5 on every
 * variant, so almost nothing is ever 0 -- measured across the platform, one variant out of
 * 270 on the busiest tenant and none at all on the live shop. The bulk importer changes
 * that: a file can now set a reorder level, including 0.
 *
 * The exact rule wins, because the codebase already says what 0 means. reorder.service
 * documents it: "reorderLevel 0 means 'not tracked for reordering'". A shop that sets 0 is
 * saying "do not chase me about this one", and quietly reading that as 10 overrules them --
 * the same mistake the old Math.max(reorderLevel, 10) made, which badged four variants with
 * a reorder level of 5 as low while the product page said two of them were.
 *
 * Anything that needs this must call it rather than re-deriving it, which is the only thing
 * that stops the two definitions growing back.
 */
export function isLowStock(quantityOnHand: number, reorderLevel: number | null | undefined): boolean {
  const level = reorderLevel ?? 0;
  // Not tracked. Out of stock is a different state, raised separately.
  if (level <= 0) return false;
  return quantityOnHand <= level;
}

/**
 * The number a low-stock badge should compare against, or null when the variant is not
 * tracked. Useful where a screen wants to show "3 / 5" rather than just a colour.
 */
export function lowStockThreshold(reorderLevel: number | null | undefined): number | null {
  const level = reorderLevel ?? 0;
  return level > 0 ? level : null;
}
