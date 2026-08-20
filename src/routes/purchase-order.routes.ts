import { Router } from 'express';
import { getPOs, getPOById, createPO, updatePOStatus, receiveGoods } from '../controllers/purchase-order.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

// Inject verified clientId into every PO request
router.use(tenantMiddleware);

router.get('/', getPOs);
router.get('/:id', getPOById);
router.post('/', createPO);
router.put('/:id/status', updatePOStatus);
router.post('/:id/receive', receiveGoods);

export default router;
