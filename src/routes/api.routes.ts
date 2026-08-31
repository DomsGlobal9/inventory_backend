import { Router } from 'express';

import productRoutes from './product.routes';
import variantRoutes from './variant.routes';
import inventoryRoutes from './inventory.routes';
import dashboardRoutes from './dashboard.routes';
import transactionRoutes from './transaction.routes';
import catalogRoutes from './catalog.routes';
import searchRoutes from './search.routes';
import stockCountRoutes from './stock-count.routes';
import supplierRoutes from './supplier.routes';
import purchaseOrderRoutes from './purchase-order.routes';
import reportRoutes from './report.routes';
import customerRoutes from './customer.routes';
import salesOrderRoutes from './sales-order.routes';
import dispatchRoutes from './dispatch.routes';
import { returnsRoutes } from './returns.routes';
import authRoutes from './auth.routes';
import locationRoutes from './location.routes';
import inventoryTransferRoutes from './inventory-transfer.routes';
import inventoryAlertRoutes from './inventory-alert.routes';

const router = Router();

// Mount Routes
router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/variants', variantRoutes);
router.use('/inventory/transactions', transactionRoutes);
router.use('/inventory/alerts', inventoryAlertRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/catalog', catalogRoutes);
router.use('/search', searchRoutes);
router.use('/stock-counts', stockCountRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
router.use('/reports', reportRoutes);
router.use('/customers', customerRoutes);
router.use('/sales-orders', salesOrderRoutes);
router.use('/dispatches', dispatchRoutes);
router.use('/returns', returnsRoutes);
router.use('/locations', locationRoutes);
router.use('/inventory-transfers', inventoryTransferRoutes);

export default router;
