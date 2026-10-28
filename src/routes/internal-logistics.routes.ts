import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import * as logisticsProducts from '../services/logistics/products';
import * as logisticsParcels from '../services/logistics/parcels';
import { respondWithError } from '../utils/respondWithError';

/**
 * What ScaleEzy Logistics asks Inventory, for one shop (28 Oct). Mounted at
 * /api/v1/internal/modules/logistics, behind the service token (scope "modules:logistics").
 *
 *   GET /shops/:clientId/products/:sku             one product by SKU (404 when there is none)
 *   GET /shops/:clientId/products?skus=A,B,C       several: { products, not_found }
 *   GET /shops/:clientId/products/search?q=saree   autocomplete: sku, name, price, picture
 *   POST /shops/:clientId/parcels/:parcelId/updates  booking, label and statuses of a packed parcel
 *
 * ?location_id= on the first two counts stock in that store only. Only for a shop that has switched
 * Logistics on (PUT /internal/modules/logistics/shops/:clientId), and a token made for one shop may
 * only ask about that shop -- the same rules as CRM.
 */
const router = Router();

type Service = { id: string; scopes: string[]; clientId?: string };
const service = (req: Request) => (req as any).service as Service;
const clientIdOf = (req: Request) => String(req.params.clientId);
const fail = (res: Response, status: number, message: string, extra: object = {}) => res.status(status).json({ success: false, message, ...extra });
const locationOf = (req: Request) => (typeof req.query.location_id === 'string' && req.query.location_id ? req.query.location_id : undefined);

router.use((req, res, next) => service(req)?.scopes?.includes('modules:logistics') ? next() : fail(res, 403, 'This service may not do that (needs modules:logistics).'));

const shop = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = service(req);
    if (s.clientId && s.clientId !== clientIdOf(req)) return fail(res, 403, 'This token is for another shop.');
    const sub = await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: clientIdOf(req), module: 'logistics' } }, select: { clientId: true } });
    if (!sub) return fail(res, 404, 'This shop has not switched Logistics on.');
    next();
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
};

// Before /products/:sku, which would otherwise take "search" as a SKU.
router.get('/shops/:clientId/products/search', shop, async (req, res) => {
  try { res.json({ success: true, data: await logisticsProducts.search(clientIdOf(req), req.query.q, req.query.limit) }); }
  catch (error) { return respondWithError(res, error, { status: 500 }); }
});

router.get('/shops/:clientId/products/:sku', shop, async (req, res) => {
  try {
    const product = await logisticsProducts.bySku(clientIdOf(req), req.params.sku, locationOf(req));
    if (!product) return fail(res, 404, 'Product not found', { sku: String(req.params.sku) });
    res.json({ success: true, data: product });
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
});

router.get('/shops/:clientId/products', shop, async (req, res) => {
  try {
    if (typeof req.query.skus !== 'string' || !req.query.skus.trim()) return fail(res, 400, 'Say which SKUs: ?skus=A,B,C (up to 50).');
    res.json({ success: true, data: await logisticsProducts.many(clientIdOf(req), req.query.skus, locationOf(req)) });
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
});

/**
 * Logistics telling us what happened to a parcel: booked (courier, AWB, label), picked up, delivered,
 * returned, COD collected. Repeats are harmless; an update older than the last one changes nothing.
 */
router.post('/shops/:clientId/parcels/:parcelId/updates', shop, async (req, res) => {
  try { res.json({ success: true, data: await logisticsParcels.fromLogistics(clientIdOf(req), String(req.params.parcelId), req.body) }); }
  catch (error) { return respondWithError(res, error, { status: 400 }); }
});

export default router;
