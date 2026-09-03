import { Router } from 'express';
import { stockCountController } from '../controllers/stock-count.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

router.get('/', requirePermission('stock_count:view'), stockCountController.getCounts);
router.post('/', requirePermission('stock_count:create'), stockCountController.createCount);
router.get('/:id', requirePermission('stock_count:view'), stockCountController.getCountById);
router.post('/:id/start', requirePermission('stock_count:create'), stockCountController.startCount);
router.put('/:id/items/:itemId', requirePermission('stock_count:update'), stockCountController.updateItemCount);
router.post('/:id/complete', requirePermission('stock_count:complete'), stockCountController.completeCount);

export default router;
