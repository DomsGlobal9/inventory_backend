import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { whatsappConfigured } from '../whatsapp/client';
import { shopUrl } from './rules';
import { shopBaseUrl } from './shop.service';
import { sendMail, emailConfigured } from '../../lib/mailer';

/**
 * The message a customer gets on WhatsApp the moment their order is placed.
 *
 * Sent AFTER the order has committed, never inside it: WhatsApp being slow, or the shop's number
 * not being linked at all, must never stop somebody buying. A shop with no WhatsApp simply sells
 * without this, and the customer still has the link on their confirmation page.
 *
 * It respects STOP, like everything else this shop sends. Somebody who told the shop to stop
 * messaging them has still placed a real order -- they just find it on the page rather than in a
 * chat, which is the right way round: STOP means stop, not "except when it suits us".
 */
export async function sendOrderPlacedNotice(clientId: string, token: string): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    if (!whatsappConfigured()) return 'skipped';

    const row = await prisma.onlineShopOrder.findUnique({
      where: { token },
      select: {
        customerPhone: true, payWay: true, salesOrderId: true,
        salesOrder: { select: { orderNumber: true, total: true, customerName: true } }
      }
    });
    if (!row?.customerPhone) return 'skipped';

    const [settings, shop] = await Promise.all([
      getShopSettings(clientId).catch(() => null),
      prisma.onlineShop.findUnique({ where: { clientId }, select: { slug: true, displayName: true } })
    ]);
    const name = shop?.displayName?.trim() || settings?.businessName?.trim() || 'the shop';
    const link = shop?.slug ? shopUrl(shopBaseUrl(), shop.slug) : null;

    /*
     * Written as a shopkeeper would write it: what they bought, what it comes to, what happens
     * next. No marketing, because this is the message that has to be trusted -- it is the only
     * proof the customer has until the box arrives.
     */
    const money = `₹${Number(row.salesOrder.total).toLocaleString('en-IN')}`;
    const lines = [
      `Thank you${row.salesOrder.customerName ? `, ${row.salesOrder.customerName.split(' ')[0]}` : ''}! ${name} has your order.`,
      '',
      `Order ${row.salesOrder.orderNumber}`,
      `Total ${money}${row.payWay === 'ON_DELIVERY' ? ', to pay when it arrives' : ', paid'}`,
      ...(link ? ['', `See your order: ${link}/order/${token}`] : []),
      '',
      'We will message you again when it is sent.'
    ];

    const { sendShopText } = await import('../whatsapp/service');
    await sendShopText({
      clientId,
      to: row.customerPhone.replace(/^\+/, ''),
      text: lines.join('\n'),
      kind: 'ORDER_UPDATE',
      referenceId: row.salesOrderId,
      // One message per order, however many times this is retried.
      idempotencyKey: `SHOP:ORDER:${row.salesOrderId}`,
      sentBy: null,
      linkPreview: false
    });
    return 'sent';
  } catch (e) {
    // A shop not linked, a customer who said STOP, WhatsApp down: none of it unmakes the order.
    console.warn('[online-shop] order confirmation not sent:', (e as Error)?.message);
    return 'failed';
  }
}


/**
 * Telling the SHOP that somebody has bought something.
 *
 * An order that arrives at nine at night is otherwise found at nine the next morning, by somebody
 * who happened to open the Orders screen. This raises it in the Alert Centre the shop already
 * watches, with the customer's name and what it came to, so it is seen the way a low-stock warning
 * is seen.
 *
 * Deliberately NOT a WhatsApp message. A shop's messages go out from the shop's own number, and a
 * number messaging itself is a strange thing to build a habit on; the Alert Centre is where this
 * shop already looks for things that need doing.
 */
