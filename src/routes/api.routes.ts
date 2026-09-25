import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { trackActivity } from '../middleware/activity-tracker.middleware';
import { auditLogger } from '../middleware/audit-logger.middleware';
import { hideCostUnlessPermitted } from '../middleware/cost-visibility.middleware';

import productRoutes from './product.routes';
import variantRoutes from './variant.routes';
import inventoryRoutes from './inventory.routes';
import dashboardRoutes from './dashboard.routes';
import transactionRoutes from './transaction.routes';
import catalogRoutes from './catalog.routes';
import catalogTryOnRoutes from './catalog-tryon.routes';
import photoJobsRoutes from './photo-jobs.routes';
import searchRoutes from './search.routes';
import stockCountRoutes from './stock-count.routes';
import supplierRoutes from './supplier.routes';
import purchaseOrderRoutes from './purchase-order.routes';
import reportRoutes from './report.routes';
import customerRoutes from './customer.routes';
import salesOrderRoutes from './sales-order.routes';
import counterSaleRoutes from './counter-sale.routes';
import shelvesRoutes from './shelves.routes';
import offerRoutes from './offer.routes';
import pricingRoutes from './pricing.routes';
import dispatchRoutes from './dispatch.routes';
import roleRoutes from './role.routes';
import brandingRoutes from './branding.routes';
import productImportRoutes from './product-import.routes';
import { returnsRoutes } from './returns.routes';
import authRoutes from './auth.routes';
import locationRoutes from './location.routes';
import inventoryTransferRoutes from './inventory-transfer.routes';
import inventoryAlertRoutes from './inventory-alert.routes';
import internalRoutes from './internal.routes';
import linksApiRoutes from './links-api.routes';
import { platformAdminAuthRoutes, platformAdminConsoleRoutes } from './platform-admin.routes';
import leadRoutes from './lead.routes';
import storefrontPublicRoutes from './storefront-public.routes';
import shopifyPublicRoutes from './shopify-public.routes';
import shopperTryOnPublicRoutes from './shopper-tryon-public.routes';
import tryOnCounterRoutes from './tryon-counter.routes';
import shopifyMerchantRoutes from './shopify-merchant.routes';
import serviceCatalogueRoutes from './service-catalogue.routes';
import storefrontConnectionRoutes from './storefront-connection.routes';
import supplierProductRoutes from './supplier-product.routes';
import reorderRoutes from './reorder.routes';
import dayBookRoutes from './daybook.routes';
import whatsappRoutes, { whatsappEvents } from './whatsapp.routes';
import campaignRoutes from './campaign.routes';
import onlineShopRoutes from './online-shop.routes';
import loyaltyRoutes from './loyalty.routes';
import counterReturnRoutes from './counter-return.routes';
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

// The API a merchant's website calls. Mounted ahead of the global gate below because the
// caller is a storefront holding a connection credential, not a person with a session cookie.
// It authenticates itself (authenticateStorefront), and that credential identifies a
// connection, which supplies the tenant and the location scope -- so nothing here trusts a
// clientId the caller sent.
router.use('/storefront/v1', storefrontPublicRoutes);

// Shopify's OAuth callback and its webhooks. Also ahead of the gate, and for a stronger
// reason: a callback is a browser redirect and a webhook is a POST from Shopify's servers, so
// neither can carry a session, an API key or a tenant header. Both prove themselves with
// Shopify's HMAC instead, which is verified inside every handler before anything is read.
router.use('/shopify', shopifyPublicRoutes);

// Try-On, reached by a shopper scanning the QR code on a garment. Ahead of the gate because
// the caller is a customer in a shop with no account and no reason to make one -- the weakest
// caller on this service, so it is also the most tightly limited. It reads only what is
// already printed on the tag, and the shop's gateway key never leaves the server.
router.use('/public/tryon', shopperTryOnPublicRoutes);
// Try-on at the counter: signed in, the shop's own staff, the shop's own allowance.
router.use('/tryon', tryOnCounterRoutes);

// Delivery ticks and account changes from the ScaleEzy WhatsApp Service. Ahead of the gate: the
// service has no session, and proves itself with a signature checked before anything is read.
router.post('/whatsapp/events', whatsappEvents);

// Short links for other ScaleEzy services. Ahead of the gate: the caller is a service with a signed
// token naming the shop, checked before anything is read (verifyServiceToken).
router.use('/links-api', linksApiRoutes);

