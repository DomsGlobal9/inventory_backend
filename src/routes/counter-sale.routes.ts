import { Router, Request, Response } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { respondWithError } from '../utils/respondWithError';
import { grants, holdsEverything } from '../config/permissions';
import { requestsManualDiscount } from '../services/pricing';
import { completeSaleSchema } from '../services/counter-sale/counter-sale.schema';
import { counterSaleService } from '../services/counter-sale/counter-sale.service';
import { searchSellableItems } from '../services/counter-sale/selling-search.service';

/**
 * Selling at the counter: finding an item, completing the sale, and the receipt.
 *
 * Complete sale takes stock off the shelf under sales_order:counter_sale alone, without
 * dispatch:create -- the goods are already in the customer's hand, so there is nothing for a stock
 * room to send. Everything else a sale needs (the customer, the order) the permission implies.
 */
const router = Router();
router.use(tenantMiddleware);

router.get('/items', requirePermission('sales_order:counter_sale'), async (req: Request, res: Response) => {
  try {
    const locationId = (typeof req.query.locationId === 'string' && req.query.locationId) || (req as any).locationId;
    const result = await searchSellableItems((req as any).clientId, locationId, req.query.q);
    res.json({ success: true, data: result });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'Could not search the items.' });
  }
});

router.post('/', requirePermission('sales_order:counter_sale'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const unlimited = holdsEverything(user?.permissions, user?.roles);

    // Money off by hand needs its own permission, checked before validation -- the same rule, and
    // the same reason, as POST /sales-orders/full: a cashier without it is told so, not handed a
    // validation message about the field's shape.
    if (requestsManualDiscount(req.body) && !(unlimited || grants(user?.permissions ?? [], 'offer:manual_discount'))) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to take money off at the till. Ask a manager to approve it.',
        requiredPermission: 'offer:manual_discount'
      });
    }

    const parsed = completeSaleSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({ success: false, message: first?.message ?? 'Check the sale and try again.', errors: parsed.error.errors });
    }

    const result = await counterSaleService.completeSale((req as any).clientId, {
      userId: user?.id ?? null,
      mayExceedManualLimit: unlimited || grants(user?.permissions ?? [], 'offer:manual_discount_unlimited')
    }, parsed.data);

    res.locals.auditAction = result.replayed ? 'COUNTER_SALE_REPEATED' : 'COUNTER_SALE';
    res.locals.auditEntityId = result.sale.id;
    // 201 for the sale this request made; 200 for one an earlier press already made.
    res.status(result.replayed ? 200 : 201).json({ success: true, replayed: result.replayed, data: result.sale });
  } catch (error) {
    return respondWithError(res, error, { status: 400, message: 'The sale could not be completed. Nothing was saved.' });
  }
});

// The receipt, for any of this shop's orders. Reprints read the same thing; the screen marks them.
router.get('/:orderId/receipt', requirePermission('sales_order:view'), async (req: Request, res: Response) => {
  try {
    const sale = await counterSaleService.getSale((req as any).clientId, req.params.orderId as string);
    res.json({ success: true, data: sale });
  } catch (error) {
    return respondWithError(res, error, { status: 404, message: 'Order not found' });
  }
});

export default router;
