import { Router } from 'express';
import {
  createCustomer,
  getCustomerByPhone,
  getCustomers,
  getCustomerById,
  updateCustomer
} from '../controllers/customer.controller';
import { tenantMiddleware } from '../middleware/tenant.middleware';

import { requirePermission } from '../middleware/permission.middleware';
import { customerCard } from '../services/customer-card';
import { doorCheckins } from '../services/door-checkin';
import { prisma } from '../lib/prisma';
import { respondWithError } from '../utils/respondWithError';

const router = Router();

router.use(tenantMiddleware);

// Customer ingestion endpoint
router.post('/', requirePermission('customer:create'), createCustomer);

router.get('/', requirePermission('customer:view'), getCustomers);
// The Customer card: who this number is, their sizes and colours, and what in this store fits them.
router.get('/card', requirePermission('customer:view'), async (req, res) => {
  try {
    const locationId = typeof req.query.locationId === 'string' && req.query.locationId ? req.query.locationId : undefined;
    res.json({ success: true, data: await customerCard.lookup((req as any).clientId, req.query.phone, locationId) });
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
});
// Door QR check-in: who is in this store now, "I'll take them", and the QR for the door.
router.get('/checkins', requirePermission('customer:view'), async (req, res) => {
  try { res.json({ success: true, data: await doorCheckins.list((req as any).clientId, req.query.locationId) }); }
  catch (error) { return respondWithError(res, error, { status: 500 }); }
});
router.post('/checkins/:id/take', requirePermission('customer:view'), async (req, res) => {
  try {
    const user = (req as any).user;
    const name = user?.id ? (await prisma.user.findFirst({ where: { id: user.id, clientId: (req as any).clientId }, select: { name: true } }))?.name ?? null : null;
    res.json({ success: true, data: await doorCheckins.take((req as any).clientId, String(req.params.id), { id: user?.id ?? null, name }) });
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
});
router.get('/door-qr', requirePermission('customer:view'), async (req, res) => {
  try { res.json({ success: true, data: await doorCheckins.doorQr((req as any).clientId, req.query.locationId) }); }
  catch (error) { return respondWithError(res, error, { status: 500 }); }
});
router.post('/:id/notes', requirePermission('customer:update'), async (req, res) => {
  try {
    res.status(201).json({ success: true, data: await customerCard.addNote((req as any).clientId, String(req.params.id),req.body?.note, (req as any).user?.id ?? null) });
  } catch (error) { return respondWithError(res, error, { status: 500 }); }
});
// Before /:id, which would otherwise take "by-phone" as a customer id.
router.get('/by-phone/:phone', requirePermission('customer:view'), getCustomerByPhone);
router.get('/:id', requirePermission('customer:view'), getCustomerById);
router.patch('/:id', requirePermission('customer:update'), updateCustomer);

export default router;
