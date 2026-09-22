import { Router, Request, Response, NextFunction } from 'express';
import * as loyalty from '../services/loyalty';
import { toMinor } from '../services/pricing';
import { requirePermission } from '../middleware/permission.middleware';

/** Loyalty points: the shop's rules, a customer's points, and what the counter may offer. */
const router = Router();

const actor = (req: Request): loyalty.Actor => {
  const u = (req as any).user;
  return { id: u.id, clientId: u.clientId, name: u.name, permissions: u.permissions, roles: u.roles };
};
const handle = (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try { res.json({ success: true, data: await fn(req) }); } catch (err) { next(err); }
  };

// Anyone who sees customers sees the rules: the counter needs them to explain points to a customer.
router.get('/settings', requirePermission('customer:view'), handle(req => loyalty.getSettings((req as any).user.clientId)));
router.put('/settings', requirePermission('loyalty:manage'), handle(req => loyalty.saveSettings(actor(req), req.body ?? {})));

// The New sale screen: this customer's points, and how many may pay part of this bill.
router.get('/counter', requirePermission('sales_order:counter_sale'), handle(req => {
  const bill = Number(req.query.bill);
  return loyalty.forCounter((req as any).user.clientId, typeof req.query.customerId === 'string' ? req.query.customerId : null,
    Number.isFinite(bill) && bill > 0 ? toMinor(bill) : null);
}));

router.get('/customers/:id', requirePermission('customer:view'), handle(req => loyalty.customerPoints((req as any).user.clientId, String(req.params.id))));
router.post('/customers/:id/adjust', requirePermission('loyalty:manage'), handle(req => loyalty.adjust(actor(req), String(req.params.id), req.body ?? {})));

export default router;
