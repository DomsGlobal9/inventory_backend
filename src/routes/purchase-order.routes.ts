import { Router } from 'express';
import { getPOs, getPOById, createPO, setDeliverTo, updatePOStatus, receiveGoods, emailPOToSupplier } from '../controllers/purchase-order.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

// Inject verified clientId into every PO request
router.use(tenantMiddleware);

router.get('/', requirePermission('purchase_order:view'), getPOs);
router.get('/:id', requirePermission('purchase_order:view'), getPOById);
router.post('/', requirePermission('purchase_order:create'), createPO);
router.put('/:id/status', requirePermission('purchase_order:update'), updatePOStatus);
// Where the order is delivered: part of the order itself, so the same authority as changing it.
router.put('/:id/deliver-to', requirePermission('purchase_order:update'), setDeliverTo);
router.post('/:id/receive', requirePermission('purchase_order:receive'), receiveGoods);
// Sending an order is the same authority as changing its status -- it moves a Draft to Sent.
router.post('/:id/email', requirePermission('purchase_order:update'), emailPOToSupplier);

export default router;
