import { Router } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { getAlerts, markAsRead, markAllAsRead, togglePin, deleteAlert } from '../controllers/inventory-alert.controller';

const router = Router();

// tenantMiddleware resolves the x-location-id header into req.locationId so
// alerts can be scoped to the currently-selected location, matching every
// other dashboard/report endpoint.
router.use(tenantMiddleware);

// All alert routes require authentication and inventory viewing permission
router.use(requirePermission('inventory:view'));

router.get('/', getAlerts);
router.patch('/read-all', markAllAsRead);
router.patch('/:id/read', markAsRead);
router.patch('/:id/pin', togglePin);
router.delete('/:id', deleteAlert);

export default router;
