import { prisma } from '../../lib/prisma';
import { badRequest, notFound, conflict } from '../../utils/httpError';
import { usable, trackingFor } from './couriers';
import { paymentSummary } from '../payments/payment-rules';
import { toMinor } from '../pricing/money';

/**
 * WHO CARRIED A DISPATCH, ITS TRACKING NUMBER, AND WHETHER IT ARRIVED.
 *
 * A dispatch is still made exactly as before -- stock out, revenue in -- by dispatchService. This
 * only writes the parcel's courier details beside it: chosen in Create Dispatch, or added later on
 * the order page when the slip comes back from the counter. Nothing here moves stock or money.
 */

const NUMBER_MAX = 40;

function cleanNumber(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const n = String(raw).replace(/\s+/g, ' ').trim();
  if (!n) return null;
  if (n.length > NUMBER_MAX) throw badRequest(`A tracking number is at most ${NUMBER_MAX} letters and digits.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-/]*$/.test(n)) throw badRequest('A tracking number has only letters, digits, spaces, - and /.');
  return n;
}

/** What a dispatch row needs to remember about its courier, or null when none was chosen. */
export async function shippingFor(clientId: string, input: any) {
  if (!input || !input.courierId) return null;
  const c = await usable(clientId, input.courierId);
  return { courierId: c.id, courierName: c.name, trackingNumber: cleanNumber(input.trackingNumber) };
}

/**
 * The courier Shopify says carried a fulfilment, from the latest one that names a courier or number.
 * Not one of the shop's couriers: kept as Shopify spelled it, with Shopify's own link when it is https.
 */
export function shippingFromShopify(fulfillments: unknown) {
  const list = Array.isArray(fulfillments) ? fulfillments : [];
  for (const f of [...list].reverse()) {
    const status = String(f?.status ?? '').toLowerCase();
    if (status === 'cancelled' || status === 'error') continue;
    const company = typeof f?.tracking_company === 'string' ? f.tracking_company.trim().slice(0, 60) : '';
    const number = typeof f?.tracking_number === 'string' ? f.tracking_number.trim().slice(0, NUMBER_MAX) : '';
    if (!company && !number) continue;
    const url = typeof f?.tracking_url === 'string' && /^https:\/\//i.test(f.tracking_url.trim()) ? f.tracking_url.trim().slice(0, 500) : null;
    return { courierId: null, courierName: company || 'Courier', trackingNumber: number || null, trackingUrl: url };
  }
  return null;
}

/**
 * A parcel as the screens show it. `courierLink` is the courier's tracking page as it is now, so
 * fixing a wrong link in Settings fixes every parcel sent with that courier.
 */
export function parcelView(d: any) {
  const own = d.trackingUrl ? { url: d.trackingUrl, copies: false } : null;
  const tracking = own ?? trackingFor(d.courier?.trackingLink, d.trackingNumber);
  return {
    id: d.id,
    dispatchNumber: d.dispatchNumber,
    status: d.status,
    sentAt: d.dispatchedAt,
    courierId: d.courierId ?? null,
    courierName: d.courierName ?? null,
    trackingNumber: d.trackingNumber ?? null,
    trackingUrl: tracking?.url ?? null,
    copyNumber: tracking?.copies ?? false,
    needsNumber: d.courier ? d.courier.needsNumber : !!d.courierName,
    deliveredAt: d.deliveredAt ?? null,
    pieces: (d.items ?? []).reduce((t: number, i: any) => t + (i.quantity ?? 0), 0)
  };
}

export const PARCEL_SELECT = {
  id: true, dispatchNumber: true, status: true, dispatchedAt: true,
  courierId: true, courierName: true, trackingNumber: true, trackingUrl: true, deliveredAt: true,
  courier: { select: { trackingLink: true, needsNumber: true } },
  items: { select: { quantity: true } }
} as const;

async function find(clientId: string, dispatchId: string) {
  const d = await prisma.dispatch.findFirst({ where: { id: dispatchId, clientId }, select: { ...PARCEL_SELECT, salesOrderId: true } });
  if (!d) throw notFound('That dispatch could not be found.');
  if (d.status === 'CANCELLED') throw conflict('This dispatch was cancelled.');
  return d;
}

/** Choose or change the courier and tracking number of a dispatch already made. */
export async function setParcel(clientId: string, dispatchId: string, body: any) {
  const d = await find(clientId, dispatchId);
  let data: any;
  if (body?.courierId === null || body?.courierId === '') {
    // Taken off by mistake: the parcel goes back to having no courier, and so cannot be "delivered".
    data = { courierId: null, courierName: null, trackingNumber: null, trackingUrl: null, deliveredAt: null, status: 'SHIPPED' };
  } else {
    const courier = body?.courierId !== undefined && body.courierId !== d.courierId ? await usable(clientId, body.courierId) : null;
    if (!courier && !d.courierName) throw badRequest('Choose the courier first.');
    data = {
      ...(courier ? { courierId: courier.id, courierName: courier.name, trackingUrl: null } : {}),
      ...(body?.trackingNumber !== undefined ? { trackingNumber: cleanNumber(body.trackingNumber) } : {})
    };
  }
  const saved = await prisma.dispatch.update({ where: { id: d.id }, data, select: PARCEL_SELECT });
  return parcelView(saved);
}

/** Reached the customer, or (a mistake) not yet. */
export async function setDelivered(clientId: string, dispatchId: string, delivered: unknown) {
  const d = await find(clientId, dispatchId);
  if (!d.courierName) throw badRequest('Choose who carried it first. A parcel with no courier is not tracked.');
  const yes = delivered !== false;
  const saved = await prisma.dispatch.update({
    where: { id: d.id },
    data: yes ? { status: 'DELIVERED', deliveredAt: d.deliveredAt ?? new Date() } : { status: 'SHIPPED', deliveredAt: null },
    select: PARCEL_SELECT
  });
  return parcelView(saved);
}

/**
 * Everything the label on the box needs: who it goes to, who it is from (and goes back to if it
 * cannot be delivered), the courier and tracking number, and the cash the courier must collect.
 *
 * Cash to collect is what is still owed on the order -- never the order total: a customer who paid
 * an advance, or paid online, must not be asked to pay again at the door. A Shopify order is paid on
 * Shopify, so nothing is collected for it here.
 */
const LABEL_SELECT = {
  ...PARCEL_SELECT,
  createdAt: true,
  salesOrder: {
    select: {
      id: true, orderNumber: true, sourceSystem: true, total: true, roundOff: true, writtenOff: true,
      customerName: true, customerPhone: true, shippingAddress: true,
      customer: { select: { name: true, phone: true } },
      location: { select: { name: true, address: true, phone: true } },
      payments: { select: { kind: true, amount: true } },
      // Which parcel of the order is the first: only that one carries the cash (see below).
      dispatches: { where: { status: { not: 'CANCELLED' as const } }, orderBy: { createdAt: 'asc' as const }, select: { id: true, dispatchNumber: true }, take: 1 }
    }
  }
} as const;

async function labelsOf(clientId: string, rows: any[]) {
  const shop = await prisma.clientSettings.findUnique({
    where: { clientId },
    select: { businessName: true, businessAddress: true, businessPhone: true, logoUrl: true }
  });
  return rows.map((d) => {
    const o = d.salesOrder;
    const pay = paymentSummary(toMinor(o.total) + toMinor(o.roundOff ?? 0), o.payments, toMinor(o.writtenOff ?? 0));
    /*
     * An order sent in two parcels must not be collected for twice. The cash goes on its FIRST
     * parcel only; any later parcel says it was collected with that one.
     */
    const first = o.dispatches[0];
    const isFirst = !first || first.id === d.id;
    const due = o.sourceSystem === 'SHOPIFY' ? 0 : pay.due;
    return {
      parcel: parcelView(d),
      orderNumber: o.orderNumber,
      to: {
        name: o.customerName || o.customer?.name || null,
        phone: o.customerPhone || o.customer?.phone || null,
        address: o.shippingAddress || null
      },
      from: {
        name: shop?.businessName || o.location?.name || null,
        // The store's own address and phone first, as on the bill.
        address: o.location?.address || shop?.businessAddress || null,
        phone: o.location?.phone || shop?.businessPhone || null,
        logoUrl: shop?.logoUrl ?? null
      },
      cashToCollect: isFirst ? due : 0,
      cashWithParcel: !isFirst && due > 0 ? first.dispatchNumber : null
    };
  });
}

/**
 * Everything the label on the box needs: who it goes to, who it is from (and goes back to if it
 * cannot be delivered), the courier and tracking number, and the cash the courier must collect.
 *
 * Cash to collect is what is still owed on the order -- never the order total: a customer who paid
 * an advance, or paid online, must not be asked to pay again at the door. A Shopify order is paid on
 * Shopify, so nothing is collected for it here.
 */
export async function label(clientId: string, dispatchId: string) {
  const d = await prisma.dispatch.findFirst({ where: { id: dispatchId, clientId }, select: LABEL_SELECT });
  if (!d) throw notFound('That dispatch could not be found.');
  return (await labelsOf(clientId, [d]))[0];
}

const MAX_ORDERS = 100;

/**
 * Labels for many orders at once (Orders → tick → Print labels): one per parcel sent, in the order
 * the orders were ticked. An order with nothing sent yet has no parcel and so no label -- it is named
 * in `notSent`, never silently left out.
 */
export async function labels(clientId: string, orderIds: unknown) {
  const ids = Array.isArray(orderIds) ? [...new Set(orderIds.map(String).filter(Boolean))] : [];
  if (!ids.length) throw badRequest('Tick at least one order.');
  if (ids.length > MAX_ORDERS) throw badRequest(`Print at most ${MAX_ORDERS} orders' labels at a time.`);
  const [orders, rows] = await Promise.all([
    prisma.salesOrder.findMany({ where: { clientId, id: { in: ids }, deletedAt: null }, select: { id: true, orderNumber: true } }),
    prisma.dispatch.findMany({
      where: { clientId, salesOrderId: { in: ids }, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'asc' },
      select: { ...LABEL_SELECT, salesOrderId: true }
    })
  ]);
  const rank = new Map(ids.map((id, n) => [id, n]));
  rows.sort((a: any, b: any) => (rank.get(a.salesOrderId)! - rank.get(b.salesOrderId)!) || (a.createdAt.getTime() - b.createdAt.getTime()));
  const sent = new Set(rows.map((r: any) => r.salesOrderId));
  return {
    labels: await labelsOf(clientId, rows),
    notSent: orders.filter(o => !sent.has(o.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).map(o => o.orderNumber)
  };
}

/**
 * Mark delivered for many orders at once (Orders → tick → Mark delivered). Every parcel of those
 * orders that has a courier and has not arrived yet becomes DELIVERED, now. An order is skipped,
 * by name and why, when nothing of it was sent or no parcel of it has a courier -- a hand-over at
 * the counter is not "delivered" by a courier. Parcels already delivered keep their own date.
 */
export async function deliverMany(clientId: string, orderIds: unknown) {
  const ids = Array.isArray(orderIds) ? [...new Set(orderIds.map(String).filter(Boolean))] : [];
  if (!ids.length) throw badRequest('Tick at least one order.');
  if (ids.length > MAX_ORDERS) throw badRequest(`Mark at most ${MAX_ORDERS} orders at a time.`);
  const orders = await prisma.salesOrder.findMany({
    where: { clientId, id: { in: ids }, deletedAt: null },
    select: { id: true, orderNumber: true, dispatches: { where: { status: { not: 'CANCELLED' } }, select: { id: true, status: true, courierName: true } } }
  });
  const now = new Date();
  const toMark: string[] = [];
  const skipped: { orderNumber: string; why: string }[] = [];
  let already = 0;
  for (const o of orders) {
    if (!o.dispatches.length) { skipped.push({ orderNumber: o.orderNumber, why: 'not sent yet' }); continue; }
    const carried = o.dispatches.filter(d => d.courierName);
    if (!carried.length) { skipped.push({ orderNumber: o.orderNumber, why: 'no courier on its parcel' }); continue; }
    const open = carried.filter(d => d.status !== 'DELIVERED');
    if (!open.length) already++;
    toMark.push(...open.map(d => d.id));
  }
  const done = toMark.length
    ? await prisma.dispatch.updateMany({ where: { clientId, id: { in: toMark }, status: { not: 'DELIVERED' } }, data: { status: 'DELIVERED', deliveredAt: now } })
    : { count: 0 };
  return { parcels: done.count, alreadyDelivered: already, skipped };
}
