/**
 * A Shopify order the customer or the merchant called off.
 *
 * Separate from ingest because it is a different shape of work: nothing is mapped, nothing is
 * priced, and the only thing that matters is that the stock we were holding goes back on sale.
 * Reserved stock belonging to an order that no longer exists is the worst kind of missing: it
 * never shows up as missing, it just quietly stops being sellable.
 */

import { prisma } from '../../lib/prisma';
import { salesOrderService } from '../sales-order.service';

export class ShopifyOrderCancelService {
  /**
   * Returns the outcome string the webhook receipt records. Never throws for an order we simply
   * do not have -- Shopify can cancel something that was parked, or that predates the connection,
   * and neither is a fault worth retrying for days.
   */
  async cancel(shopDomain: string, payload: any): Promise<string> {
    const shopifyOrderId = payload?.id === undefined || payload?.id === null ? '' : String(payload.id);
    if (!shopifyOrderId) return 'IGNORED';

    const installation = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain },
      select: { clientId: true }
    });
    if (!installation?.clientId) return 'IGNORED';

    const order = await prisma.salesOrder.findFirst({
      where: {
        clientId: installation.clientId,
        externalOrderId: shopifyOrderId,
        sourceSystem: 'SHOPIFY',
        deletedAt: null
      },
      select: { id: true, status: true, orderNumber: true }
    });

    if (!order) {
      // It may be sitting in the inbox waiting for a location to be mapped. Marking it resolved
      // stops somebody being asked to fix an order that no longer needs fixing.
      const parked = await prisma.shopifyOrderInbox.updateMany({
        where: { shopDomain, shopifyOrderId, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedBy: 'system',
          detail: 'Cancelled in Shopify before it could be placed here.'
        }
      });
      return parked.count > 0 ? 'APPLIED' : 'IGNORED';
    }

    if (order.status === 'CANCELLED') return 'DUPLICATE';

    /*
     * An order that has already shipped cannot be cancelled, here or anywhere.
     *
     * Shopify allows cancelling a fulfilled order; we do not, because the goods have physically
     * left and releasing a reservation that was already consumed would invent stock. Recorded
     * rather than forced, so a person can look at it -- a refund is the right instrument for
     * goods that have gone out, and that arrives as its own webhook.
     */
    if (order.status === 'DISPATCHED' || order.status === 'PARTIALLY_DISPATCHED') {
      console.warn(
        `[Shopify] order ${shopifyOrderId} was cancelled in Shopify but ${order.orderNumber} has ` +
        `already shipped (${order.status}). Left as it is; a refund will arrive separately.`
      );
      return 'IGNORED';
    }

    // The ordinary path, through the same service a person uses, so reservations are released
    // exactly the way they are when somebody presses Cancel on the screen.
    await salesOrderService.cancelOrder(installation.clientId, order.id);
    console.log(`[Shopify] order ${shopifyOrderId} cancelled -- ${order.orderNumber} released`);
    return 'APPLIED';
  }
}

export const shopifyOrderCancelService = new ShopifyOrderCancelService();
