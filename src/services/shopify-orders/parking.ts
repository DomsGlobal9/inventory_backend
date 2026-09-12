/**
 * Where a Shopify event waits when it cannot be acted on yet.
 *
 * Its own file because three services park -- ingest (an order we cannot place), fulfilment and
 * refund (something that happened to an order that is itself still waiting) -- and the inbox
 * service replays all of them. Kept here, none of those has to import another to share it, and
 * the inbox can depend on ingest without ingest depending back on the inbox.
 */

import { prisma } from '../../lib/prisma';
import { safeMessage } from '../../lib/safeMessage';
import type { ParkReason } from './mapping';

/** The two topics that carry an ORDER, as opposed to something that happened to one. */
export const ORDER_TOPICS = ['orders/create', 'orders/updated'];

export const FULFILMENT_TOPIC = 'orders/fulfilled';

/**
 * Refunds are keyed per refund, not per order.
 *
 * The inbox's natural key is (shop, order, topic), which is exactly right for an order (the
 * newest payload replaces the older one) and for fulfilment (Shopify sends the absolute state,
 * so the newest is the whole truth). It is wrong for refunds: two refunds on one order are two
 * separate sums of money, and keying them by topic alone would let the second overwrite the
 * first -- a refund silently lost. So the refund's own id travels in the topic.
 */
export const refundTopic = (refundId: string) => `refunds/create#${refundId}`;
export const isRefundTopic = (topic: string) => topic.startsWith('refunds/create');

export type ParkOutcome = { status: 'PARKED'; reason: ParkReason; detail: string };

/**
 * Park an event with everything needed to replay it.
 *
 * Upserted on (shop, order, topic) so a redelivered webhook updates its row instead of adding a
 * second one -- otherwise a shop with one unmapped location accumulates a parked row per retry,
 * for days, and the panel becomes unreadable exactly when it matters.
 *
 * The detail is passed through safeMessage because it is now SHOWN to a merchant. A FAILED
 * park used to carry the raw exception, which for a database error is a Prisma banner with our
 * file paths in it.
 */
export async function park(
  shopDomain: string,
  clientId: string | null,
  shopifyOrderId: string,
  topic: string,
  payload: any,
  reason: ParkReason,
  detail: string
): Promise<ParkOutcome> {
  const shown = safeMessage(detail, 'Something went wrong placing this order. Try again.');

  await prisma.shopifyOrderInbox.upsert({
    where: { uq_inbox_order_topic: { shopDomain, shopifyOrderId, topic } },
    create: { shopDomain, clientId, shopifyOrderId, topic, payload, reason, detail: shown, attempts: 1 },
    update: { reason, detail: shown, payload, clientId, attempts: { increment: 1 }, resolvedAt: null }
  });

  // The full, unfiltered reason goes to the server log, where it is useful and private.
  console.warn(`[Shopify] ${topic} for order ${shopifyOrderId} from ${shopDomain} parked: ${reason} -- ${detail}`);
  return { status: 'PARKED', reason, detail: shown };
}

/**
 * Is this order sitting in the inbox, waiting to be placed?
 *
 * The question fulfilment and refund ask when they cannot find the order. "No" means the order
 * predates the connection and there is nothing to wait for; "yes" means the shipment or the
 * refund belongs to a real sale that will exist here shortly, and dropping it would leave that
 * sale's stock reserved for ever and its money unrefunded.
 */
export async function isOrderWaiting(shopDomain: string, shopifyOrderId: string): Promise<boolean> {
  const waiting = await prisma.shopifyOrderInbox.count({
    where: { shopDomain, shopifyOrderId, topic: { in: ORDER_TOPICS }, resolvedAt: null }
  });
  return waiting > 0;
}
