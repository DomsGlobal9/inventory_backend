import { Router } from 'express';
import {
  createOrder,
  createFullOrder,
  getOrders,
  getOrderById,
  updateOrder,
  deleteOrder,
  addOrderItem,
  removeOrderItem,
  confirmOrder,
  cancelOrder
} from '../controllers/sales-order.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { serviceAuthMiddleware } from '../middleware/serviceAuth.middleware';

const router = Router();

router.use(requireAuth);
router.use(tenantMiddleware);

// Strict service-to-service ingestion endpoints
router.post('/', serviceAuthMiddleware, createOrder);
router.post('/full', serviceAuthMiddleware, createFullOrder);

router.get('/', requirePermission('sales_order:view'), getOrders);
router.get('/:id', requirePermission('sales_order:view'), getOrderById);
router.patch('/:id', requirePermission('sales_order:update'), updateOrder);
router.delete('/:id', requirePermission('sales_order:cancel'), deleteOrder);
router.post('/:id/items', requirePermission('sales_order:update'), addOrderItem);
router.delete('/:id/items/:itemId', requirePermission('sales_order:update'), removeOrderItem);
router.post('/:id/confirm', requirePermission('sales_order:confirm'), confirmOrder);
router.post('/:id/cancel', requirePermission('sales_order:cancel'), cancelOrder);

export default router;
