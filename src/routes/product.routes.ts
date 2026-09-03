import { Router } from 'express';
import { productController } from '../controllers/product.controller';
import { variantController } from '../controllers/variant.controller';
import { imageController } from '../controllers/image.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { upsertVariantLocationProfile } from '../controllers/variant-location.controller';

const router = Router();

// Apply tenant context to all product routes
router.use(tenantMiddleware);

router.post('/', requirePermission('product:create'), productController.create);
router.get('/', requirePermission('product:view'), productController.getAll);
router.get('/:id', requirePermission('product:view'), productController.getOne);
router.patch('/:id', requirePermission('product:update'), productController.update);

// Lifecycle Commands
router.post('/:id/archive', requirePermission('product:delete'), productController.archive);
router.post('/:id/restore', requirePermission('product:delete'), productController.restore);
router.post('/:id/trash', requirePermission('product:delete'), productController.trash);
router.delete('/:id/hard', requirePermission('product:delete'), productController.hardDelete);

// Nested Variant Routes
router.post('/:productId/variants/bulk', requirePermission('product:create'), variantController.bulkCreate);
router.post('/:productId/variants', requirePermission('product:create'), variantController.create);
router.get('/:productId/variants', requirePermission('product:view'), variantController.getByProduct);
router.patch('/:productId/variants/:variantId/locations/:locationId', requirePermission('product:update'), upsertVariantLocationProfile);

// Nested Image Routes
router.post('/:productId/images', requirePermission('product:update'), imageController.create);
router.get('/:productId/images', requirePermission('product:view'), imageController.getByProduct);
router.patch('/images/:id', requirePermission('product:update'), imageController.update);
router.delete('/images/:id', requirePermission('product:update'), imageController.delete); // Direct access for deletion since ID is globally unique

export default router;
