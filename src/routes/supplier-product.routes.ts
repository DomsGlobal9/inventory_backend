import { Router } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import {
  linkProduct,
  unlinkProduct,
  listSupplierProducts,
  listVariantSuppliers,
  setPreferredSupplier
} from '../controllers/supplier-product.controller';

const router = Router();

router.use(tenantMiddleware);

// Reading which items a supplier sells is supplier information; changing the catalogue is a
// supplier edit. Reusing the supplier permissions rather than inventing a new pair keeps
// this out of the roles UI, where a separate permission would need explaining and would be
// granted to exactly the same people.
router.get('/suppliers/:supplierId/products', requirePermission('supplier:view'), listSupplierProducts);
router.get('/variants/:variantId/suppliers', requirePermission('supplier:view'), listVariantSuppliers);
router.post('/supplier-products', requirePermission('supplier:update'), linkProduct);
router.post('/supplier-products/:id/preferred', requirePermission('supplier:update'), setPreferredSupplier);
router.delete('/supplier-products/:id', requirePermission('supplier:update'), unlinkProduct);

export default router;
