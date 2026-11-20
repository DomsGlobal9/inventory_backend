import { prisma } from '../../lib/prisma';
import { toMinor } from '../pricing/money';
import { paymentSummary } from '../payments/payment-rules';
import { salesOrderService } from '../sales-order.service';
import * as onlinePayments from '../payments/online-payment.service';
import { pack as logisticsPack } from '../logistics/parcels';
import { SHOP_SOURCE } from '../online-shop/checkout';
import { factorOf } from '../../lib/units';
import { problem, type Actor } from './index';

/**
 * Online orders through the boutique API (20 Nov 2026, PLAN-shop-api.md "Orders are run in the Boutique app").
 *
 * The Boutique app's own shop runs on Shop API v1; its orders are Inventory's online-shop orders (stock held the moment
 * they are placed, in the Day Book, in Logistics). Here the boutique's staff see them and act on them, server to server,
 * as a named person: cancel (an online payment goes back), refund part, and pack for shipping -- after which Logistics
 * books the courier, and "shipped", tracking and "delivered" come from Logistics, never typed in.
 * Reading: anyone of the boutique. Acting: orders:write.
 */
const mustAct = (a: Actor) => { if (!a.can.includes('orders:write')) throw problem('This person may not act on orders.', 403); };
const by = (a: Actor) => `${a.name} (Boutique)`;
const rupees = (minor: number) => Math.round(minor) / 100;

/** Which online shop is this client's, and the Shop API v1 address the app uses for it. */
export async function whichShop(a: Actor) {
  const shop = await prisma.onlineShop.findUnique({ where: { clientId: a.clientId }, select: { slug: true, isLive: true, acceptsOrders: true } });
  if (!shop) return { slug: null, open: false, takingOrders: false, note: 'This client has no online shop yet. ScaleEzy sets one up.' };
  const base = (process.env.SHOP_BASE_URL || 'https://shop.scaleezy.com').replace(/\/+$/, '');
  // open: shoppers can see it. takingOrders: they can also order. The owner switches both (settings).
  return { slug: shop.slug, open: shop.isLive, takingOrders: shop.isLive && shop.acceptsOrders, shopUrl: `${base}/${shop.slug}`, apiPath: `/shop/v1/${shop.slug}` };
}

const SELECT = {
  id: true, orderNumber: true, status: true, createdAt: true, total: true, roundOff: true, writtenOff: true, originApp: true,
  customerName: true, customerPhone: true, shippingAddress: true,
  payments: { select: { kind: true, amount: true, method: true } },
  items: { select: { id: true, quantity: true, unitPrice: true, totalPrice: true, variant: { select: { boutiqueRef: true, variantCode: true, colorName: true, size: true, product: { select: { title: true, soldBy: true } } } } } }
} as const;

async function views(clientId: string, orders: any[]) {
  const ids = orders.map(o => o.id);
  const [shopRows, parcels] = await Promise.all([
    ids.length ? prisma.onlineShopOrder.findMany({ where: { salesOrderId: { in: ids } }, select: { salesOrderId: true, token: true, phoneVerified: true } }) : [],
    ids.length ? prisma.logisticsParcel.findMany({ where: { clientId, salesOrderId: { in: ids } }, select: { salesOrderId: true, id: true, status: true, courierName: true, awb: true, trackingUrl: true, packedAt: true } }) : []
  ]);
  const shopBy = new Map(shopRows.map(r => [r.salesOrderId, r]));
  return orders.map(o => {
    const s = paymentSummary(toMinor(o.total) + toMinor(o.roundOff ?? 0), o.payments, toMinor(o.writtenOff ?? 0));
    return {
      orderNumber: o.orderNumber, placedAt: o.createdAt, status: o.status, fromApp: o.originApp ?? null,
      orderToken: shopBy.get(o.id)?.token ?? null, phoneProved: shopBy.get(o.id)?.phoneVerified ?? null,
      customer: { name: o.customerName ?? null, phone: o.customerPhone ?? null }, deliverTo: o.shippingAddress ?? null,
      total: Number(o.total), paid: rupees(toMinor(s.paid as any)), due: rupees(toMinor(s.due as any)),
      items: o.items.map((i: any) => ({
        itemCode: i.variant?.boutiqueRef ?? null, variantCode: i.variant?.variantCode ?? null, name: i.variant?.product?.title ?? null,
        colour: i.variant?.colorName ?? null, size: i.variant?.size ?? null, unit: i.variant?.product?.soldBy ?? 'PIECE',
        quantity: i.quantity / factorOf(i.variant?.product?.soldBy), lineTotal: Number(i.totalPrice)
      })),
      parcels: parcels.filter(p => p.salesOrderId === o.id).map(p => ({ id: p.id, status: p.status, courier: p.courierName, awb: p.awb, trackingUrl: p.trackingUrl, packedAt: p.packedAt }))
    };
  });
}

/** Online orders, newest first, 20 a page. fromApp=1: only those placed in a partner app. status: one or a comma list. */
export async function list(a: Actor, q: Record<string, unknown>) {
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20)), page = Math.max(1, Number(q.page) || 1);
  const statuses = String(q.status ?? '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const where: any = { clientId: a.clientId, sourceSystem: SHOP_SOURCE, deletedAt: null,
    ...(q.fromApp === '1' || q.fromApp === 'true' ? { originApp: { not: null } } : {}),
    ...(statuses.length ? { status: { in: statuses } } : {}) };
  const [total, orders] = await Promise.all([
    prisma.salesOrder.count({ where }),
    prisma.salesOrder.findMany({ where, select: SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit })
  ]);
  return { orders: await views(a.clientId, orders), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function own(a: Actor, orderNumber: string) {
  const o = await prisma.salesOrder.findFirst({ where: { clientId: a.clientId, orderNumber, sourceSystem: SHOP_SOURCE, deletedAt: null }, select: SELECT });
  if (!o) throw problem(`No online order ${orderNumber} in this shop.`, 404);
  return o;
}

export async function getOne(a: Actor, orderNumber: string) {
  return (await views(a.clientId, [await own(a, orderNumber)]))[0];
}

/** Cancel: the held stock goes back on sale, and money paid online goes back to the customer. */
export async function cancel(a: Actor, orderNumber: string) {
  mustAct(a);
  const o = await own(a, orderNumber);
  await salesOrderService.cancelOrder(a.clientId, o.id);
  const refund = await onlinePayments.afterCancelled(a.clientId, o.id, null).catch((e: any) => ({ error: e?.message }));
  return { order: await getOne(a, orderNumber), refund };
}

/** Give part (or all) of an online payment back, with the reason. requestKey makes a retry safe. */
export async function refund(a: Actor, orderNumber: string, body: any, key: string) {
  mustAct(a);
  const o = await own(a, orderNumber);
  const out = await onlinePayments.refundByOwner(a.clientId, null, { salesOrderId: o.id, amount: body?.amount, reason: `${String(body?.reason ?? '').slice(0, 200)} -- ${by(a)}`, requestKey: body?.requestKey ?? key });
  return { order: await getOne(a, orderNumber), refund: out };
}

/**
 * Pack for shipping: the box and the weight, and (optionally) which items when only part goes. The stock leaves with
 * the parcel, and Logistics books the courier; its status and tracking then show on the order.
 */
export async function pack(a: Actor, orderNumber: string, body: any) {
  mustAct(a);
  const o = await own(a, orderNumber);
  const parcel = await logisticsPack(a.clientId, { id: null, name: by(a) }, { ...(body ?? {}), salesOrderId: o.id });
  return { order: await getOne(a, orderNumber), parcel };
}
