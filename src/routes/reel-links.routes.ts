import { Router, Request, Response, NextFunction } from 'express';
import { requirePermission } from '../middleware/permission.middleware';
import * as reelLinks from '../services/reel-links';

/**
 * Reel links for the shop (PLAN-reel-links.md): see them with reel_link:view, make and change them with
 * reel_link:manage. Every rule lives in services/reel-links; these doors only turn away people with no business here.
 */
const router = Router();

const actor = (req: Request): reelLinks.Actor => {
  const u = (req as any).user;
  return { id: u.id, clientId: u.clientId };
};
const clientId = (req: Request) => (req as any).user.clientId as string;

const handle = (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req) });
    } catch (err) {
      if (err instanceof reelLinks.ReelLinkError) return res.status(err.statusCode).json({ success: false, message: err.message });
      next(err);
    }
  };

const view = requirePermission('reel_link:view');
const manage = requirePermission('reel_link:manage');

router.get('/overview', view, handle(req => reelLinks.overview(clientId(req))));
router.get('/', view, handle(req => reelLinks.list(clientId(req))));
router.get('/next-title', manage, handle(async req => ({ title: await reelLinks.nextTitle(clientId(req)) })));
router.get('/pieces', manage, handle(req => reelLinks.searchPieces(clientId(req), req.query.q, req.query.filter)));
router.post('/', manage, handle(req => reelLinks.create(actor(req), req.body ?? {}), 201));
router.post('/add', manage, handle(req => reelLinks.addPieces(actor(req), req.body ?? {})));
router.get('/:id', view, handle(req => reelLinks.get(clientId(req), String(req.params.id))));
router.put('/:id', manage, handle(req => reelLinks.update(actor(req), String(req.params.id), req.body ?? {})));
router.post('/:id/off', manage, handle(req => reelLinks.setActive(actor(req), String(req.params.id), false)));
router.post('/:id/on', manage, handle(req => reelLinks.setActive(actor(req), String(req.params.id), true)));
router.delete('/:id', manage, handle(req => reelLinks.remove(actor(req), String(req.params.id))));

export default router;
