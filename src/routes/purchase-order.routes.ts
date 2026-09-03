import { Router } from 'express';
import { getPOs, getPOById, createPO, updatePOStatus, receiveGoods } from '../controllers/purchase-order.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

// Inject verified clientId into every PO request
router.use(tenantMiddleware);

router.get('/', requirePermission('purchase_order:view'), getPOs);
router.get('/:id', requirePermission('purchase_order:view'), getPOById);
router.post('/', requirePermission('purchase_order:create'), createPO);
router.put('/:id/status', requirePermission('purchase_order:update'), updatePOStatus);
router.post('/:id/receive', requirePermission('purchase_order:receive'), receiveGoods);

export default router;
