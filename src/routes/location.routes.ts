import { Router } from 'express';
import { getLocations, createLocation, updateLocation, deleteLocation } from '../controllers/location.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(requireAuth);
router.use(tenantMiddleware);

router.get('/', requirePermission('admin:locations'), getLocations);
router.post('/', requirePermission('admin:locations'), createLocation);
router.put('/:id', requirePermission('admin:locations'), updateLocation);
router.delete('/:id', requirePermission('admin:locations'), deleteLocation);

export default router;
