import { Router, Request, Response } from 'express';
import * as onlinePayments from '../services/payments/online-payment.service';

/**
 * Webhooks from the shops' payment gateways.
 *
 * Ahead of the authentication gate, for the same reason as Shopify's: the caller is Razorpay's
 * server, which carries no session and no API key. It proves itself with a signature over the RAW
 * bytes of the body -- which is why server.ts mounts express.raw on this path before the JSON parser
 * can reorder them -- and the token in the address says which shop's secret to check it with.
 *
 * The reply goes out as soon as the delivery is kept, and the work happens after it: see
 * receiveWebhook for why answering after the work made every slow settle a retry storm.
 */
const router = Router();

router.post('/razorpay/:token', async (req: Request, res: Response) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
  try {
    const out = await onlinePayments.receiveWebhook(req.params.token, raw, req.headers as Record<string, any>);
    res.status(out.status).json(out.body);
    if (out.receiptId) {
      const id = out.receiptId;
      // After the reply, on purpose. If this fails the receipt stays undone and the sweeper retries.
      setImmediate(() => { void onlinePayments.processReceipt(id); });
    }
  } catch (e) {
    // Could not even keep it: a 5xx, so Razorpay tries again later rather than the delivery being lost.
    console.error('[payments] a webhook could not be kept:', (e as Error)?.message);
    res.status(503).json({ ok: false });
  }
});

export default router;
