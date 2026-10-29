import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { runTransaction } from '../../lib/txRetry';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { dispatchService } from '../dispatch.service';
import { paymentSummary } from '../payments/payment-rules';
import { toMinor } from '../pricing/money';
import { collectPayment } from '../order-payments';
import * as shopifyUpdates from '../shopify-orders/updates';

/**
 * Packing for ScaleEzy Logistics (28 Oct).
 *
 * In a shop that has switched Logistics on, staff pick an order from the shelves (Shelves → Pick, as
 * before), then PACK it here: a box from the shop's sizes, the real weight off the scale. Packing is
 * the dispatch -- stock leaves from the shelves picked, exactly as "Send out" does -- plus a parcel
 * row, in ONE transaction. A trigger sends the parcel to Logistics as parcel.ready with everything it
 * needs to book a courier: order, customer, address, cash to collect, items, box and weight.
 *
 * Logistics answers on POST .../parcels/:id/updates (fromLogistics): booked with courier, AWB and
 * label; delivered; returned; COD collected. Those land where the existing courier feature already
 * reads them (the dispatch's courier, tracking and delivered date), so the order page, labels, the
 * Orders filters and "to collect" keep working unchanged.
 */

export const DEFAULT_BOXES = [
  { name: 'Small', lengthCm: 25, breadthCm: 20, heightCm: 4 },
  { name: 'Medium', lengthCm: 35, breadthCm: 30, heightCm: 6 },
  { name: 'Large', lengthCm: 45, breadthCm: 35, heightCm: 10 }
];
const MAX_BOXES = 8;
const MAX_CM = 200;
const MAX_KG = 100;

export const STATUSES = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT', 'RTO_INITIATED', 'RTO_DELIVERED', 'CANCELLED', 'LOST'] as const;
type Status = typeof STATUSES[number];

const num = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? null : Number(d));
const cm = (v: unknown) => {
  const n = Math.round(Number(v) * 10) / 10;
  return Number.isFinite(n) && n > 0 && n <= MAX_CM ? n : null;
};

/** Is this shop on Logistics? Packing is offered only then. */
export async function isOn(clientId: string) {
  return !!(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId, module: 'logistics' } }, select: { clientId: true } }));
}

