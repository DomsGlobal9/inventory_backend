import { Router } from 'express';
import { variantController } from '../controllers/variant.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

const router = Router();

router.use(tenantMiddleware);

// Note: creation and fetching by product is usually mounted under /products/:productId/variants
// But we'll handle standard routes here. In server.ts we can mount product-scoped ones differently.

router.get('/search', variantController.search.bind(variantController));
router.post('/bulk-update', variantController.bulkUpdate);
router.patch('/:id', variantController.update);
router.delete('/:id', variantController.delete);

export default router;
