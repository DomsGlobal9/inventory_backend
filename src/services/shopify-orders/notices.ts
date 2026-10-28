import { prisma } from '../../lib/prisma';

/**
 * The bell, for Shopify orders.
 *
 * An online-shop order has rung the bell since it was built (online-shop/notices.ts); a Shopify
 * order landed in Orders silently, so a shop found it only by opening that screen. The user asked
 * on 26 October for every order to be told about. Two notices:
 *
 *   NEW       an order was placed here from Shopify -- once per order, not per webhook. Shopify
 *             sends orders/create and orders/updated for the same order within a second.
 *   WAITING   an order could not be placed yet (product not matched, location not paired): the
 *             shop has something to do before the sale counts, so it is a warning, not news.
 *
 * Same alert kind as the online shop's (ONLINE_ORDER, already known to every running build, so no
 * new enum value). Never throws: the order stands whatever happens here.
 */

export async function tellShopOfShopifyOrder(clientId: string, salesOrderId: string, shopifyName: string | null) {
  try {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, id: salesOrderId },
      select: {
        orderNumber: true, total: true, locationId: true, status: true,
        customer: { select: { name: true } }, items: { select: { quantity: true } }, payments: { select: { kind: true, amount: true } }
      }
    });
    if (!order) return;
    const pieces = order.items.reduce((n, i) => n + i.quantity, 0);
    const paid = order.payments.reduce((s, p) => s + (p.kind === 'PAYMENT' ? Number(p.amount) : -Number(p.amount)), 0);
    // What the shop has to do about the money, in a few words: nothing, or collect it.
    const money = order.status === 'DRAFT'
      ? 'It is not paid yet, so no stock is held until it is.'
      : paid + 0.005 >= Number(order.total)
        ? 'It is paid, and the stock is held for them.'
        : 'The stock is held for them; the money is to be collected on delivery.';
    await prisma.inventoryAlert.create({
      data: {
        clientId, type: 'ONLINE_ORDER', severity: 'INFO', locationId: order.locationId,
        title: `New Shopify order ${order.orderNumber}`,
        message:
          `${order.customer?.name || 'A customer'} ordered ${pieces} ${pieces === 1 ? 'piece' : 'pieces'} ` +
          `for ₹${Number(order.total).toLocaleString('en-IN')} on Shopify${shopifyName ? ` (${shopifyName})` : ''}. ${money}`
      }
    });
  } catch (e) {
    console.warn('[Shopify] could not raise the new-order notice:', (e as Error)?.message);
  }
}

/**
 * GST worth a look on a Shopify order: a stitched piece that looks under-taxed, a product with no
 * rate, Shopify adding its own tax. One WARNING per order, the first point as the message -- the
 * order itself stands, as on the till, where these are warnings and never refusals.
 */
export async function tellShopGstWorthChecking(clientId: string, salesOrderId: string, warnings: string[]) {
  try {
    if (warnings.length === 0) return;
    const order = await prisma.salesOrder.findFirst({ where: { clientId, id: salesOrderId }, select: { orderNumber: true, locationId: true } });
    if (!order) return;
    const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more point${warnings.length > 2 ? 's' : ''} on this order)` : '';
    await prisma.inventoryAlert.create({
      data: {
        clientId, type: 'ONLINE_ORDER', severity: 'WARNING', locationId: order.locationId,
        title: `Check the GST on Shopify order ${order.orderNumber}`,
        message: `${warnings[0]}${more}`
      }
    });
  } catch (e) {
    console.warn('[Shopify] could not raise the GST notice:', (e as Error)?.message);
  }
}

export async function tellShopOrderWaiting(clientId: string, shopDomain: string, shopifyOrderId: string, shopifyName: string | null, detail: string) {
  try {
    // Once per order: a second topic or a retry of the same waiting order says nothing new.
    const rows = await prisma.shopifyOrderInbox.findMany({
      where: { shopDomain, shopifyOrderId, resolvedAt: null }, select: { attempts: true }
    });
    if (rows.length !== 1 || rows[0].attempts !== 1) return;
    const pairing = await prisma.shopifyLocationMap.findFirst({ where: { clientId }, select: { locationId: true } });
    await prisma.inventoryAlert.create({
      data: {
        clientId, type: 'ONLINE_ORDER', severity: 'WARNING', locationId: pairing?.locationId ?? null,
        title: `Shopify order ${shopifyName ?? shopifyOrderId} is waiting`,
        message: `${detail} It is under Settings, Connected websites, Shopify, Waiting orders. It is placed as soon as that is fixed.`
      }
    });
  } catch (e) {
    console.warn('[Shopify] could not raise the waiting-order notice:', (e as Error)?.message);
  }
}
