/**
 * Shopify orders: what a shop actually sold online, arriving in ScaleEzy.
 *
 * Its own module rather than more branches inside the Shopify installation service, because the
 * two answer different questions and change for different reasons: that one is about a shop
 * connecting and staying connected, this one is about the sales that follow.
 *
 * Two files so far, split by what can be tested without anything else existing:
 *
 *   mapping          a Shopify payload turned into our shape. Pure -- no database, no network,
 *                    no clock. This is why the whole phase is testable before Shopify's
 *                    protected-customer-data approval, which is a human review we cannot hurry.
 *   ingest.service   where a mapped order goes: the writes, the idempotency, and parking the
 *                    ones that need a person to decide something first.
 *   cancel.service   an order called off in Shopify, and the reserved stock going back on sale.
 *   fulfilment       goods leaving, recorded as a real Dispatch so the day book sees the sale.
 *   refund.service   money going back, driven through the existing return flow.
 *
 * Importers take this folder, not the files inside it.
 */
export { mapShopifyOrder, statusFor } from './mapping';
export type { MappedOrder, MappedLine, MappedDiscount, MappingContext, MappingResult, ParkReason } from './mapping';

export { shopifyOrderIngestService } from './ingest.service';
export type { IngestOutcome } from './ingest.service';

export { shopifyOrderCancelService } from './cancel.service';
export { shopifyFulfilmentService } from './fulfilment.service';
export { shopifyRefundService } from './refund.service';
