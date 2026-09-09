import { Router } from 'express';
import { catalogTryOnController } from '../controllers/catalog-tryon.controller';
import { requirePermission } from '../middleware/permission.middleware';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

// Metered and billed per use, so it is its own capability rather than a side effect of being
// allowed to add a product. Whether the SHOP may spend it -- allowance left, service switched
// on -- is a separate question answered in the try-on usage service, not here.
router.post('/generate-catalog', requirePermission('tryon:generate'), catalogTryOnController.generateCatalog.bind(catalogTryOnController));
router.post('/cancel-job', requirePermission('tryon:generate'), catalogTryOnController.cancelJob.bind(catalogTryOnController));

export default router;
