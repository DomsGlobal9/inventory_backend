import { Router, Request, Response } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { customerGroups } from '../services/customer-groups';
import { respondWithError } from '../utils/respondWithError';

/**
 * Settings → Customer groups. Looking needs customer:view; anything that changes a group, or who
 * gets WhatsApp messages, needs customer:update -- the same as the Groups card on a customer.
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
const key = (req: Request) => String(req.params.key ?? '').trim().toLowerCase();

router.get('/', requirePermission('customer:view'), act(req => customerGroups.list(cid(req))));
router.post('/', requirePermission('customer:update'), act(req => customerGroups.create(cid(req), req.body?.name)));
// By name, so the customers list can add to a brand-new group in one step.
router.post('/members', requirePermission('customer:update'), act(req => customerGroups.addMembers(cid(req), req.body?.group, req.body?.customerIds)));
router.get('/:key/members', requirePermission('customer:view'), act(req => customerGroups.members(cid(req), key(req))));
router.delete('/:key/members/:customerId', requirePermission('customer:update'), act(req => customerGroups.removeMember(cid(req), key(req), String(req.params.customerId))));
router.post('/:key/rename', requirePermission('customer:update'), act(req => customerGroups.rename(cid(req), key(req), req.body?.name)));
router.post('/:key/merge', requirePermission('customer:update'), act(req => customerGroups.rename(cid(req), key(req), req.body?.into, { merge: true })));
router.patch('/:key/rules', requirePermission('customer:update'), act(req => customerGroups.setRules(cid(req), key(req), req.body)));
router.delete('/:key', requirePermission('customer:update'), act(req => customerGroups.remove(cid(req), key(req))));

export default router;
