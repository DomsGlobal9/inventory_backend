import { Router } from 'express';
import { inventoryController } from '../controllers/inventory.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

router.post('/stock-in', inventoryController.stockIn);
router.post('/stock-out', inventoryController.stockOut);
router.post('/adjustment', inventoryController.adjustment);
router.get('/transactions', inventoryController.getTransactions);
router.get('/variants', inventoryController.getVariants);
router.get('/metadata', inventoryController.getMetadata);
router.post('/reconcile-valuation', inventoryController.reconcileValuation);
router.post('/transfer', inventoryController.transfer);

export default router;
