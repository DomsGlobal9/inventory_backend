import { Router } from 'express';
import {
  createOrder,
  createFullOrder,
  getOrders,
  getOrderById,
  retryShopifyUpdate,
  updateOrder,
  deleteOrder,
  addOrderItem,
  removeOrderItem,
  confirmOrder,
  cancelOrder,
  collectOrderPayment,
  undoOrderPayment
} from '../controllers/sales-order.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

// Sales order endpoints
router.post('/', requirePermission('sales_order:create'), createOrder);
router.post('/full', requirePermission('sales_order:create'), createFullOrder);

router.get('/', requirePermission('sales_order:view'), getOrders);
router.get('/:id', requirePermission('sales_order:view'), getOrderById);
router.post('/:id/shopify-updates/:updateId/retry', requirePermission('sales_order:update'), retryShopifyUpdate);
router.patch('/:id', requirePermission('sales_order:update'), updateOrder);
router.delete('/:id', requirePermission('sales_order:cancel'), deleteOrder);
router.post('/:id/items', requirePermission('sales_order:update'), addOrderItem);
router.delete('/:id/items/:itemId', requirePermission('sales_order:update'), removeOrderItem);
router.post('/:id/confirm', requirePermission('sales_order:confirm'), confirmOrder);
router.post('/:id/cancel', requirePermission('sales_order:cancel'), cancelOrder);
// Taking money is the counter permission's job ("Sell at the counter and take payment").
router.post('/:id/payments', requirePermission('sales_order:counter_sale'), collectOrderPayment);
// The owner only, checked in the controller (holds every permission).
router.post('/:id/payments/:paymentId/undo', requirePermission('sales_order:view'), undoOrderPayment);

export default router;
