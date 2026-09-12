/**
 * Money going back to a customer, when Shopify is the one who paid it.
 *
 * A Shopify refund is a COMPLETED FACT, not a workflow. Shopify decided, Shopify paid, and
 * Shopify already knows whether the goods went back on the shelf. So this drives the existing
 * return flow all the way through in one go -- requested, received, inspected, completed -- with
 * the dispositions Shopify has already chosen, rather than leaving a merchant a queue of returns
 * to approve that were settled days ago on somebody else's website.
 *
 * It reuses returnService rather than writing stock movements of its own. That is only possible
 * because a Shopify fulfilment now creates a real Dispatch (see fulfilment.service), and it is
 * worth the reuse: restocking, the returnedQty bookkeeping and the ledger entries are all one
 * code path whether the goods came back to a counter or through the post.
 *
 * What it will not do is refund a list price. `refund_line_items[].subtotal` is what Shopify
 * actually paid back, and it is used verbatim -- a saree bought at 9,600 refunds 9,600, never
 * the 12,000 it is listed at.
 */

import { prisma } from '../../lib/prisma';
import { returnService } from '../return.service';
import { toMinor, fromMinor, portionOf } from '../pricing';

/** Shopify's restock_type values that mean the goods are back on the shelf. */
const RESTOCKED = new Set(['return', 'cancel', 'legacy_restock']);

export class ShopifyRefundService {
  /**
   * One `refunds/create`.
   *
   * Returns the outcome the webhook receipt records. Anything we cannot act on is reported and
   * acknowledged rather than retried -- Shopify drops a topic that keeps failing.
   */
  async apply(shopDomain: string, payload: any): Promise<string> {
    const refundId = payload?.id === undefined || payload?.id === null ? '' : String(payload.id);
    const shopifyOrderId = payload?.order_id === undefined || payload?.order_id === null
      ? '' : String(payload.order_id);
    if (!refundId || !shopifyOrderId) return 'IGNORED';

    const installation = await prisma.shopifyInstallation.findUnique({
      where: { shopDomain }, select: { clientId: true }
    });
    if (!installation?.clientId) return 'IGNORED';
    const clientId = installation.clientId;

    // Redelivered. Shopify sends the same refund more than once by design, and a second run
    // would put the goods back on the shelf twice.
    const already = await prisma.salesReturn.findFirst({
      where: { clientId, externalRefundId: refundId },
      select: { returnNumber: true }
    });
    if (already) return 'DUPLICATE';

    const order = await prisma.salesOrder.findFirst({
      where: { clientId, externalOrderId: shopifyOrderId, sourceSystem: 'SHOPIFY', deletedAt: null },
      include: { items: { orderBy: { createdAt: 'asc' } } }
    });
    if (!order) return 'IGNORED';

    const refundLines: any[] = Array.isArray(payload.refund_line_items) ? payload.refund_line_items : [];
    if (refundLines.length === 0) {
      /*
       * A refund with no lines is money back with no goods coming back -- a shipping refund, a
       * goodwill gesture, a partial price adjustment. There is nothing to return and nothing to
       * restock, so forcing it through the return flow would invent a movement that did not
       * happen. Recorded in the log and acknowledged.
       */
      console.log(`[Shopify] refund ${refundId} on ${order.orderNumber} covers no goods -- nothing to return.`);
      return 'IGNORED';
    }

    // Shopify line -> our variant.
    const idMaps = await prisma.shopifyIdMap.findMany({
      where: { clientId, variantId: { in: order.items.map(i => i.variantId) } },
      select: { shopifyVariantId: true, variantId: true }
    });
    const variantOf = new Map(idMaps.map(m => [m.shopifyVariantId, m.variantId]));

    /** How much of each variant is being refunded, and how much money with it. */
    const refunded = new Map<string, { quantity: number; amountMinor: number; restock: boolean }>();

    for (const rl of refundLines) {
      const shopifyVariantId = String(rl?.line_item?.variant_id ?? rl?.variant_id ?? '');
      const ourVariant = variantOf.get(shopifyVariantId);
      if (!ourVariant) continue;

      const quantity = Number(rl?.quantity ?? 0);
      if (quantity <= 0) continue;

      const amountMinor = toMinor(rl?.subtotal ?? rl?.subtotal_set?.shop_money?.amount ?? 0);
      const restock = RESTOCKED.has(String(rl?.restock_type ?? '').toLowerCase());

      const at = refunded.get(ourVariant) ?? { quantity: 0, amountMinor: 0, restock: false };
      at.quantity += quantity;
      at.amountMinor += amountMinor;
      // If ANY part of this variant came back, the units are treated as returned. Splitting one
      // variant across two dispositions is a level of detail Shopify's own restock flag does not
      // reliably carry, and guessing which individual units it meant would be invention.
      at.restock = at.restock || restock;
      refunded.set(ourVariant, at);
    }

    if (refunded.size === 0) {
      console.warn(`[Shopify] refund ${refundId} on ${order.orderNumber} names no product we recognise.`);
      return 'IGNORED';
    }

    /*
     * Which dispatch the units are coming back from.
     *
     * A line shipped in two parts has two DispatchItems, and a return has to name one. They are
     * consumed oldest first, up to what each still has left to give back -- the same order the
     * goods went out in, which is the only ordering a merchant would recognise.
     */
    const dispatchItems = await prisma.dispatchItem.findMany({
      where: { dispatch: { clientId, salesOrderId: order.id } },
      include: { salesOrderItem: { select: { id: true, variantId: true, quantity: true, totalPrice: true } } },
      // Oldest shipment first. DispatchItem has no date of its own, and the parent's departure
      // date is the ordering a merchant would recognise anyway: goods come back in the order
      // they went out.
      orderBy: { dispatch: { dispatchedAt: 'asc' } }
    });

    const toReturn: { dispatchItemId: string; quantity: number; variantId: string; salesOrderItemId: string }[] = [];
    const unmatched: string[] = [];

    for (const [variantId, want] of refunded) {
      let outstanding = want.quantity;
      for (const di of dispatchItems) {
        if (outstanding <= 0) break;
        if (di.salesOrderItem.variantId !== variantId) continue;
        const available = di.quantity - di.returnedQty;
        if (available <= 0) continue;
        const take = Math.min(available, outstanding);
        toReturn.push({
          dispatchItemId: di.id, quantity: take,
          variantId, salesOrderItemId: di.salesOrderItem.id
        });
        di.returnedQty += take; // claimed within this refund, so two lines cannot take the same units
        outstanding -= take;
      }
      if (outstanding > 0) unmatched.push(`${outstanding} of ${variantId}`);
    }

    if (toReturn.length === 0) {
      /*
       * Nothing has shipped, so nothing can come back.
       *
       * A refund before fulfilment is a cancellation with the money returned, and Shopify sends
       * `orders/cancelled` or an `orders/updated` with financial_status refunded for that -- both
       * of which are handled elsewhere. Inventing a return for goods that never left would put a
       * restock into the ledger for stock that never moved.
       */
      console.log(
        `[Shopify] refund ${refundId} on ${order.orderNumber} covers goods that never shipped -- ` +
        `it will be handled as a cancellation.`
      );
      return 'IGNORED';
    }

    if (unmatched.length > 0) {
      console.warn(
        `[Shopify] refund ${refundId} on ${order.orderNumber} refunds more than was shipped ` +
        `(${unmatched.join(', ')}). The shipped units were returned; the rest was not.`
      );
    }

    const salesReturn = await returnService.createReturn(
      clientId,
      order.id,
      toReturn.map(r => ({ dispatchItemId: r.dispatchItemId, quantity: r.quantity })),
      `Refunded in Shopify (refund ${refundId})`,
      'CUSTOMER_REJECTED'
    );

    await returnService.receiveReturn(clientId, salesReturn.id);

    /*
     * The disposition Shopify already chose.
     *
     * RESTOCK when they put it back; SCRAP when they did not. SCRAP is not a claim that the goods
     * were destroyed -- it is the only value of the three that moves no stock, which is exactly
     * right for a refund where the customer keeps the item. completeReturn moves stock for
     * RESTOCK and nothing else, so the money is recorded either way and the shelf only changes
     * when it really changed.
     */
    const rowsById = new Map(salesReturn.items.map((i: any) => [i.id, i]));
    await returnService.inspectReturn(
      clientId,
      salesReturn.id,
      salesReturn.items.map((item: any) => {
        const claim = toReturn.find(r => r.dispatchItemId === item.dispatchItemId);
        const variantId = claim?.variantId ?? '';
        return {
          salesReturnItemId: item.id,
          disposition: (refunded.get(variantId)?.restock ? 'RESTOCK' : 'SCRAP') as 'RESTOCK' | 'SCRAP'
        };
      })
    );

    await returnService.completeReturn(clientId, salesReturn.id);

    await this.recordMoney(salesReturn.id, toReturn, refunded, rowsById, payload);

    const units = toReturn.reduce((s, r) => s + r.quantity, 0);
    console.log(
      `[Shopify] refund ${refundId} recorded as ${salesReturn.returnNumber} -- ` +
      `${units} unit(s) off ${order.orderNumber}`
    );
    return 'APPLIED';
  }

