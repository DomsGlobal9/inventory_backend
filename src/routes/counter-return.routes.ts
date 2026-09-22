import { Router, Request, Response, NextFunction } from 'express';
import * as counterReturn from '../services/counter-return';
import * as storeCredit from '../services/store-credit';
import { requirePermission } from '../middleware/permission.middleware';

/**
 * Returns at the counter, and store credit. Who may do what is decided in the services (a
 * salesperson with return:counter, or a manager); the doors here only turn away people with no
 * business with returns or customers at all.
 */
const router = Router();

const actor = (req: Request): counterReturn.Actor => {
  const u = (req as any).user;
  return { id: u.id, clientId: u.clientId, name: u.name, permissions: u.permissions, roles: u.roles };
};
const handle = (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.status(status).json({ success: true, data: await fn(req) }); } catch (err) { next(err); }
  };

router.get('/rules', requirePermission('return:view'), handle(req => counterReturn.getRules((req as any).user.clientId)));
router.put('/rules', requirePermission('return:complete'), handle(req => counterReturn.saveRules(actor(req), req.body ?? {})));
router.get('/find', requirePermission('return:view'), handle(req => counterReturn.findSales(actor(req), req.query.q)));
router.get('/sale/:orderId', requirePermission('return:view'), handle(req => counterReturn.saleForCounter(actor(req), String(req.params.orderId))));
router.post('/preview', requirePermission('return:view'), handle(req => counterReturn.preview(actor(req), req.body ?? {})));
router.post('/', requirePermission('return:view'), handle(async req => {
  const r = await counterReturn.complete(actor(req), { ...(req.body ?? {}), locationId: req.body?.locationId ?? req.headers['x-location-id'] });
  return r;
}, 201));
router.post('/refund/:returnId', requirePermission('return:view'), handle(req =>
  counterReturn.recordRefund(actor(req), String(req.params.returnId), { ...(req.body ?? {}), locationId: req.body?.locationId ?? req.headers['x-location-id'] })));

// Store credit.
router.get('/credit/customers/:id', requirePermission('customer:view'), handle(req => storeCredit.customerCredit((req as any).user.clientId, String(req.params.id))));
router.post('/credit/customers/:id/payout', requirePermission('return:complete'), handle(req =>
  storeCredit.payOut(actor(req), String(req.params.id), { ...(req.body ?? {}), locationId: req.body?.locationId ?? req.headers['x-location-id'] })));
router.get('/credit/counter', requirePermission('sales_order:counter_sale'), handle(req =>
  storeCredit.forCounter((req as any).user.clientId, String(req.query.customerId ?? ''))));

export default router;
