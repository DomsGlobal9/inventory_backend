import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { getAlerts, markAsRead, markAllAsRead } from '../controllers/inventory-alert.controller';

const router = Router();

// All alert routes require authentication and inventory viewing permission
router.use(requireAuth);
router.use(requirePermission('inventory:view'));

router.get('/', getAlerts);
router.patch('/read-all', markAllAsRead);
router.patch('/:id/read', markAsRead);

export default router;