  /**
   * What the customer actually got back, per line and in total.
   *
   * Written after the flow rather than through it, because the return service has never carried
   * money and teaching it to would change every POS return at the same time. Here the amounts are
   * Shopify's own: `subtotal` is what they paid back, and it is used verbatim.
   *
   * Where one variant's refund spans several dispatch items the amount is divided with
   * `portionOf` -- cumulative, so however a refund is split the parts add up to what Shopify
   * refunded, to the paisa.
   */
  private async recordMoney(
    salesReturnId: string,
    claims: { dispatchItemId: string; quantity: number; variantId: string; salesOrderItemId: string }[],
    refunded: Map<string, { quantity: number; amountMinor: number; restock: boolean }>,
    rowsById: Map<string, any>,
    payload: any
  ) {
    const items = await prisma.salesReturnItem.findMany({ where: { salesReturnId } });

    // How far through each variant's refund we have got, so the split is cumulative.
    const consumed = new Map<string, number>();
    let totalMinor = 0;

    for (const item of items) {
      const claim = claims.find(c => c.dispatchItemId === item.dispatchItemId);
      if (!claim) continue;

      const variant = refunded.get(claim.variantId);
      if (!variant) continue;

      const before = consumed.get(claim.variantId) ?? 0;
      const after = before + item.quantity;
      const amountMinor = portionOf(variant.amountMinor, variant.quantity, before, after);
      consumed.set(claim.variantId, after);
      totalMinor += amountMinor;

      await prisma.salesReturnItem.update({
        where: { id: item.id },
        data: {
          // The direct link to the order line, which is where the net price lives. It was only
          // ever reachable through DispatchItem before, and that is no use for money.
          salesOrderItemId: claim.salesOrderItemId,
          refundAmount: fromMinor(amountMinor)
        }
      });
    }

    await prisma.salesReturn.update({
      where: { id: salesReturnId },
      data: {
        refundTotal: fromMinor(totalMinor),
        // REFUNDED, not PENDING. Shopify has already moved the money; we are writing it down.
        refundStatus: 'REFUNDED',
        externalRefundId: String(payload.id)
      }
    });

    void rowsById;
  }
}

export const shopifyRefundService = new ShopifyRefundService();
