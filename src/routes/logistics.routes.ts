import { Router, Request, Response } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import * as parcels from '../services/logistics/parcels';
import { prisma } from '../lib/prisma';
import { respondWithError } from '../utils/respondWithError';

/**
 * Packing for ScaleEzy Logistics (services/logistics/parcels): whether the shop is on Logistics, its
 * box sizes, packing an order, and the parcels the packing screen waits on for a label. All of it
 * needs dispatch:create, like Settings → Couriers: packing IS sending the order out.
 */
const router = Router();
router.use(tenantMiddleware);

const act = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response) => {
  try {
    res.status(status).json({ success: true, data: await fn(req) });
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};
const cid = (req: Request) => (req as any).clientId as string;

router.get('/', requirePermission('dispatch:create'), act(async req => ({ on: await parcels.isOn(cid(req)), boxes: await parcels.boxes(cid(req)) })));
router.put('/boxes', requirePermission('dispatch:create'), act(req => parcels.saveBoxes(cid(req), req.body?.boxes)));
router.get('/parcels', requirePermission('dispatch:create'), act(req => parcels.forOrders(cid(req), typeof req.query.orderIds === 'string' ? req.query.orderIds.split(',') : [])));
router.post('/parcels', requirePermission('dispatch:create'), act(async req => {
  const userId = (req as any).user?.id ?? null;
  const name = userId ? (await prisma.user.findFirst({ where: { id: userId, clientId: cid(req) }, select: { name: true } }))?.name ?? null : null;
  return parcels.pack(cid(req), { id: userId, name }, req.body);
}, 201));

export default router;
