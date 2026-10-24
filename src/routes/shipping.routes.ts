import { Router, Request, Response } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { couriers, parcels } from '../services/shipping';
import { respondWithError } from '../utils/respondWithError';

/**
 * Settings → Couriers, and a dispatch's courier, tracking number and delivery. All of it needs
 * dispatch:create: the people who send parcels out are the people who know who took them.
 */
const router = Router();
router.use(tenantMiddleware);

const act = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};
const cid = (req: Request) => (req as any).clientId as string;
const id = (req: Request) => String(req.params.id ?? '');

router.get('/couriers', requirePermission('dispatch:create'), act(req => couriers.list(cid(req))));
router.post('/couriers', requirePermission('dispatch:create'), act(req => couriers.add(cid(req), req.body)));
router.patch('/couriers/:id', requirePermission('dispatch:create'), act(req => couriers.edit(cid(req), id(req), req.body)));
router.delete('/couriers/:id', requirePermission('dispatch:create'), act(req => couriers.remove(cid(req), id(req))));

// The label for the box. Seeing an order is enough: whoever packs it prints it.
// Many orders' labels at once: POST because a page of ticked orders is too long for an address.
router.post('/labels', requirePermission('sales_order:view'), act(req => parcels.labels(cid(req), req.body?.orderIds)));
router.get('/dispatches/:id/label', requirePermission('sales_order:view'), act(req => parcels.label(cid(req), id(req))));
// Mark delivered for many ticked orders at once.
router.post('/delivered', requirePermission('dispatch:create'), act(req => parcels.deliverMany(cid(req), req.body?.orderIds)));
router.put('/dispatches/:id', requirePermission('dispatch:create'), act(req => parcels.setParcel(cid(req), id(req), req.body)));
router.post('/dispatches/:id/delivered', requirePermission('dispatch:create'), act(req => parcels.setDelivered(cid(req), id(req), req.body?.delivered)));

export default router;
