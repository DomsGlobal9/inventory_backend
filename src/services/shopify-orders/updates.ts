/**
 * Telling Shopify what happened to one of its orders, when ScaleEzy (Logistics) is the one who
 * shipped it (29 Oct).
 *
 * The shop never uses Shopify's own shipping. The order comes in from Shopify, is packed here and
 * handed to Logistics, and Logistics books the courier. Shopify still shows the customer the order,
 * so it has to be told:
 *
 *   booked by Logistics      -> a Shopify fulfilment with the tracking number and link, and Shopify
 *                               emails the customer (its "your order is on the way")
 *   new tracking             -> the fulfilment's tracking is corrected
 *   picked up / in transit / out for delivery / attempted / delivered
 *                            -> a delivery event on that fulfilment, so Shopify's status page moves
 *   returning / returned / lost
 *                            -> a FAILURE event saying which
 *   cancelled by Logistics   -> the fulfilment is cancelled (the parcel never left)
 *   cash collected on delivery
 *                            -> the Shopify order is marked paid; Shopify's own "paid" webhook then
 *                               records the money here, once, as every Shopify payment already is
 *
 * NO DOUBLE DISPATCH. Our Dispatch exists from the moment the parcel was packed. When Shopify echoes
 * our fulfilment back (orders/fulfilled), fulfilment.service compares the absolute fulfilled count with
 * what we already shipped and finds nothing new (ECHO). A fulfilment made by hand IN SHOPIFY on a shop
 * that ships through Logistics is still recorded, and noted on the order (FULFILLED_IN_SHOPIFY).
 *
 * Every update is a row in shopify_order_updates, queued where the news arrives and sent by the worker,
 * so a Logistics update never waits on (or fails because of) Shopify. Each row has a dedupe key: the same
 * Logistics update twice queues nothing new. A shop that has not yet approved the new permissions waits
 * (WAITING_PERMISSION) and is sent as soon as it has.
 */
import { prisma } from '../../lib/prisma';
import { backoffMs } from '../../utils/retryBackoff';
import { ShopifyAdminApi, ShopifyApiError } from '../shopify-mapping';

export const NEEDED_SCOPES = {
  fulfil: ['write_merchant_managed_fulfillment_orders', 'write_fulfillments'],
  paid: ['write_orders']
};
const MAX_ATTEMPTS = 8;
const PERMISSION_RECHECK_MS = 10 * 60_000;

