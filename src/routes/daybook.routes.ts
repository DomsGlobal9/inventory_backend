import { Router } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { getDayBook } from '../controllers/daybook.controller';

const router = Router();
router.use(tenantMiddleware);

// Read-only, and carries the same permission as the dashboard: it shows the same facts,
// arranged by day rather than as a live total.
router.get('/', requirePermission('report:financial'), getDayBook);

export default router;
