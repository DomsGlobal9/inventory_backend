import { Router } from 'express';
import { searchController } from '../controllers/search.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

router.get('/', requirePermission('product:view'), searchController.search.bind(searchController));

export default router;