/** Logistics' status -> Shopify's delivery event, and what the customer is told with it. */
const EVENT_OF: Record<string, { event: string; message?: string }> = {
  PICKED_UP: { event: 'CARRIER_PICKED_UP' },
  IN_TRANSIT: { event: 'IN_TRANSIT' },
  OUT_FOR_DELIVERY: { event: 'OUT_FOR_DELIVERY' },
  FAILED_ATTEMPT: { event: 'ATTEMPTED_DELIVERY', message: 'The courier could not deliver it this time and will try again.' },
  DELIVERED: { event: 'DELIVERED' },
  RTO_INITIATED: { event: 'FAILURE', message: 'It could not be delivered and is on its way back to the shop.' },
  RTO_DELIVERED: { event: 'FAILURE', message: 'It could not be delivered and has been returned to the shop.' },
  LOST: { event: 'FAILURE', message: 'The courier lost this parcel. The shop will be in touch.' }
};
/** Statuses that mean the parcel has really gone out, so Shopify should see it fulfilled. */
const ON_ITS_WAY = new Set(['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'DELIVERED', 'RTO_INITIATED', 'RTO_DELIVERED', 'LOST']);

const gid = (type: string, id: string) => (id.startsWith('gid://') ? id : `gid://shopify/${type}/${id}`);
const hasScope = (granted: string, scope: string) => {
  const have = new Set(granted.split(',').map(s => s.trim()).filter(Boolean));
  return have.has(scope) || (scope.startsWith('read_') && have.has(scope.replace(/^read_/, 'write_')));
};

async function queue(row: { clientId: string; salesOrderId: string; dispatchId?: string | null; kind: string; event?: string | null; dedupeKey: string; state?: string; detail?: any; lastError?: string | null }) {
  // A dedupe key already there: this news was queued before. Nothing to do.
  await prisma.shopifyOrderUpdate.create({
    data: { ...row, dispatchId: row.dispatchId ?? null, event: row.event ?? null, detail: row.detail ?? {}, ...(row.state === 'NOTICE' ? { doneAt: new Date() } : {}) }
  }).catch((e: any) => { if (e?.code !== 'P2002') throw e; });
}

/**
 * A Logistics update for a parcel of a SHOPIFY order: what Shopify should now be told. Called after
 * the update is saved; never throws (the update is already recorded, and Shopify can be told later).
 */
export async function fromParcelUpdate(clientId: string, parcelId: string, status: string) {
  try {
    const parcel = await prisma.logisticsParcel.findFirst({
      where: { id: parcelId, clientId },
      select: { id: true, dispatchId: true, salesOrderId: true, awb: true, trackingUrl: true }
    });
    if (!parcel) return;
    const order = await prisma.salesOrder.findFirst({ where: { id: parcel.salesOrderId, clientId }, select: { sourceSystem: true, externalOrderId: true } });
    if (order?.sourceSystem !== 'SHOPIFY' || !order.externalOrderId) return;
    const base = { clientId, salesOrderId: parcel.salesOrderId, dispatchId: parcel.dispatchId };

    if (status === 'CANCELLED') {
      await queue({ ...base, kind: 'CANCEL', dedupeKey: `cancel:${parcel.dispatchId}` });
      return;
    }
    if (!ON_ITS_WAY.has(status)) return;
    // The fulfilment itself, once per parcel, from the first news that it is going out. Without a
    // tracking number yet it still goes: Shopify shows "shipped" and the tracking follows.
    await queue({ ...base, kind: 'FULFIL', dedupeKey: `fulfil:${parcel.dispatchId}`, detail: { number: parcel.awb, url: parcel.trackingUrl } });
    // A tracking number or link that is new since the fulfilment was queued: corrected on Shopify.
    if (parcel.awb || parcel.trackingUrl) {
      const fulfil = await prisma.shopifyOrderUpdate.findUnique({ where: { dedupeKey: `fulfil:${parcel.dispatchId}` }, select: { id: true, state: true, detail: true } });
      const sent = (fulfil?.detail ?? {}) as any;
      if (fulfil && ['PENDING', 'WAITING_PERMISSION'].includes(fulfil.state)) {
        // Not sent yet: it simply goes with the newest tracking.
        await prisma.shopifyOrderUpdate.update({ where: { id: fulfil.id }, data: { detail: { number: parcel.awb, url: parcel.trackingUrl } } });
      } else if (fulfil?.state === 'DONE' && (sent.number !== parcel.awb || sent.url !== parcel.trackingUrl)) {
        await queue({ ...base, kind: 'TRACKING', dedupeKey: `tracking:${parcel.dispatchId}:${parcel.awb ?? ''}:${parcel.trackingUrl ?? ''}`, detail: { number: parcel.awb, url: parcel.trackingUrl } });
      }
    }
    const ev = EVENT_OF[status];
    if (ev) await queue({ ...base, kind: 'EVENT', event: ev.event, dedupeKey: `event:${parcel.dispatchId}:${status}`, detail: { status, message: ev.message ?? null } });
  } catch (e: any) {
    console.warn(`[Shopify updates] could not queue for parcel ${parcelId}: ${e?.message}`);
  }
}

/**
 * Cash the courier collected for a Shopify cash-on-delivery order. All of it: Shopify is told the
 * order is paid. Less than is owed: nothing is sent (Shopify can only mark the whole balance paid) and
 * the order says so, for the shop to settle by hand.
 */
export async function fromCodCollected(clientId: string, salesOrderId: string, collectedRupees: number, dueRupees: number) {
  try {
    const order = await prisma.salesOrder.findFirst({ where: { id: salesOrderId, clientId }, select: { sourceSystem: true, payOnDelivery: true, externalOrderId: true } });
    if (!order || order.sourceSystem !== 'SHOPIFY' || !order.payOnDelivery || !order.externalOrderId) return;
    if (collectedRupees + 0.5 >= dueRupees) {
      await queue({ clientId, salesOrderId, kind: 'MARK_PAID', dedupeKey: `paid:${salesOrderId}`, detail: { collected: collectedRupees } });
    } else {
      await queue({
        clientId, salesOrderId, kind: 'COD_SHORT', state: 'NOTICE', dedupeKey: `cod-short:${salesOrderId}`, detail: { collected: collectedRupees, due: dueRupees },
        lastError: `The courier collected ₹${collectedRupees.toLocaleString('en-IN')} of ₹${dueRupees.toLocaleString('en-IN')}. Shopify was not marked paid; settle the difference with the customer, then mark it paid in Shopify.`
      });
    }
  } catch (e: any) {
    console.warn(`[Shopify updates] could not queue mark-paid for ${salesOrderId}: ${e?.message}`);
  }
}

/** Shopify says it was fulfilled there, by hand, on a shop that ships through Logistics. */
export async function noteFulfilledInShopify(clientId: string, salesOrderId: string, dispatchId: string | null, units: number) {
  await queue({
    clientId, salesOrderId, dispatchId, kind: 'FULFILLED_IN_SHOPIFY', state: 'NOTICE', dedupeKey: `by-hand:${dispatchId ?? `${salesOrderId}:${Date.now()}`}`,
    detail: { units },
    lastError: 'Marked fulfilled in Shopify, not sent through ScaleEzy Logistics. The stock has been taken off; check the parcel really went.'
  }).catch(e => console.warn(`[Shopify updates] could not note the fulfilment for ${salesOrderId}: ${e?.message}`));
  // And in the bell, where the owner looks first.
  const order = await prisma.salesOrder.findFirst({ where: { id: salesOrderId, clientId }, select: { orderNumber: true, locationId: true } }).catch(() => null);
  if (order) await prisma.inventoryAlert.create({ data: {
    clientId, type: 'ONLINE_ORDER', severity: 'WARNING', locationId: order.locationId,
    title: `Shopify order ${order.orderNumber} was fulfilled in Shopify`,
    message: `${units} ${units === 1 ? 'piece was' : 'pieces were'} marked fulfilled in Shopify by hand, not sent through ScaleEzy Logistics. The stock has been taken off; check the parcel really went.`
  } }).catch(e => console.warn(`[Shopify updates] could not raise the notice for ${salesOrderId}: ${e?.message}`));
}

// ---- Sending ---------------------------------------------------------------------------------------

const Q = {
  fulfillmentOrders: `query($id: ID!) { order(id: $id) { id displayFinancialStatus fulfillmentOrders(first: 20) { nodes { id status
    lineItems(first: 100) { nodes { id remainingQuantity lineItem { variant { id } } } } } } } }`,
  create: `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`,
  tracking: `mutation($id: ID!, $t: FulfillmentTrackingInput!) { fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $t, notifyCustomer: true) { fulfillment { id } userErrors { field message } } }`,
  event: `mutation($e: FulfillmentEventInput!) { fulfillmentEventCreate(fulfillmentEvent: $e) { fulfillmentEvent { id status } userErrors { field message } } }`,
  cancel: `mutation($id: ID!) { fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { field message } } }`,
  paid: `mutation($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id displayFinancialStatus } userErrors { field message } } }`
};

/** Not something trying again will fix: said on the order, and left. */
class Skip extends Error {}
/** Not yet: another update has to go first. Tried again soon, without counting an attempt. */
class NotYet extends Error {}

const errorsOf = (payload: any) => (Array.isArray(payload?.userErrors) ? payload.userErrors : []).map((e: any) => String(e?.message ?? '')).filter(Boolean);

type Row = Awaited<ReturnType<typeof prisma.shopifyOrderUpdate.findFirstOrThrow>>;
export type ApiFor = (installation: { id: string; shopDomain: string }) => Promise<ShopifyAdminApi>;

async function fulfilmentIdFor(row: Row): Promise<string> {
  const f = await prisma.shopifyOrderUpdate.findUnique({ where: { dedupeKey: `fulfil:${row.dispatchId}` }, select: { state: true, shopifyFulfillmentId: true, lastError: true } });
  if (f?.state === 'DONE' && f.shopifyFulfillmentId) return f.shopifyFulfillmentId;
  if (f?.state === 'SKIPPED' || f?.state === 'FAILED') throw new Skip('Shopify was never told this parcel was shipped, so there is nothing to update there.');
  throw new NotYet('waiting for the shipment to reach Shopify first');
}

async function send(row: Row, api: ShopifyAdminApi): Promise<{ fulfillmentId?: string; note?: string }> {
  const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: row.salesOrderId }, select: { externalOrderId: true } });
  const orderGid = gid('Order', String(order.externalOrderId));
  const detail = (row.detail ?? {}) as any;

  if (row.kind === 'FULFIL') {
    // Which pieces this parcel carries, as Shopify variants.
    const items = await prisma.dispatchItem.findMany({ where: { dispatchId: row.dispatchId! }, select: { quantity: true, salesOrderItem: { select: { variantId: true } } } });
    const maps = await prisma.shopifyIdMap.findMany({ where: { clientId: row.clientId, variantId: { in: items.map(i => i.salesOrderItem.variantId) } }, select: { variantId: true, shopifyVariantId: true } });
    const shopifyOf = new Map(maps.map(m => [m.variantId, gid('ProductVariant', m.shopifyVariantId)]));
    const want = new Map<string, number>();
    for (const i of items) {
      const v = shopifyOf.get(i.salesOrderItem.variantId);
      if (v) want.set(v, (want.get(v) ?? 0) + i.quantity);
    }
    if (!want.size) throw new Skip('None of the pieces in this parcel are linked to a Shopify product, so Shopify could not be told.');

    const data: any = await api.graphql(Q.fulfillmentOrders, { id: orderGid });
    if (!data?.order) throw new Skip('Shopify no longer has this order.');
    const open = (data.order.fulfillmentOrders?.nodes ?? []).filter((fo: any) => ['OPEN', 'IN_PROGRESS'].includes(fo.status));
    const byOrder: { fulfillmentOrderId: string; fulfillmentOrderLineItems: { id: string; quantity: number }[] }[] = [];
    for (const fo of open) {
      const lines: { id: string; quantity: number }[] = [];
      for (const li of fo.lineItems?.nodes ?? []) {
        const v = li?.lineItem?.variant?.id; const need = v ? want.get(v) ?? 0 : 0;
        const take = Math.min(need, Number(li.remainingQuantity ?? 0));
        if (take > 0) { lines.push({ id: li.id, quantity: take }); want.set(v, need - take); }
      }
      if (lines.length) byOrder.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: lines });
    }
    if (!byOrder.length) {
      const held = (data.order.fulfillmentOrders?.nodes ?? []).some((fo: any) => fo.status === 'ON_HOLD');
      throw new Skip(held
        ? 'This order is on hold in Shopify, so it could not be marked shipped there. Release the hold in Shopify; the tracking is on the order here.'
        : 'Shopify already shows these pieces as fulfilled (done by hand there?), so nothing more was sent.');
    }
    const trackingInfo = detail.number || detail.url ? { ...(detail.number ? { number: detail.number } : {}), ...(detail.url ? { url: detail.url } : {}) } : undefined;
    const r: any = await api.graphql(Q.create, { f: { lineItemsByFulfillmentOrder: byOrder, notifyCustomer: true, ...(trackingInfo ? { trackingInfo } : {}) } });
    const errs = errorsOf(r?.fulfillmentCreate);
    if (errs.length) throw new Skip(`Shopify would not mark it shipped: ${errs[0]}`);
    const id = r?.fulfillmentCreate?.fulfillment?.id;
    if (!id) throw new Error('Shopify did not say which fulfilment it made.');
    const short = [...want.values()].some(n => n > 0);
    return { fulfillmentId: id, ...(short ? { note: 'Some pieces were already fulfilled in Shopify; the rest were marked shipped.' } : {}) };
  }

  if (row.kind === 'TRACKING') {
    const id = await fulfilmentIdFor(row);
    const r: any = await api.graphql(Q.tracking, { id, t: { ...(detail.number ? { number: detail.number } : {}), ...(detail.url ? { url: detail.url } : {}) } });
    const errs = errorsOf(r?.fulfillmentTrackingInfoUpdate);
    if (errs.length) throw new Skip(`Shopify would not take the new tracking: ${errs[0]}`);
    return { fulfillmentId: id };
  }

  if (row.kind === 'EVENT') {
    const id = await fulfilmentIdFor(row);
    const r: any = await api.graphql(Q.event, { e: { fulfillmentId: id, status: row.event, happenedAt: row.createdAt.toISOString(), ...(detail.message ? { message: detail.message } : {}) } });
    const errs = errorsOf(r?.fulfillmentEventCreate);
    if (errs.length) throw new Skip(`Shopify would not take the delivery update: ${errs[0]}`);
    return { fulfillmentId: id };
  }

  if (row.kind === 'CANCEL') {
    const f = await prisma.shopifyOrderUpdate.findUnique({ where: { dedupeKey: `fulfil:${row.dispatchId}` }, select: { state: true, shopifyFulfillmentId: true } });
    // Never told Shopify it shipped: there is nothing there to cancel. A shipment still on its way to
    // Shopify is cancelled once it has arrived.
    if (!f || f.state === 'SKIPPED' || f.state === 'FAILED') return { note: 'Shopify had not been told it shipped, so there was nothing to cancel there.' };
    if (f.state !== 'DONE' || !f.shopifyFulfillmentId) throw new NotYet('waiting for the shipment to reach Shopify first');
    const r: any = await api.graphql(Q.cancel, { id: f.shopifyFulfillmentId });
    const errs = errorsOf(r?.fulfillmentCancel);
    if (errs.length) throw new Skip(`Shopify would not cancel the shipment: ${errs[0]}`);
    return { fulfillmentId: f.shopifyFulfillmentId };
  }

  if (row.kind === 'MARK_PAID') {
    const r: any = await api.graphql(Q.paid, { input: { id: orderGid } });
    const errs = errorsOf(r?.orderMarkAsPaid);
    if (errs.length) {
      // Already paid there (marked by hand, or a retry after it worked): the goal is met.
      if (String(r?.orderMarkAsPaid?.order?.displayFinancialStatus ?? '') === 'PAID') return { note: 'Shopify already showed it paid.' };
      throw new Skip(`Shopify would not mark it paid: ${errs[0]}`);
    }
    return {};
  }
  throw new Skip(`Unknown update ${row.kind}.`);
}

