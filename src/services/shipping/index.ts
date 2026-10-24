/**
 * Shipping: the shop's couriers, and which courier carried each dispatch. Names and tracking
 * numbers only -- no booking with any courier's systems (decided 24 Oct 2026).
 */
import * as couriers from './couriers';
import * as parcels from './parcels';

export { couriers, parcels };
export { parcelView, PARCEL_SELECT, shippingFor, shippingFromShopify } from './parcels';
export { trackingFor, COMMON_COURIERS } from './couriers';
