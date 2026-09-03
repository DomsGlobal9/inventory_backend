import { Router } from 'express';
import { catalogTryOnController } from '../controllers/catalog-tryon.controller';
import { requirePermission } from '../middleware/permission.middleware';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

router.post('/generate-catalog', requirePermission('product:create'), catalogTryOnController.generateCatalog.bind(catalogTryOnController));
router.post('/cancel-job', requirePermission('product:create'), catalogTryOnController.cancelJob.bind(catalogTryOnController));

export default router;