// Global Authentication Enforcement for all business APIs
router.use(authenticate);
// Platform-wide "latest activity" signal for the Platform Console -- every authenticated
// hit on any business route, not just logins, bumps User.lastActiveAt (throttled).
router.use(trackActivity);
// Records every successful mutation (POST/PUT/PATCH/DELETE) into AuditLog for the Platform
// Console's unified activity feed. GETs are deliberately not logged -- read traffic would
// flood the table for no signal a platform admin actually wants.
router.use(auditLogger);

// What the business paid, removed from responses for anyone without cost:view. Mounted per
// router below rather than once here: purchase orders, suppliers and the day book show cost by
// definition (their permissions `exposesCost`, or require report:financial), and stripping it
// there would leave a purchase order with no prices. See middleware/cost-visibility.
const hideCost = hideCostUnlessPermitted();

// Mount Business Routes
// Mounted BEFORE /products so that /products/import is not swallowed by /products/:id.
router.use('/products/import', hideCost, productImportRoutes);
router.use('/products', hideCost, productRoutes);
// Except a variant's suppliers: that path falls through to supplierProductRoutes below, and a
// supplier's agreed price is shown to supplier:view by design.
router.use('/variants', hideCostUnlessPermitted({ except: /^\/[^/]+\/suppliers\/?$/ }), variantRoutes);
router.use('/inventory/transactions', hideCost, transactionRoutes);
router.use('/inventory/alerts', hideCost, inventoryAlertRoutes);
router.use('/inventory', hideCost, inventoryRoutes);
router.use('/dashboard', hideCost, dashboardRoutes);
// The shop's own name and logo. Readable by anyone signed in, changeable only by the owner.
router.use('/branding', brandingRoutes);
router.use('/catalog', hideCost, catalogRoutes);
router.use('/catalog-tryon', catalogTryOnRoutes);
// Sets of photographs being made on this side, so the shop does not have to sit and watch.
router.use('/photo-jobs', photoJobsRoutes);
router.use('/search', hideCost, searchRoutes);
router.use('/stock-counts', hideCost, stockCountRoutes);
router.use('/suppliers', supplierRoutes);
// Mounted at the root because it spans two nouns -- /suppliers/:id/products and
// /variants/:id/suppliers are the same relationship read from either end.
router.use('/', supplierProductRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
// A reorder suggestion is a purchase order not yet raised: its prices are what the supplier
// charges. Seen by whoever may see cost or purchase orders, hidden from the stock room otherwise.
router.use('/reorder', hideCostUnlessPermitted({
  alsoHide: ['unitPrice', 'lineTotal', 'estimatedTotal'],
  alsoVisibleTo: ['purchase_order:view']
}), reorderRoutes);
router.use('/daybook', dayBookRoutes);
router.use('/reports', hideCost, reportRoutes);
router.use('/customers', hideCost, customerRoutes);
router.use('/sales-orders', hideCost, salesOrderRoutes);
// Selling at the counter. hideCost as a second guard: nothing here selects cost, and nothing should.
router.use('/counter-sales', hideCost, counterSaleRoutes);
router.use('/offers', offerRoutes);
router.use('/pricing', pricingRoutes);
router.use('/dispatches', hideCost, dispatchRoutes);
// Roles: what a job is allowed to do, composed by the shop from the platform's catalogue.
router.use('/roles', roleRoutes);
router.use('/returns', hideCost, returnsRoutes);
router.use('/locations', locationRoutes);
// Managing storefront connections: the merchant's side, behind the normal session.
router.use('/storefront-connections', storefrontConnectionRoutes);
// Connecting and claiming a Shopify store. Behind the session, unlike /shopify above.
router.use('/shopify-connect', shopifyMerchantRoutes);
// What a merchant may see about the platform services their workspace uses. Read only, and
// structurally unable to return a key -- see the route file.
router.use('/services', serviceCatalogueRoutes);
router.use('/inventory-transfers', hideCost, inventoryTransferRoutes);
// Racks and shelves: where inside a location the pieces are. Quantities only, never cost.
router.use('/shelves', hideCost, shelvesRoutes);
router.use('/support-tickets', supportTicketRoutes);
router.use('/team', teamRoutes);
router.use('/whatsapp', whatsappRoutes);
router.use('/campaigns', campaignRoutes);
router.use('/online-shop', onlineShopRoutes);
router.use('/loyalty', loyaltyRoutes);
// Returns taken back at the counter, and store credit. Money only, never what the shop paid.
router.use('/counter-returns', hideCost, counterReturnRoutes);

export default router;
