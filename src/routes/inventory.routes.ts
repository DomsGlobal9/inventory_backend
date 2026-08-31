import { Router } from 'express';
import { inventoryController } from '../controllers/inventory.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(requireAuth);
router.use(tenantMiddleware);

router.post('/stock-in', requirePermission('inventory:receive'), inventoryController.stockIn);
router.post('/stock-out', requirePermission('inventory:adjust'), inventoryController.stockOut);
router.post('/adjustment', requirePermission('inventory:adjust'), inventoryController.adjustment);
router.get('/transactions', requirePermission('inventory:view'), inventoryController.getTransactions);
router.get('/variants', requirePermission('inventory:view'), inventoryController.getVariants);
router.get('/metadata', requirePermission('inventory:view'), inventoryController.getMetadata);
router.post('/reconcile-valuation', requirePermission('inventory:adjust'), inventoryController.reconcileValuation);
router.post('/transfer', requirePermission('inventory:transfer'), inventoryController.transfer);

export default router;
