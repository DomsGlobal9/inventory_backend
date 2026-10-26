import { prisma } from '../../lib/prisma';

/**
 * Something changed here that a Shopify copy should catch up with.
 *
 * Its own tiny file so the product, variant and stock code can call it without importing the push
 * service, which imports the catalogue -- the same cycle the discount mirror's dirty.ts avoids.
 *
 * Never throws, and costs one UPDATE that touches nothing for the great majority of products, which
 * are not on Shopify. A Shopify copy must never be able to stop a sale or a save.
 */

/** The product itself changed: title, sizes, price, photos, status. Its whole copy is re-sent. */
export async function markProductForShopify(productId: string): Promise<void> {
  try {
    await prisma.shopifyProductMirror.updateMany({
      // A product switched off and already archived stays archived until it is switched on again.
      where: { productId, NOT: { wanted: false, status: 'ARCHIVED' } },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: null, problem: null }
    });
  } catch (error) {
    console.error(`[shopify products] could not queue product ${productId}`, error);
  }
}

/**
 * Only the stock moved -- a sale, a receipt, a move. The cheap path: just the numbers are sent.
 * One statement, so a busy till pays one round trip per movement and no more.
 */
export async function markStockForShopify(variantId: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE shopify_product_mirrors SET stock_pending = true, updated_at = now()
      WHERE product_id = (SELECT product_id FROM inventory_product_variants WHERE id = ${variantId})
        AND status <> 'ARCHIVED' AND stock_pending = false`;
  } catch (error) {
    console.error(`[shopify products] could not queue stock for variant ${variantId}`, error);
  }
}
