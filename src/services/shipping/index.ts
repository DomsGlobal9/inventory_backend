/**
 * Shipping, read side only (28 Oct 2026): how a parcel is shown, and Shopify's own fulfilment details.
 * Couriers are chosen, labels printed and deliveries reported by ScaleEzy Logistics (services/logistics).
 */
export { parcelView, PARCEL_SELECT, shippingFromShopify } from './parcels';
export { trackingFor } from './couriers';
