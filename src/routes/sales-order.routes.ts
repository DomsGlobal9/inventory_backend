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

const router = Router();

router.post('/', createOrder);
router.post('/full', createFullOrder);
router.get('/', getOrders);
router.get('/:id', getOrderById);
router.patch('/:id', updateOrder);
router.delete('/:id', deleteOrder);
router.post('/:id/items', addOrderItem);
router.delete('/:id/items/:itemId', removeOrderItem);
router.post('/:id/confirm', confirmOrder);
router.post('/:id/cancel', cancelOrder);

export default router;
