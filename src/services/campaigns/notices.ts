/**
 * The points message after a counter sale: "you earned 12 points, you now have 340".
 *
 * Sent after the sale has committed, never inside it -- WhatsApp being slow or down must never slow
 * or stop a sale. Off unless the owner switched it on in Loyalty settings. It is about the customer's
 * own purchase, so it goes to anyone with a phone who has not replied STOP; offers need their yes.
 *
 * Imported lazily from the WhatsApp module: that module reads the counter sale's source name, and
 * the counter sale calls this, so a top-level import would be a loop.
 */
import { getShopSettings } from '../../lib/clientSettings';
import { whatsappConfigured } from '../whatsapp/client';
import { afterSaleText } from '../loyalty';

export async function sendAfterSaleNotice(clientId: string, orderId: string): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    if (!whatsappConfigured()) return 'skipped';
    const { businessName } = await getShopSettings(clientId);
    const notice = await afterSaleText(clientId, orderId, businessName || 'our shop');
    if (!notice) return 'skipped';
    const { sendShopText } = await import('../whatsapp/service');
    await sendShopText({
      clientId,
      to: notice.phone.replace(/^\+/, ''),
      text: `${notice.text}\n\n_Reply STOP to stop these messages._`,
      kind: 'LOYALTY',
      referenceId: orderId,
      idempotencyKey: `LOYALTY:SALE:${orderId}`,
      sentBy: null
    });
    return 'sent';
  } catch (e) {
    // A shop not linked, a customer who said STOP: nothing to put right, and the sale stands.
    console.warn('[loyalty] points message after a sale not sent:', (e as Error)?.message);
    return 'failed';
  }
}
