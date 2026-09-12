/**
 * Goods leaving, when Shopify is the one who shipped them.
 *
 * The Phase 1 spec said a Shopify fulfilment should move stock directly and NOT create a
 * Dispatch, on the reasoning that nobody here packed it. Tracing what actually depends on a
 * Dispatch showed that to be wrong, and the spec has been corrected:
 *
 *   - the day book counts a day's sales from dispatches. Refusing to make one means an online
 *     sale never reaches the day book, which is the entire point of this phase.
 *   - SalesReturnItem.dispatchItemId is NOT NULL and the whole return flow reads through it, so
 *     without a dispatch a Shopify refund could not be recorded at all without loosening a
 *     constraint that is doing real work for POS returns.
 *   - dispatchService already consumes reservations, moves stock, keeps fulfilledQty, recognises
 *     revenue with portionOf and moves the order's status. Every one of those would have had to
 *     be written again here, and the second copy is the one that drifts.
 *
 * "Nobody packed it" is answered by saying so on the record, not by refusing to keep one. The
 * goods did leave the building; that is what a Dispatch means.
 *
 * ABSOLUTE STATE, NEVER A DELTA. Shopify says how much of each line is fulfilled in total; we
 * ship the difference between that and what we have already shipped. A redelivered webhook
 * computes a difference of zero and does nothing, which is what makes redelivery free instead of
 * dangerous -- the same rule StorefrontEvent follows in the other direction.
 */

import { prisma } from '../../lib/prisma';
import { dispatchService } from '../dispatch.service';
import { park, isOrderWaiting, FULFILMENT_TOPIC } from './parking';

export class ShopifyFulfilmentService {
  /**
   * One `orders/fulfilled` (or the fulfilment part of an `orders/updated`).
   *
   * Returns the outcome the webhook receipt records. Never throws for something we simply do not
   * have: Shopify can fulfil an order that is still parked, and retrying that for days would end
   * with Shopify unsubscribing the topic.
   */
  async apply(shopDomain: string, payload: any): Promise<string> {
    const shopifyOrderId = payload?.id === undefined || payload?.id === null ? '' : String(payload.id);
    if (!shopifyOrderId) return 'IGNORED';

    const installation = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain }, select: { clientId: true }
    });

    const order = installation?.clientId
      ? await prisma.salesOrder.findFirst({
          where: {
            clientId: installation.clientId, externalOrderId: shopifyOrderId,
            sourceSystem: 'SHOPIFY', deletedAt: null
          },
          include: { items: { orderBy: { createdAt: 'asc' } } }
        })
      : null;

    if (!order) {
      /*
       * Shipped before it could be placed here.
       *
       * If the order is waiting in the inbox this shipment belongs to a real sale, and dropping
       * it means that sale reserves its stock the moment it is placed and never lets go. Kept
       * with the order and applied straight after it. Otherwise the order predates the
       * connection and there is genuinely nothing to do.
       */
      if (await isOrderWaiting(shopDomain, shopifyOrderId)) {
        await park(shopDomain, installation?.clientId ?? null, shopifyOrderId, FULFILMENT_TOPIC, payload,
          'AWAITING_ORDER', 'Shopify shipped this order before it could be placed here. It will be recorded as soon as the order is.');
        return 'PARKED';
      }
      return 'IGNORED';
    }
    const clientId = installation!.clientId!;

    if (order.status === 'CANCELLED') {
      console.warn(`[Shopify] fulfilment for ${shopifyOrderId} ignored -- the order here is cancelled.`);
      return 'IGNORED';
    }

    /*
     * How much of each variant Shopify says has shipped, in total.
     *
     * Summed by VARIANT rather than matched to Shopify's line ids. Shopify can split one product
     * across two lines on the same order -- a quantity break, a line added later -- and our
     * items do not carry their Shopify line id, so matching by it would need a column and would
     * still break when an order is re-ingested and its lines are rewritten. The total per variant
     * is the same number either way, and it survives both.
     */
    const shippedByVariant = new Map<string, number>();

    const variantOf = new Map<string, string>();
    const idMaps = await prisma.shopifyIdMap.findMany({
      where: { clientId, variantId: { in: order.items.map(i => i.variantId) } },
      select: { shopifyVariantId: true, variantId: true }
    });
    for (const m of idMaps) variantOf.set(m.shopifyVariantId, m.variantId);

    const fulfillments: any[] = Array.isArray(payload.fulfillments) ? payload.fulfillments : [];
    for (const f of fulfillments) {
      // A cancelled fulfilment is not a shipment. Shopify keeps the record and marks it.
      const status = String(f?.status ?? '').toLowerCase();
      if (status === 'cancelled' || status === 'error') continue;

      for (const li of (Array.isArray(f?.line_items) ? f.line_items : [])) {
        const ourVariant = variantOf.get(String(li?.variant_id));
        if (!ourVariant) continue;
        const qty = Number(li?.quantity ?? 0);
        if (qty <= 0) continue;
        shippedByVariant.set(ourVariant, (shippedByVariant.get(ourVariant) ?? 0) + qty);
      }
    }

    if (shippedByVariant.size === 0) return 'IGNORED';

    /*
     * The difference, spread across our lines for that variant in the order they were created.
     *
     * Deterministic, so the same webhook always fills the same lines -- and capped per line, so
     * Shopify reporting more fulfilled than we ever ordered can never ship a line twice.
     */
    const toDispatch: { salesOrderItemId: string; quantity: number }[] = [];
    let overFulfilled = false;

    for (const [variantId, shipped] of shippedByVariant) {
      const lines = order.items.filter(i => i.variantId === variantId);
      const alreadyHere = lines.reduce((s, l) => s + l.fulfilledQty, 0);
      let outstanding = shipped - alreadyHere;

      if (outstanding <= 0) continue;

      for (const line of lines) {
        if (outstanding <= 0) break;
        const room = line.quantity - line.fulfilledQty;
        if (room <= 0) continue;
        const take = Math.min(room, outstanding);
        toDispatch.push({ salesOrderItemId: line.id, quantity: take });
        outstanding -= take;
      }

      if (outstanding > 0) overFulfilled = true;
    }

    if (overFulfilled) {
      // Said out loud rather than absorbed. It means Shopify shipped something this order does
      // not contain, which is a real discrepancy somebody should look at -- but it is not a
      // reason to refuse the units that DO match.
      console.warn(
        `[Shopify] order ${shopifyOrderId} reports more fulfilled than it ordered. ` +
        `The matching units were shipped; the excess was not.`
      );
    }

    // Everything Shopify has shipped, we had already shipped. A redelivery, and correctly a no-op.
    if (toDispatch.length === 0) return 'ECHO';

    await dispatchService.createDispatch(clientId, order.id, toDispatch);

    const units = toDispatch.reduce((s, d) => s + d.quantity, 0);
    console.log(
      `[Shopify] order ${shopifyOrderId} -- ${units} unit(s) shipped, recorded against ${order.orderNumber}`
    );
    return 'APPLIED';
  }
}

export const shopifyFulfilmentService = new ShopifyFulfilmentService();
