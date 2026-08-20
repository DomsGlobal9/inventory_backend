import { Router } from 'express';
import { returnService } from '../services/return.service';

export const returnsRoutes = Router();

returnsRoutes.get('/', async (req, res) => {
  try {
    const clientId = req.user?.clientId || 'test-client-id'; // using mock client
    const returns = await returnService.getReturns(clientId);
    res.json({ data: returns });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

returnsRoutes.get('/:id', async (req, res) => {
  try {
    const clientId = req.user?.clientId || 'test-client-id';
    const ret = await returnService.getReturnById(clientId, req.params.id);
    res.json({ data: ret });
  } catch (error: any) {
    if (error.message === 'Return not found') {
      res.status(404).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
});

returnsRoutes.post('/', async (req, res) => {
  try {
    const clientId = req.user?.clientId || 'test-client-id';
    const { salesOrderId, items, notes } = req.body;
    const newReturn = await returnService.createReturn(clientId, salesOrderId, items, notes);
    res.status(201).json({ data: newReturn });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

returnsRoutes.post('/:id/receive', async (req, res) => {
  try {
    const clientId = req.user?.clientId || 'test-client-id';
    const updated = await returnService.receiveReturn(clientId, req.params.id);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

returnsRoutes.post('/:id/inspect', async (req, res) => {
  try {
    const clientId = req.user?.clientId || 'test-client-id';
    const { itemsDisposition } = req.body;
    const updated = await returnService.inspectReturn(clientId, req.params.id, itemsDisposition);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

returnsRoutes.post('/:id/complete', async (req, res) => {
  try {
    const clientId = req.user?.clientId || 'test-client-id';
    const updated = await returnService.completeReturn(clientId, req.params.id);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});

returnsRoutes.post('/:id/reject', async (req, res) => {
  try {
    const clientId = req.user?.clientId || 'test-client-id';
    const updated = await returnService.rejectReturn(clientId, req.params.id);
    res.json({ data: updated });
  } catch (error: any) {
    res.status(400).json({ message: error.message });
  }
});
