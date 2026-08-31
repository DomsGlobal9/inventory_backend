import { Router } from 'express';
import { returnService } from '../services/return.service';
import { tenantMiddleware } from '../middleware/tenant.middleware';

import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';

export const returnsRoutes = Router();

returnsRoutes.use(requireAuth);
returnsRoutes.use(tenantMiddleware);

returnsRoutes.get('/', requirePermission('return:view'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const returns = await returnService.getReturns(clientId);
    res.json({ data: returns });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

returnsRoutes.get('/:id', requirePermission('return:view'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const ret = await returnService.getReturnById(clientId, req.params.id as string);
    res.json({ data: ret });
  } catch (error: any) {
    if (error.message === 'Return not found') {
      res.status(404).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

returnsRoutes.post('/', requirePermission('return:create'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const { salesOrderId, items, notes } = req.body;
    const newReturn = await returnService.createReturn(clientId, salesOrderId, items, notes);
    res.status(201).json({ data: newReturn });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

returnsRoutes.post('/:id/receive', requirePermission('return:receive'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const updated = await returnService.receiveReturn(clientId, req.params.id as string);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

returnsRoutes.post('/:id/inspect', requirePermission('return:inspect'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const { itemsDisposition } = req.body;
    const updated = await returnService.inspectReturn(clientId, req.params.id as string, itemsDisposition);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

returnsRoutes.post('/:id/complete', requirePermission('return:complete'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const updated = await returnService.completeReturn(clientId, req.params.id as string);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

returnsRoutes.post('/:id/reject', requirePermission('return:complete'), async (req, res) => {
  try {
    const clientId = (req as any).clientId as string;
    const updated = await returnService.rejectReturn(clientId, req.params.id as string);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});
