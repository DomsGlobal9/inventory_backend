import { Router } from 'express';
import { reportController } from '../controllers/report.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

router.get('/inventory-value', requirePermission('report:financial'), reportController.getTenantValue);
router.get('/category-value', requirePermission('report:financial'), reportController.getCategoryValue);
router.post('/snapshots', requirePermission('report:financial'), reportController.createSnapshot);
router.get('/snapshots', requirePermission('report:financial'), reportController.getSnapshots);
// run-snapshot is a cross-tenant system job, gated separately by its own x-admin-secret
// check inside the controller — no per-tenant RBAC permission makes sense for it.
router.post('/run-snapshot', reportController.runGlobalSnapshot);

router.get('/dashboard-summary', requirePermission('report:financial'), reportController.getDashboardSummary);
router.get('/open-po-value', requirePermission('report:financial'), reportController.getOpenPoValue);
router.get('/low-stock-value', requirePermission('report:financial'), reportController.getLowStockValue);
router.get('/movement-aging', requirePermission('report:view'), reportController.getMovementAging);

router.get('/inventory-summary', requirePermission('report:financial'), reportController.getInventorySummary);
router.get('/dead-stock', requirePermission('report:financial'), reportController.getDeadStock);
router.get('/supplier-spend', requirePermission('report:financial'), reportController.getSupplierSpend);
router.get('/stock-movement', requirePermission('report:view'), reportController.getStockMovement);
router.get('/recent-transactions', requirePermission('report:view'), reportController.getRecentTransactions);

export default router;
