import { Request, Response, NextFunction } from 'express';
import { purchaseOrderService } from '../services/purchase-order.service';

/** Read the verified tenant ID set by tenantMiddleware — never trust the request body. */
function getClientId(req: Request, res: Response): string | null {
  const clientId = (req as any).clientId as string | undefined;
  if (!clientId) {
    res.status(401).json({ success: false, message: 'Unauthorized: tenant context missing' });
    return null;
  }
  return clientId;
}

export const getPOs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const data = await purchaseOrderService.getPOs(clientId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getPOById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const id = req.params.id as string;
    const data = await purchaseOrderService.getPOById(clientId, id);
    if (!data) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const createPO = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const data = await purchaseOrderService.createPO(clientId, req.body);
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updatePOStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const id = req.params.id as string;
    const { status } = req.body;
    const data = await purchaseOrderService.updatePOStatus(clientId, id, status);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const receiveGoods = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const id = req.params.id as string;
    const { receipts } = req.body;
    const data = await purchaseOrderService.receiveGoods(clientId, id, receipts);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
