import { Router } from 'express';
import { variantController } from '../controllers/variant.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(tenantMiddleware);

// Note: creation and fetching by product is usually mounted under /products/:productId/variants
// But we'll handle standard routes here. In server.ts we can mount product-scoped ones differently.

router.get('/search', requirePermission('product:view'), variantController.search.bind(variantController));
// bulk-update can post real quantity changes (via inventoryMutationService), so it
// requires inventory:adjust in addition to being able to edit the variant itself.
router.post('/bulk-update', requirePermission('inventory:adjust'), variantController.bulkUpdate);
router.patch('/:id', requirePermission('product:update'), variantController.update);
router.delete('/:id', requirePermission('product:delete'), variantController.delete);

export default router;
