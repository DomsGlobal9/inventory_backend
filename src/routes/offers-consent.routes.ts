import { Router, Request, Response, NextFunction } from 'express';
import { refuseIfProfileMoved } from '../services/crm-handover';
import { setOffersConsent, offersState } from '../services/campaigns';
import { requirePermission } from '../middleware/permission.middleware';

/**
 * A customer's yes to WhatsApp offers: GET/PUT /api/v1/offers-consent/:customerId (the customer page).
 * Recorded in Inventory because the till and the customer page take it; what is sent to the customer is
 * ScaleEzy CRM's (campaigns left Inventory on 19 Nov 2026). Once CRM changes a shop's customers' answers
 * (moved.profile), they are changed there.
 */
const router = Router();
const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await fn(req) }); } catch (err) { next(err); }
};
const who = (req: Request) => {
  const u = (req as any).user;
  return { id: u.id, clientId: u.clientId, name: u.name, permissions: u.permissions, roles: u.roles };
};

router.get('/:customerId', requirePermission('customer:view'), handle(req => offersState((req as any).user.clientId, String(req.params.customerId))));
router.put('/:customerId', requirePermission('customer:update'), handle(async req => { await refuseIfProfileMoved(who(req).clientId); return setOffersConsent(who(req), String(req.params.customerId), req.body?.agreed); }));

export default router;
