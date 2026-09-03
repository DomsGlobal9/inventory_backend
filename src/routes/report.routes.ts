import { Router } from 'express';
import { reportController } from '../controllers/report.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

router.get('/inventory-value', requirePermission('dashboard:view'), reportController.getTenantValue);
router.get('/category-value', requirePermission('dashboard:view'), reportController.getCategoryValue);
router.post('/snapshots', requirePermission('dashboard:view'), reportController.createSnapshot);
router.get('/snapshots', requirePermission('dashboard:view'), reportController.getSnapshots);
// run-snapshot is a cross-tenant system job, gated separately by its own x-admin-secret
// check inside the controller — no per-tenant RBAC permission makes sense for it.
router.post('/run-snapshot', reportController.runGlobalSnapshot);

router.get('/dashboard-summary', requirePermission('dashboard:view'), reportController.getDashboardSummary);
router.get('/open-po-value', requirePermission('dashboard:view'), reportController.getOpenPoValue);
router.get('/low-stock-value', requirePermission('dashboard:view'), reportController.getLowStockValue);
router.get('/movement-aging', requirePermission('dashboard:view'), reportController.getMovementAging);

router.get('/inventory-summary', requirePermission('dashboard:view'), reportController.getInventorySummary);
router.get('/dead-stock', requirePermission('dashboard:view'), reportController.getDeadStock);
router.get('/supplier-spend', requirePermission('dashboard:view'), reportController.getSupplierSpend);
router.get('/stock-movement', requirePermission('dashboard:view'), reportController.getStockMovement);
router.get('/recent-transactions', requirePermission('dashboard:view'), reportController.getRecentTransactions);

export default router;
