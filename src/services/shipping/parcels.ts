import { trackingFor } from './couriers';

/**
 * Parcels, as the screens show them (read side only, since 28 Oct 2026).
 *
 * Shipping is done by ScaleEzy Logistics: it books the courier through Shiprocket, prints the label and
 * reports back (services/logistics/parcels), writing the courier, number and delivery onto the
 * dispatch. Inventory no longer chooses couriers, types tracking numbers, marks parcels delivered or
 * prints its own labels. What is kept: how a parcel is shown, and Shopify's own fulfilment details.
 */

const NUMBER_MAX = 40;

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

/** A parcel as the screens show it. */
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
