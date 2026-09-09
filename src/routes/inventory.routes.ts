import { Router } from 'express';
import { inventoryController } from '../controllers/inventory.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

router.post('/stock-in', requirePermission('inventory:receive'), inventoryController.stockIn);
router.post('/stock-out', requirePermission('inventory:adjust'), inventoryController.stockOut);
router.post('/adjustment', requirePermission('inventory:adjust'), inventoryController.adjustment);
router.get('/transactions', requirePermission('inventory:view'), inventoryController.getTransactions);
router.get('/variants', requirePermission('inventory:view'), inventoryController.getVariants);
router.get('/metadata', requirePermission('inventory:view'), inventoryController.getMetadata);
router.post('/reconcile-valuation', requirePermission('cost:manage'), inventoryController.reconcileValuation);
// Restates what stock on hand cost, without moving any of it. The repair for stock that
// entered the system with no cost recorded, which no purchase order can fix -- buying more
// adds to the average, it does not restate what is already on the shelf.
router.post('/set-cost', requirePermission('cost:manage'), inventoryController.setCostOfStockOnHand);

export default router;
