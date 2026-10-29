/**
 * Where a customer's parcels have got to, for the shop's order page (29 Oct).
 *
 * For a shop on ScaleEzy Logistics the dispatch is made at PACKING, before any courier has it, so the
 * dispatch alone would tell the customer "on its way" while the parcel still sits in the shop. When a
 * Logistics parcel exists its own status (services/logistics: READY until booked, then what Logistics
 * sends) decides; older dispatches (made before Logistics, or by hand) fall back to the dispatch.
 *
 * The customer sees the tracking number and the tracking page only -- not the courier's name, which
 * Logistics chooses and may change, and which tells a customer nothing they can act on.
 */

export type Stage =
  | 'PACKED'            // packed, no courier yet
  | 'BOOKED'            // a courier is booked; it collects soon
  | 'ON_ITS_WAY'
  | 'OUT_FOR_DELIVERY'
  | 'MISSED'            // a delivery attempt failed; the courier tries again
  | 'DELIVERED'
  | 'RETURNING'         // going back to the shop (RTO)
  | 'PROBLEM'           // lost
  | 'REARRANGING';      // Logistics cancelled the booking; the shop books it again

export type OrderState =
  | 'PLACED' | 'PACKED' | 'PART_PACKED' | 'PART_SENT' | 'SENT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'TROUBLE' | 'CANCELLED';

const FROM_LOGISTICS: Record<string, Stage> = {
  READY: 'PACKED', BOOKED: 'BOOKED',
  PICKED_UP: 'ON_ITS_WAY', IN_TRANSIT: 'ON_ITS_WAY', OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  FAILED_ATTEMPT: 'MISSED', DELIVERED: 'DELIVERED',
  RTO_INITIATED: 'RETURNING', RTO_DELIVERED: 'RETURNING',
  LOST: 'PROBLEM', CANCELLED: 'REARRANGING'
};

/** Stages that mean the courier has the parcel (or had it, and handed it over). */
const MOVING: Stage[] = ['ON_ITS_WAY', 'OUT_FOR_DELIVERY', 'MISSED', 'DELIVERED'];

type Logistics = { dispatchId: string; status: string; awb: string | null; trackingUrl: string | null; lastStatusAt: Date | null };
/** A dispatch as services/shipping parcelView gives it. */
type Viewed = { id: string; status: string; trackingNumber: string | null; trackingUrl: string | null; copyNumber: boolean; sentAt: Date | null; deliveredAt: Date | null };

export function stageOf(d: Viewed, lp: Logistics | undefined): Stage {
  // Marked delivered on the dispatch (by Logistics' DELIVERED, or by the shop by hand): delivered.
  if (d.status === 'DELIVERED') return 'DELIVERED';
  if (lp) return FROM_LOGISTICS[lp.status] ?? 'PACKED';
  // No Logistics: a dispatch not yet sent is packed; a sent one is on its way.
  return ['PENDING', 'PICKING', 'PACKED'].includes(d.status) ? 'PACKED' : 'ON_ITS_WAY';
}

export type CustomerParcel = {
  stage: Stage;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** An old courier whose page cannot take the number in its link: the page copies it first. */
  copyNumber: boolean;
  deliveredAt: string | null;
  at: string | null;
};

/** The order's parcels for the customer: never a cancelled dispatch, never a courier name. */
export function customerParcels(dispatches: Viewed[], logistics: Logistics[]): CustomerParcel[] {
  const byDispatch = new Map(logistics.map(l => [l.dispatchId, l]));
  return dispatches.filter(d => d.status !== 'CANCELLED').map(d => {
    const lp = byDispatch.get(d.id);
    const stage = stageOf(d, lp);
    const number = lp?.awb ?? d.trackingNumber ?? null;
    // Logistics' own page first (https only, checked when it came in); else the old courier link.
    const url = lp?.trackingUrl ?? (lp ? null : d.trackingUrl) ?? null;
    return {
      stage,
      trackingNumber: number,
      trackingUrl: url,
      copyNumber: !lp?.trackingUrl && !!d.copyNumber && !!url,
      deliveredAt: d.deliveredAt ? new Date(d.deliveredAt).toISOString() : null,
      at: (lp?.lastStatusAt ?? d.sentAt) ? new Date((lp?.lastStatusAt ?? d.sentAt) as Date).toISOString() : null
    };
  });
}

/**
 * The one line at the top of the page. "Delivered" only when every piece has gone out
 * (DISPATCHED, not PARTIALLY_DISPATCHED) and every parcel has arrived.
 */
export function orderStateOf(orderStatus: string, parcels: CustomerParcel[]): OrderState {
  if (orderStatus === 'CANCELLED') return 'CANCELLED';
  if (!parcels.length) return 'PLACED';
  const part = orderStatus === 'PARTIALLY_DISPATCHED';
  if (!part && parcels.every(p => p.stage === 'DELIVERED')) return 'DELIVERED';
  const open = parcels.filter(p => p.stage !== 'DELIVERED');
  // Every parcel still out is going back or lost: say so, rather than "on its way".
  if (!part && open.length && open.every(p => p.stage === 'RETURNING' || p.stage === 'PROBLEM')) return 'TROUBLE';
  const moving = parcels.some(p => MOVING.includes(p.stage));
  if (part) return moving ? 'PART_SENT' : 'PART_PACKED';
  if (open.some(p => p.stage === 'OUT_FOR_DELIVERY')) return 'OUT_FOR_DELIVERY';
  return moving ? 'SENT' : 'PACKED';
}

/** The four dots: Placed, Packed, On its way, Delivered. */
export function progressOf(state: OrderState, parcels: CustomerParcel[]) {
  return {
    packed: parcels.length > 0,
    moving: parcels.some(p => MOVING.includes(p.stage)),
    delivered: state === 'DELIVERED'
  };
}
