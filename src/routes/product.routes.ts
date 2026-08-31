import { Router } from 'express';
import { productController } from '../controllers/product.controller';
import { variantController } from '../controllers/variant.controller';
import { imageController } from '../controllers/image.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { upsertVariantLocationProfile } from '../controllers/variant-location.controller';

const router = Router();

// Apply tenant context to all product routes
router.use(tenantMiddleware);

router.post('/', productController.create);
router.get('/', productController.getAll);
router.get('/:id', productController.getOne);
router.patch('/:id', productController.update);

// Lifecycle Commands
router.post('/:id/archive', productController.archive);
router.post('/:id/restore', productController.restore);
router.post('/:id/trash', productController.trash);
router.delete('/:id/hard', productController.hardDelete);

// Nested Variant Routes
router.post('/:productId/variants/bulk', variantController.bulkCreate);
router.post('/:productId/variants', variantController.create);
router.get('/:productId/variants', variantController.getByProduct);
router.patch('/:productId/variants/:variantId/locations/:locationId', upsertVariantLocationProfile);

// Nested Image Routes
router.post('/:productId/images', imageController.create);
router.get('/:productId/images', imageController.getByProduct);
router.patch('/images/:id', imageController.update);
router.delete('/images/:id', imageController.delete); // Direct access for deletion since ID is globally unique

export default router;