export async function tellTheShop(clientId: string, salesOrderId: string): Promise<'raised' | 'skipped'> {
  try {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, id: salesOrderId },
      select: {
        orderNumber: true, total: true, customerName: true, customerPhone: true, locationId: true,
        items: { select: { quantity: true } }
      }
    });
    if (!order) return 'skipped';

    const pieces = order.items.reduce((n, i) => n + i.quantity, 0);
    await prisma.inventoryAlert.create({
      data: {
        clientId,
        type: 'ONLINE_ORDER',
        // Not a warning: nothing is wrong. It is something to do, and doing it is how the shop
        // gets paid, so it should not sit in the same colour as "stock is running out".
        severity: 'INFO',
        title: `New online order ${order.orderNumber}`,
        message:
          `${order.customerName || 'A customer'} ordered ${pieces} ${pieces === 1 ? 'piece' : 'pieces'} ` +
          `for ₹${Number(order.total).toLocaleString('en-IN')}` +
          `${order.customerPhone ? ` · ${order.customerPhone}` : ''}. The stock is held for them.`,
        locationId: order.locationId
      }
    });
    return 'raised';
  } catch (e) {
    // The order stands whatever happens here.
    console.warn('[online-shop] could not raise the new-order alert:', (e as Error)?.message);
    return 'skipped';
  }
}

/**
 * The same confirmation, by email, for a customer who left one.
 *
 * Belt and braces on purpose: WhatsApp is refused to anybody who has replied STOP, and a shop may
 * not have its number linked at all. An email costs nothing and is the only copy some customers
 * will keep.
 */
export async function emailOrderPlaced(clientId: string, token: string): Promise<'sent' | 'skipped'> {
  try {
    const row = await prisma.onlineShopOrder.findUnique({
      where: { token },
      select: {
        payWay: true,
        salesOrder: {
          select: {
            orderNumber: true, total: true, customerName: true, customerId: true,
            shippingAddress: true,
            items: {
              select: {
                quantity: true, totalPrice: true,
                variant: { select: { size: true, colorName: true, product: { select: { title: true } } } }
              }
            }
          }
        }
      }
    });
    if (!row) return 'skipped';

    const customer = await prisma.customer.findUnique({
      where: { id: row.salesOrder.customerId }, select: { email: true }
    });
    if (!customer?.email || !emailConfigured()) return 'skipped';

    const [settings, shop] = await Promise.all([
      getShopSettings(clientId).catch(() => null),
      prisma.onlineShop.findUnique({ where: { clientId }, select: { slug: true, displayName: true } })
    ]);
    const name = shop?.displayName?.trim() || settings?.businessName?.trim() || 'the shop';
    const link = shop?.slug ? shopUrl(shopBaseUrl(), shop.slug) : null;
    const rupees = (n: unknown) => `₹${Number(n).toLocaleString('en-IN')}`;

    const lines = [
      `Thank you${row.salesOrder.customerName ? `, ${row.salesOrder.customerName.split(' ')[0]}` : ''}!`,
      '',
      `${name} has your order ${row.salesOrder.orderNumber}.`,
      '',
      ...row.salesOrder.items.map(i => {
        const what = [i.variant?.product.title, i.variant?.colorName, i.variant?.size].filter(Boolean).join(' · ');
        return `  ${i.quantity} x ${what} — ${rupees(i.totalPrice)}`;
      }),
      '',
      `Total: ${rupees(row.salesOrder.total)}${row.payWay === 'ON_DELIVERY' ? ', to pay when it arrives' : ', paid'}`,
      '',
      'Going to:',
      String(row.salesOrder.shippingAddress ?? '').split('\n').map(l => `  ${l}`).join('\n'),
      ...(link ? ['', `See your order: ${link}/order/${token}`] : []),
      '',
      'We will write again when it is sent.',
      name
    ];

    await sendMail({
      to: customer.email,
      subject: `${name} — your order ${row.salesOrder.orderNumber}`,
      text: lines.join('\n'),
      kind: 'online-shop-order'
    });
    return 'sent';
  } catch (e) {
    console.warn('[online-shop] order email not sent:', (e as Error)?.message);
    return 'skipped';
  }
}
