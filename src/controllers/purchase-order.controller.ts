import { Request, Response, NextFunction } from 'express';
import { purchaseOrderService } from '../services/purchase-order.service';
import { purchaseOrderCreateSchema, purchaseOrderDeliverToSchema, purchaseOrderReceiveSchema } from '../validations/purchase-order.schema';

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

    const parsed = purchaseOrderCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Validation error', errors: parsed.error.errors });
    }

    const data = await purchaseOrderService.createPO(clientId, parsed.data as any, (req as any).locationId);
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const setDeliverTo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const parsed = purchaseOrderDeliverToSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Validation error', errors: parsed.error.errors });
    }
    const result = await purchaseOrderService.setDeliverTo(clientId, req.params.id as string, parsed.data.locationId);
    res.json({ success: true, data: result.po, previous: result.previous, changed: result.changed, supplierAlreadyTold: result.supplierAlreadyTold });
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

    const parsed = purchaseOrderReceiveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Validation error', errors: parsed.error.errors });
    }

    const id = req.params.id as string;
    const user = (req as any).user;
    const { po, receipt, duplicate } = await purchaseOrderService.receiveGoods(
      clientId, id, parsed.data as any,
      { id: user?.id, name: user?.name },
      (req as any).locationId
    );
    // `data` is still the order, as it always was; the receipt rides beside it.
    res.json({ success: true, data: po, receipt, duplicate });
  } catch (error) {
    next(error);
  }
};

export const emailPOToSupplier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const id = req.params.id as string;
    // Who pressed it, so the supplier knows which person at the shop to reply to. Read from
    // the verified session, never from the body -- otherwise anyone could sign an order with
    // a colleague's name.
    const orderedByName = (req as any).user?.name as string | undefined;
    const data = await purchaseOrderService.emailToSupplier(clientId, id, orderedByName);
    res.json({ success: true, data, message: `Order emailed to ${data.to}` });
  } catch (error) {
    next(error);
  }
};
