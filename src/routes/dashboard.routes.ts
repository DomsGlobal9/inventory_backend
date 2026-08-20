import { Router } from 'express';
import { dashboardController } from '../controllers/dashboard.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);
router.get('/summary', dashboardController.getSummary);

export default router;