/** One pass: every update that is due, oldest first. Returns one word per row, for the log and tests. */
export async function runOnce(apiFor: ApiFor, limit = 25): Promise<string[]> {
  const due = await prisma.shopifyOrderUpdate.findMany({
    where: { state: { in: ['PENDING', 'WAITING_PERMISSION'] }, nextAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' }, take: limit
  });
  const out: string[] = [];
  const apis = new Map<string, ShopifyAdminApi>();
  for (const row of due) {
    const installation = await prisma.shopifyInstallation.findFirst({ where: { clientId: row.clientId, uninstalledAt: null }, select: { id: true, shopDomain: true, scopes: true } });
    if (!installation) {
      await prisma.shopifyOrderUpdate.update({ where: { id: row.id }, data: { state: 'SKIPPED', lastError: 'The Shopify store is no longer connected.', doneAt: new Date() } });
      out.push('SKIPPED'); continue;
    }
    const needs = row.kind === 'MARK_PAID' ? NEEDED_SCOPES.paid : NEEDED_SCOPES.fulfil;
    const missing = needs.filter(s => !hasScope(installation.scopes ?? '', s));
    if (missing.length) {
      await prisma.shopifyOrderUpdate.update({ where: { id: row.id }, data: {
        state: 'WAITING_PERMISSION', nextAt: new Date(Date.now() + PERMISSION_RECHECK_MS),
        lastError: 'Shopify has not been told yet: the store must approve the app\'s new permissions (Settings → Storefront → Shopify).'
      } });
      out.push('WAITING_PERMISSION'); continue;
    }
    try {
      if (!apis.has(installation.id)) apis.set(installation.id, await apiFor(installation));
      const r = await send(row, apis.get(installation.id)!);
      await prisma.shopifyOrderUpdate.update({ where: { id: row.id }, data: {
        state: 'DONE', doneAt: new Date(), attempts: row.attempts + 1, lastError: r.note ?? null,
        ...(r.fulfillmentId ? { shopifyFulfillmentId: r.fulfillmentId } : {})
      } });
      out.push('DONE');
    } catch (e: any) {
      if (e instanceof NotYet) {
        await prisma.shopifyOrderUpdate.update({ where: { id: row.id }, data: { state: 'PENDING', nextAt: new Date(Date.now() + 30_000) } });
        out.push('NOT_YET'); continue;
      }
      if (e instanceof Skip) {
        await prisma.shopifyOrderUpdate.update({ where: { id: row.id }, data: { state: 'SKIPPED', lastError: e.message, doneAt: new Date(), attempts: row.attempts + 1 } });
        out.push('SKIPPED'); continue;
      }
      // Shopify busy, unreachable, or refusing the token: tried again later, then given up on, in words.
      const attempts = row.attempts + 1;
      const said = e instanceof ShopifyApiError ? e.message : 'Shopify could not be reached.';
      const last = attempts >= MAX_ATTEMPTS;
      await prisma.shopifyOrderUpdate.update({ where: { id: row.id }, data: {
        attempts, state: last ? 'FAILED' : 'PENDING', nextAt: new Date(Date.now() + backoffMs(attempts)),
        lastError: last ? `${said} Gave up after ${attempts} tries; press Try again.` : said
      } });
      if (!(e instanceof ShopifyApiError)) console.error(`[Shopify updates] ${row.kind} for ${row.salesOrderId} failed:`, e?.message);
      out.push(last ? 'FAILED' : 'RETRY');
    }
  }
  return out;
}

/** The order page's Shopify line: what Shopify has been told, and anything the shop must do. */
export async function forOrder(clientId: string, salesOrderId: string) {
  const rows = await prisma.shopifyOrderUpdate.findMany({ where: { clientId, salesOrderId }, orderBy: { createdAt: 'asc' } });
  return rows.map(r => ({
    id: r.id, kind: r.kind, event: r.event, state: r.state, note: r.lastError, at: (r.doneAt ?? r.createdAt).toISOString(),
    tracking: (r.detail as any)?.number ?? null
  }));
}

/** "Try again" on a failed or skipped one (the shop fixed the cause in Shopify). */
export async function retry(clientId: string, salesOrderId: string, id: string) {
  const row = await prisma.shopifyOrderUpdate.findFirst({ where: { id, clientId, salesOrderId } });
  if (!row) throw Object.assign(new Error('That Shopify update was not found.'), { statusCode: 404 });
  if (!['FAILED', 'SKIPPED', 'WAITING_PERMISSION'].includes(row.state)) throw Object.assign(new Error('That update is not waiting for anything.'), { statusCode: 409 });
  await prisma.shopifyOrderUpdate.update({ where: { id }, data: { state: 'PENDING', attempts: 0, nextAt: new Date(), lastError: null, doneAt: null } });
  return { queued: true };
}

export class ShopifyOrderUpdateWorker {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  static start(apiFor: ApiFor, intervalMs = 15_000) {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const r = await runOnce(apiFor);
        const said = r.filter(x => x !== 'NOT_YET');
        if (said.length) console.log(`[Shopify updates] ${said.join(', ')}`);
      } catch (e) {
        console.error('[Shopify updates] pass failed; will retry', e);
      } finally { this.running = false; }
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }
  static stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
