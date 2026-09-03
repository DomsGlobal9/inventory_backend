import { Router } from 'express';
import { getLocations, createLocation, updateLocation, deleteLocation } from '../controllers/location.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

// Reading the location list is app-shell reference data -- the location switcher in the
// top nav and every stock/transfer screen needs it, so it can't be admin-gated. It used to
// require `admin:locations`, which SALES and WAREHOUSE don't hold: those users got a
// "Forbidden" toast on EVERY page load and the Transfers page rendered empty location
// dropdowns they could never submit. `dashboard:view` is held by all five seeded roles.
// Creating/renaming/deleting locations stays admin-only below.
router.get('/', requirePermission('dashboard:view'), getLocations);
router.post('/', requirePermission('admin:locations'), createLocation);
router.put('/:id', requirePermission('admin:locations'), updateLocation);
router.delete('/:id', requirePermission('admin:locations'), deleteLocation);

export default router;
