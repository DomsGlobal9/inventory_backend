import { Router } from 'express';
import { reportController } from '../controllers/report.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

router.get('/inventory-value', reportController.getTenantValue);
router.get('/category-value', reportController.getCategoryValue);
router.post('/snapshots', reportController.createSnapshot);
router.get('/snapshots', reportController.getSnapshots);
router.post('/run-snapshot', reportController.runGlobalSnapshot);

router.get('/dashboard-summary', reportController.getDashboardSummary);
router.get('/open-po-value', reportController.getOpenPoValue);
router.get('/low-stock-value', reportController.getLowStockValue);
router.get('/movement-aging', reportController.getMovementAging);

router.get('/inventory-summary', reportController.getInventorySummary);
router.get('/dead-stock', reportController.getDeadStock);
router.get('/supplier-spend', reportController.getSupplierSpend);
router.get('/stock-movement', reportController.getStockMovement);
router.get('/recent-transactions', reportController.getRecentTransactions);

export default router;
