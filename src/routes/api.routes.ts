import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { trackActivity } from '../middleware/activity-tracker.middleware';
import { auditLogger } from '../middleware/audit-logger.middleware';

import productRoutes from './product.routes';
import variantRoutes from './variant.routes';
import inventoryRoutes from './inventory.routes';
import dashboardRoutes from './dashboard.routes';
import transactionRoutes from './transaction.routes';
import catalogRoutes from './catalog.routes';
import catalogTryOnRoutes from './catalog-tryon.routes';
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
import internalRoutes from './internal.routes';
import { platformAdminAuthRoutes, platformAdminConsoleRoutes } from './platform-admin.routes';
import leadRoutes from './lead.routes';
import supplierProductRoutes from './supplier-product.routes';
import reorderRoutes from './reorder.routes';
import clientErrorRoutes from './client-error.routes';
import supportTicketRoutes from './support-ticket.routes';
import teamRoutes from './team.routes';

const router = Router();

// Mount internal service routes
router.use('/internal', internalRoutes);

// Mount Auth routes (Public/Idempotent)
router.use('/auth', authRoutes);

// Platform Admin (Scaleezy-wide console) has its own separate auth (verifyPlatformAdmin,
// not the client `authenticate`) -- it must be mounted ahead of the global authentication
// gate below, or every console request would first need a client session cookie that a
// platform admin browsing cross-tenant simply doesn't have.
router.use('/auth/admin', platformAdminAuthRoutes);
router.use('/admin', platformAdminConsoleRoutes);

// A frontend crash can happen before login resolves (or because auth itself is broken),
// so error reporting must not require a valid session -- same reasoning as the platform
// admin routes above, mounted ahead of the global authentication gate.
router.use('/client-errors', clientErrorRoutes);

// Public signup form. Mounted above the global `authenticate` below because the whole point
// is that a prospect has no account yet. It only records an enquiry -- it creates no client,
// workspace, login or role -- so there is nothing here for an anonymous caller to provision.
router.use('/leads', leadRoutes);

// Global Authentication Enforcement for all business APIs
router.use(authenticate);
// Platform-wide "latest activity" signal for the Platform Console -- every authenticated
// hit on any business route, not just logins, bumps User.lastActiveAt (throttled).
router.use(trackActivity);
// Records every successful mutation (POST/PUT/PATCH/DELETE) into AuditLog for the Platform
// Console's unified activity feed. GETs are deliberately not logged -- read traffic would
// flood the table for no signal a platform admin actually wants.
router.use(auditLogger);

// Mount Business Routes
router.use('/products', productRoutes);
router.use('/variants', variantRoutes);
router.use('/inventory/transactions', transactionRoutes);
router.use('/inventory/alerts', inventoryAlertRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/catalog', catalogRoutes);
router.use('/catalog-tryon', catalogTryOnRoutes);
router.use('/search', searchRoutes);
router.use('/stock-counts', stockCountRoutes);
router.use('/suppliers', supplierRoutes);
// Mounted at the root because it spans two nouns -- /suppliers/:id/products and
// /variants/:id/suppliers are the same relationship read from either end.
router.use('/', supplierProductRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
router.use('/reorder', reorderRoutes);
router.use('/reports', reportRoutes);
router.use('/customers', customerRoutes);
router.use('/sales-orders', salesOrderRoutes);
router.use('/dispatches', dispatchRoutes);
router.use('/returns', returnsRoutes);
router.use('/locations', locationRoutes);
router.use('/inventory-transfers', inventoryTransferRoutes);
router.use('/support-tickets', supportTicketRoutes);
router.use('/team', teamRoutes);

export default router;