/** The shop's box sizes; the three defaults the first time it is asked. */
export async function boxes(clientId: string) {
  let rows = await prisma.shippingBox.findMany({ where: { clientId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  if (!rows.length) {
    await prisma.shippingBox.createMany({ data: DEFAULT_BOXES.map((b, i) => ({ clientId, ...b, sortOrder: i })), skipDuplicates: true });
    rows = await prisma.shippingBox.findMany({ where: { clientId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  }
  return rows.map(b => ({ id: b.id, name: b.name, lengthCm: num(b.lengthCm), breadthCm: num(b.breadthCm), heightCm: num(b.heightCm) }));
}

/** Replace the shop's box sizes (Settings). 1 to 8, each named once, each side 0.1 to 200 cm. */
export async function saveBoxes(clientId: string, raw: unknown) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length < 1) throw badRequest('Keep at least one box size.');
  if (list.length > MAX_BOXES) throw badRequest(`Up to ${MAX_BOXES} box sizes.`);
  const seen = new Set<string>();
  const clean = list.map((b: any, i: number) => {
    const name = typeof b?.name === 'string' ? b.name.trim().slice(0, 30) : '';
    if (!name) throw badRequest(`Box ${i + 1} needs a name.`);
    if (seen.has(name.toLowerCase())) throw badRequest(`"${name}" is there twice.`);
    seen.add(name.toLowerCase());
    const [l, w, h] = [cm(b?.lengthCm), cm(b?.breadthCm), cm(b?.heightCm)];
    if (l === null || w === null || h === null) throw badRequest(`"${name}": each side between 0.1 and ${MAX_CM} cm.`);
    return { clientId, name, lengthCm: l, breadthCm: w, heightCm: h, sortOrder: i };
  });
  await prisma.$transaction([
    prisma.shippingBox.deleteMany({ where: { clientId } }),
    prisma.shippingBox.createMany({ data: clean })
  ]);
  return boxes(clientId);
}

const PINCODE = /\b[1-9]\d{5}\b/;

/**
 * Pack one order (or the part of it picked): its dispatch and its parcel, together.
 * `items` as Shelves → Pick sends them: { salesOrderItemId, quantity, fromSpots? }.
 */
export async function pack(clientId: string, by: { id: string | null; name: string | null }, body: any) {
  if (!(await isOn(clientId))) throw conflict('Logistics is not switched on for this shop. Send the order out as before.');
  const salesOrderId = typeof body?.salesOrderId === 'string' ? body.salesOrderId : '';
  if (!salesOrderId) throw badRequest('Which order is missing.');
  const kg = Number(body?.weightKg);
  if (!Number.isFinite(kg) || kg <= 0) throw badRequest('Weigh the parcel and enter its weight in kg.');
  if (kg > MAX_KG) throw badRequest(`${kg} kg is more than one parcel can be (${MAX_KG} kg). Check the weight.`);
  const weightGrams = Math.round(kg * 1000);

  // The box: one of the shop's sizes by name, or sides typed for this parcel.
  let box: { name: string | null; l: number; w: number; h: number };
  if (typeof body?.box === 'string' && body.box.trim()) {
    const found = (await boxes(clientId)).find(b => b.name.toLowerCase() === body.box.trim().toLowerCase());
    if (!found) throw badRequest(`There is no box called "${body.box.trim()}". Choose one of your box sizes.`);
    box = { name: found.name, l: found.lengthCm!, w: found.breadthCm!, h: found.heightCm! };
  } else {
    const [l, w, h] = [cm(body?.lengthCm), cm(body?.breadthCm), cm(body?.heightCm)];
    if (l === null || w === null || h === null) throw badRequest('Choose a box, or enter its length, breadth and height in cm.');
    box = { name: null, l, w, h };
  }

  // Checked before anything moves: Logistics cannot book a parcel with nowhere to go.
  const order = await prisma.salesOrder.findFirst({
    where: { id: salesOrderId, clientId, deletedAt: null },
    select: { id: true, shippingAddress: true, customerPhone: true, customer: { select: { phone: true } }, location: { select: { name: true, address: true, phone: true } } }
  });
  if (!order) throw notFound('That order was not found.');
  if (!order.shippingAddress?.trim()) throw badRequest('This order has no delivery address. Add it on the order, then pack it.');
  if (!(order.customerPhone || order.customer?.phone)) throw badRequest('This order has no phone number for the courier. Add it on the order, then pack it.');
  // The pickup: the courier comes to this store, so Logistics needs its address and phone.
  if (!order.location.address?.trim() || !order.location.phone?.trim()) {
    throw badRequest(`${order.location.name} has no ${!order.location.address?.trim() ? 'address' : 'phone number'} saved, so the courier cannot be sent to pick up. Add it in Settings → Stock locations, then pack.`);
  }

  return runTransaction(async (tx) => {
    const dispatch = await dispatchService.dispatchInTransaction(tx, clientId, salesOrderId, body?.items ?? [], {});
    const payload = await payloadFor(tx, clientId, salesOrderId, dispatch, { box, weightGrams, by });
    const parcel = await tx.logisticsParcel.create({
      data: {
        clientId, salesOrderId, dispatchId: dispatch.id, locationId: payload.pickup.location_id,
        boxName: box.name, lengthCm: box.l, breadthCm: box.w, heightCm: box.h, weightGrams,
        packedById: by.id, packedByName: by.name, payload: payload as any
      }
    });
    // The payload names its own row, so Logistics can answer about it.
    const withId = { ...payload, parcel_id: parcel.id };
    await tx.logisticsParcel.update({ where: { id: parcel.id }, data: { payload: withId as any } });
    await tx.moduleEvent.updateMany({ where: { clientId, module: 'logistics', rowId: parcel.id, kind: 'parcel.ready' }, data: { payload: withId as any } });
    return view({ ...parcel, payload: withId, dispatchNumber: dispatch.dispatchNumber });
  }, {
    label: 'pack an order for Logistics',
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    tooSlowMessage: 'Packing took too long, so nothing was recorded. Try again.'
  });
}

/** Everything Logistics needs to book the courier, read inside the packing transaction. */
async function payloadFor(tx: any, clientId: string, salesOrderId: string, dispatch: any, p: { box: { name: string | null; l: number; w: number; h: number }; weightGrams: number; by: { name: string | null } }) {
  const o = await tx.salesOrder.findUniqueOrThrow({
    where: { id: salesOrderId },
    select: {
      id: true, orderNumber: true, createdAt: true, channel: true, sourceSystem: true, payOnDelivery: true,
      total: true, roundOff: true, writtenOff: true, shippingAddress: true,
      customerName: true, customerPhone: true, customer: { select: { name: true, phone: true, email: true } },
      location: { select: { id: true, name: true, address: true, phone: true } },
      payments: { select: { kind: true, amount: true } },
      dispatches: { where: { status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'asc' }, select: { id: true }, take: 1 },
      items: { select: { id: true, quantity: true, totalPrice: true, hsnCode: true, taxRateBps: true, variant: { select: { sku: true, colorName: true, size: true, product: { select: { title: true } } } } } }
    }
  });
  const pay = paymentSummary(toMinor(o.total) + toMinor(o.roundOff ?? 0), o.payments, toMinor(o.writtenOff ?? 0));
  // Cash goes on the order's FIRST parcel only (as the label does), and a Shopify order is collected
  // at the door only when it is cash on delivery -- otherwise Shopify has the money.
  const first = !o.dispatches[0] || o.dispatches[0].id === dispatch.id;
  const dueMinor = o.sourceSystem === 'SHOPIFY' && !o.payOnDelivery ? 0 : toMinor(pay.due);
  const codMinor = first ? Math.max(0, dueMinor) : 0;
  const items = dispatch.items.map((d: any) => {
    const it = o.items.find((i: any) => i.id === d.salesOrderItemId);
    const parts = [it.variant.colorName, it.variant.size && it.variant.size.toLowerCase() !== 'free' ? it.variant.size : null].filter(Boolean);
    const unit = Math.round((toMinor(it.totalPrice) / Math.max(1, it.quantity))) / 100;
    return {
      sku: it.variant.sku,
      name: parts.length ? `${it.variant.product.title} - ${parts.join(' / ')}` : it.variant.product.title,
      units: d.quantity,
      selling_price: unit,
      discount: 0,
      tax_rate: it.taxRateBps === null ? null : it.taxRateBps / 100,
      hsn_code: it.hsnCode ?? null
    };
  });
  const address = o.shippingAddress?.trim() ?? '';
  return {
    parcel_id: null as string | null,
    order_number: o.orderNumber,
    dispatch_number: dispatch.dispatchNumber,
    order_date: o.createdAt.toISOString(),
    channel: o.channel,
    pickup: { location_id: o.location.id, name: o.location.name, address: o.location.address ?? null, phone: o.location.phone ?? null },
    customer: {
      name: o.customerName || o.customer?.name || null,
      phone: o.customerPhone || o.customer?.phone || null,
      email: o.customer?.email ?? null,
      // As the shop wrote it: one block of text. The pincode is picked out when there is one.
      address: { text: address, pincode: PINCODE.exec(address)?.[0] ?? null }
    },
    payment: { method: codMinor > 0 ? 'COD' : 'PREPAID', cod_amount: codMinor / 100 },
    items,
    sub_total: Math.round(items.reduce((t: number, i: any) => t + i.selling_price * i.units * 100, 0)) / 100,
    package: { box: p.box.name, length_cm: p.box.l, breadth_cm: p.box.w, height_cm: p.box.h, weight_kg: p.weightGrams / 1000 },
    packed_by: p.by.name,
    packed_at: new Date().toISOString()
  };
}

const view = (p: any) => ({
  id: p.id, salesOrderId: p.salesOrderId, dispatchId: p.dispatchId, dispatchNumber: p.dispatchNumber ?? p.payload?.dispatch_number ?? null,
  box: p.boxName, lengthCm: num(p.lengthCm), breadthCm: num(p.breadthCm), heightCm: num(p.heightCm), weightKg: p.weightGrams / 1000,
  status: p.status, courierName: p.courierName ?? null, awb: p.awb ?? null, trackingUrl: p.trackingUrl ?? null, labelUrl: p.labelUrl ?? null,
  codCollected: num(p.codCollected), packedAt: p.packedAt, packedBy: p.packedByName ?? null, lastStatusAt: p.lastStatusAt ?? null
});

/** The parcels of these orders, for the packing screen (it waits for the label). */
export async function forOrders(clientId: string, orderIds: string[]) {
  const ids = orderIds.filter(Boolean).slice(0, 100);
  if (!ids.length) return [];
  const rows = await prisma.logisticsParcel.findMany({ where: { clientId, salesOrderId: { in: ids } }, orderBy: { packedAt: 'asc' } });
  return rows.map(view);
}

/** Two history entries alike, whatever order their keys come back in (jsonb reorders them). */
const same = (a: any, b: any) => {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
  return keys.every(k => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]));
};

/**
 * Logistics telling us what happened. Repeating an update is harmless; one older than the last we have
 * changes nothing. Lands on the dispatch where the courier feature reads it.
 */
export async function fromLogistics(clientId: string, parcelId: string, body: any) {
  const status = String(body?.status ?? '').toUpperCase() as Status;
  if (!(STATUSES as readonly string[]).includes(status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}.`);
  const at = body?.at ? new Date(body.at) : new Date();
  if (Number.isNaN(at.getTime())) throw badRequest('at must be an ISO date-time.');
  if (at.getTime() > Date.now() + 10 * 60_000) throw badRequest('at is in the future.');
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const url = (v: unknown) => { const s = text(v, 1000); return s && /^https:\/\//i.test(s) ? s : null; };
  const courier = text(body?.courier, 60), awb = text(body?.awb, 40), note = text(body?.note, 300);
  const trackingUrl = url(body?.tracking_url), labelUrl = url(body?.label_url);
  if (body?.label_url && !labelUrl) throw badRequest('label_url must be an https address.');
  const cod = body?.cod_collected === null || body?.cod_collected === undefined ? null : Number(body.cod_collected);
  if (cod !== null && (!Number.isFinite(cod) || cod < 0 || cod > 1e8)) throw badRequest('cod_collected must be an amount in rupees.');

  const parcel = await prisma.logisticsParcel.findFirst({ where: { id: parcelId, clientId } });
  if (!parcel) throw notFound('No such parcel in this shop.');

  const history = Array.isArray(parcel.history) ? parcel.history as any[] : [];
  const entry = { status, at: at.toISOString(), ...(courier ? { courier } : {}), ...(awb ? { awb } : {}), ...(note ? { note } : {}), ...(cod !== null ? { cod_collected: cod } : {}) };
  // Exactly the same update again (a retry): nothing new. The same status and time carrying something
  // more (the COD amount, a label) is new news and is applied.
  if (history.some(h => same(h, entry)) && !labelUrl && !trackingUrl) return { applied: false, parcel: view(parcel) };
  const older = parcel.lastStatusAt && at < parcel.lastStatusAt;

  const data: any = {
    history: [...history, entry],
    ...(courier ? { courierName: courier } : {}), ...(awb ? { awb } : {}),
    ...(trackingUrl ? { trackingUrl } : {}), ...(labelUrl ? { labelUrl } : {}),
    ...(older ? {} : { status, lastStatusAt: at })
  };
  const saved = await prisma.logisticsParcel.update({ where: { id: parcel.id }, data });

  // Onto the dispatch, where the order page, labels and filters read it (only for the latest news).
  if (!older) {
    const dispatchData: any = {};
    if (courier) dispatchData.courierName = courier;
    if (awb) dispatchData.trackingNumber = awb;
    if (trackingUrl) dispatchData.trackingUrl = trackingUrl;
    if (status === 'DELIVERED') { dispatchData.status = 'DELIVERED'; dispatchData.deliveredAt = at; }
    if (Object.keys(dispatchData).length) await prisma.dispatch.update({ where: { id: parcel.dispatchId }, data: dispatchData });
  }

  // A Shopify order: Shopify is told (shipped with tracking, delivery progress, cancelled), by the worker.
  // Before the cash below, so Shopify hears "delivered" before "paid".
  await shopifyUpdates.fromParcelUpdate(clientId, parcel.id, status);

  // Cash the courier collected and paid over: recorded once on the order, never more than is owed.
  let codRecorded = false;
  if (cod !== null && cod > 0 && parcel.codCollected === null) {
    let dueRupees = 0;
    try {
      const due = await prisma.salesOrder.findUnique({ where: { id: parcel.salesOrderId }, select: { total: true, roundOff: true, writtenOff: true, sourceSystem: true, payments: { select: { kind: true, amount: true } } } });
      // paymentSummary's `due` is in rupees (order-payments converts it with toMinor).
      dueRupees = due ? Number(paymentSummary(toMinor(due.total) + toMinor(due.roundOff ?? 0), due.payments, toMinor(due.writtenOff ?? 0)).due) : 0;
      // A Shopify order is marked paid ON Shopify, and Shopify's paid webhook records the money here.
      if (due?.sourceSystem === 'SHOPIFY') await shopifyUpdates.fromCodCollected(clientId, parcel.salesOrderId, cod, dueRupees);
      const amount = Math.min(cod, dueRupees);
      if (amount > 0 && due?.sourceSystem !== 'SHOPIFY') {
        const r = await collectPayment(clientId, null, parcel.salesOrderId, { method: 'BANK_TRANSFER', amount, reference: `COD ${awb ?? saved.awb ?? ''}`.trim().slice(0, 40), key: `LOGISTICS-COD:${parcel.id}` });
        codRecorded = r.recorded;
      }
    } catch (e: any) {
      // A Shopify order (Shopify marks it paid) or one already settled: the parcel still remembers the cash.
      console.warn(`[Logistics] COD for parcel ${parcel.id} not recorded on the order: ${e?.message}`);
    }
    await prisma.logisticsParcel.update({ where: { id: parcel.id }, data: { codCollected: cod } });
  }
  const final = await prisma.logisticsParcel.findUniqueOrThrow({ where: { id: parcel.id } });
  return { applied: true, older: !!older, codRecorded, parcel: view(final) };
}
