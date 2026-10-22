import { myDay } from '../services/my-day.service';
import { dashboardOverview } from '../services/dashboard-overview';
import { Router } from 'express';
import { dashboardController } from '../controllers/dashboard.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);
router.get('/summary', requirePermission('dashboard:view'), dashboardController.getSummary);
// The cards that follow the person's own permissions (see services/my-day.service.ts).
router.get('/my-day', requirePermission('dashboard:view'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await myDay((req as any).clientId, (req as any).user ?? {}, (req as any).locationId) });
  } catch (error) { next(error); }
});

// The redesigned top half: sales, stock, top sellers, latest orders -- each part only for somebody
// allowed it (see services/dashboard-overview).
router.get('/overview', requirePermission('dashboard:view'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await dashboardOverview((req as any).clientId, (req as any).user ?? {}, (req as any).locationId) });
  } catch (error) { next(error); }
});

export default router;
