import { Router } from 'express';
import { dashboardController } from '../controllers/dashboard.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);
router.get('/summary', requirePermission('dashboard:view'), dashboardController.getSummary);

export default router;
