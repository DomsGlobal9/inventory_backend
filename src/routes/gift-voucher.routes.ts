import { Router } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { respondWithError } from '../utils/respondWithError';
import * as giftVouchers from '../services/gift-vouchers';

/**
 * Gift vouchers, the shop's side (Customers → Gift vouchers, Settings → Gift vouchers). Selling and
 * spending happen at the till under /pos/v1; here: who holds what, and the hand changes.
 */
const router = Router();
router.use(tenantMiddleware);

const clientOf = (req: any) => req.clientId as string;
const userOf = (req: any) => (req.user?.id as string | undefined) ?? null;
const handle = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any) => {
  try { res.status(status).json({ success: true, data: await fn(req) }); }
  catch (error) { return respondWithError(res, error, { status: 500 }); }
};

router.get('/settings', requirePermission('voucher:view'), handle(req => giftVouchers.getSettings(clientOf(req))));
router.put('/settings', requirePermission('voucher:manage'), handle(req => giftVouchers.saveSettings(clientOf(req), req.body ?? {}, userOf(req))));
router.get('/', requirePermission('voucher:view'), handle(async req => ({
  summary: await giftVouchers.summary(clientOf(req)),
  vouchers: await giftVouchers.list(clientOf(req), { search: req.query.search, status: req.query.status })
})));
router.get('/:id', requirePermission('voucher:view'), handle(req => giftVouchers.detail(clientOf(req), String(req.params.id))));
router.post('/:id/extend', requirePermission('voucher:manage'), handle(req => giftVouchers.extend(clientOf(req), String(req.params.id), req.body?.months, userOf(req))));
router.post('/:id/block', requirePermission('voucher:manage'), handle(req => giftVouchers.block(clientOf(req), String(req.params.id), req.body?.reason, userOf(req))));
router.post('/:id/unblock', requirePermission('voucher:manage'), handle(req => giftVouchers.unblock(clientOf(req), String(req.params.id), userOf(req))));

export default router;
