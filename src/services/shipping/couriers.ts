/**
 * Couriers (read side only, since 28 Oct 2026). Shipping is done by ScaleEzy Logistics, which chooses
 * the courier through Shiprocket; Inventory no longer keeps a list of couriers to choose from. The
 * shop_couriers table and each dispatch's courier columns stay, so parcels sent before -- and Shopify's
 * own fulfilments -- still show who carried them and how to track them.
 */

/**
 * The link that opens one parcel's tracking. `copies` is true when the page does not take the
 * number in its address, so the screen copies it for pasting.
 */
export function trackingFor(link: string | null | undefined, number: string | null | undefined): { url: string; copies: boolean } | null {
  if (!link) return null;
  if (link.includes('{number}')) {
    // Nothing to put in the link yet: no button, rather than a tracking page asking for a number.
    if (!number) return null;
    return { url: link.split('{number}').join(encodeURIComponent(number)), copies: false };
  }
  return { url: link, copies: !!number };
}
