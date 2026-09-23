import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { whatsappConfigured } from '../whatsapp/client';
import { shopUrl } from './rules';
import { shopBaseUrl } from './shop.service';

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
