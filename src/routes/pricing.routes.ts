import { Router, Request, Response } from 'express';
import { pricingQuoteService } from '../services/pricing';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { respondWithError } from '../utils/respondWithError';

/**
 * "What does this basket cost?"
 *
 * The one question the till asks, and the same one a merchant's own website asks. Both get the
 * same answer, which is the entire point: their developer never sees the rules, so they cannot
 * implement them slightly differently and sell at a price the shop never agreed to.
 *
 * It is a POST because it CREATES something -- the quote is kept, and an order can later be held
 * to it. A GET that writes a row is a lie about what it does, and it would be cached.
 *
 * Gated on sales_order:create rather than offer:view: asking what something costs is part of
 * selling it, and a cashier who can take an order must be able to price one.
 */
const router = Router();
router.use(tenantMiddleware);

router.post('/quote', requirePermission('sales_order:create'), async (req: Request, res: Response) => {
  try {
    const quote = await pricingQuoteService.quote((req as any).clientId, {
      locationId: req.body?.locationId,
      channel: req.body?.channel,
      customerId: req.body?.customerId ?? null,
      couponCodes: Array.isArray(req.body?.couponCodes) ? req.body.couponCodes : [],
      lines: Array.isArray(req.body?.lines) ? req.body.lines : []
    });
    res.json({ success: true, data: quote });
  } catch (error) {
    // 400 as the fallback: almost everything that goes wrong here is the basket that was sent,
    // and the service has already said which line and why.
    return respondWithError(res, error, { status: 400, message: 'Could not price that basket.' });
  }
});

export default router;
