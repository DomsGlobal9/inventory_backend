import { Router } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { getReorderSuggestions, createReorderDrafts } from '../controllers/reorder.controller';

const router = Router();
router.use(tenantMiddleware);

// Reading suggestions is a stock question; acting on one creates purchase orders, so it
// carries the same permission as raising a PO by hand.
router.get('/suggestions', requirePermission('inventory:view'), getReorderSuggestions);
router.post('/draft-orders', requirePermission('purchase_order:create'), createReorderDrafts);

export default router;
