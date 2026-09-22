import { Router, Request, Response, NextFunction } from 'express';
import { campaigns, setOffersConsent, markManyAgreed, offersState } from '../services/campaigns';
import { WhatsAppServiceError } from '../services/whatsapp/client';
import { requirePermission } from '../middleware/permission.middleware';

/**
 * WhatsApp campaigns, and whether a customer agreed to hear about offers. Who may do what is
 * decided in services/campaigns; the doors here only turn away people with no business at all.
 */
const router = Router();

const actor = (req: Request): campaigns.Actor => {
  const u = (req as any).user;
  return { id: u.id, clientId: u.clientId, name: u.name, permissions: u.permissions, roles: u.roles };
};

const handle = (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req) });
    } catch (err) {
      if (err instanceof WhatsAppServiceError) return res.status(err.statusCode).json({ success: false, message: err.message });
      next(err);
    }
  };

// A customer's yes to offers. Changing a customer is enough; marking many at once is a campaign job.
router.get('/consent/:customerId', requirePermission('customer:view'), handle(req => offersState((req as any).user.clientId, String(req.params.customerId))));
router.put('/consent/:customerId', requirePermission('customer:update'), handle(req => setOffersConsent(actor(req), String(req.params.customerId), req.body?.agreed)));
router.post('/consent/bulk', requirePermission('campaign:send'), handle(req => markManyAgreed(actor(req), req.body ?? {})));

router.get('/overview', requirePermission('campaign:view'), handle(req => campaigns.overview(actor(req))));
router.post('/preview', requirePermission('campaign:view'), handle(req => campaigns.preview(actor(req), req.body?.audience)));
router.post('/test', requirePermission('campaign:send'), handle(req => campaigns.sendTest(actor(req), req.body ?? {}), 202));
router.get('/', requirePermission('campaign:view'), handle(req => campaigns.list(actor(req), { source: req.query.source })));
router.post('/', requirePermission('campaign:send'), handle(req => campaigns.create(actor(req), req.body ?? {}), 201));
router.get('/:id', requirePermission('campaign:view'), handle(req => campaigns.get(actor(req), String(req.params.id))));
router.patch('/:id', requirePermission('campaign:send'), handle(req => campaigns.update(actor(req), String(req.params.id), req.body ?? {})));
router.delete('/:id', requirePermission('campaign:send'), handle(req => campaigns.remove(actor(req), String(req.params.id))));
router.post('/:id/copy', requirePermission('campaign:send'), handle(req => campaigns.copy(actor(req), String(req.params.id)), 201));
router.post('/:id/start', requirePermission('campaign:send'), handle(req => campaigns.start(actor(req), String(req.params.id), req.body ?? {})));
router.post('/:id/pause', requirePermission('campaign:send'), handle(req => campaigns.pause(actor(req), String(req.params.id))));
router.post('/:id/resume', requirePermission('campaign:send'), handle(req => campaigns.resume(actor(req), String(req.params.id))));
router.post('/:id/cancel', requirePermission('campaign:send'), handle(req => campaigns.cancel(actor(req), String(req.params.id))));

export default router;
