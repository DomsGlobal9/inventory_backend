import { Request, Response } from 'express';
import { salesOrderService } from '../services/sales-order.service';
import { prisma } from '../lib/prisma';
import { createOrderSchema, createFullOrderSchema } from '../validations/sales-order.schema';
import { respondWithError } from '../utils/respondWithError';
import { requestsManualDiscount } from '../services/pricing';
import { grants, holdsEverything } from '../config/permissions';

export const createOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;

    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Validation error", errors: parsed.error.errors });
    }

    let locationId = parsed.data.locationId;
    if (!locationId) {
      const defaultLoc = await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
      if (!defaultLoc) {
        return res.status(400).json({ success: false, message: "locationId is required (no MAIN-STORE default configured for this tenant)" });
      }
      locationId = defaultLoc.id;
    }

    const order = await salesOrderService.createDraftOrder(clientId, locationId, parsed.data.customerId as string);
    res.status(201).json(order);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};

export const createFullOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;

    /*
     * Taking money off by hand needs its own permission -- checked BEFORE validation.
     *
     * Conditional, because an ordinary order must not require it: most orders arrive from a
     * website or a till with no manual discount on them at all, and gating the whole route
     * would stop every one of them.
     *
     * Before validation, deliberately. A cashier who is not allowed to do this should be told
     * that, not handed a validation message that teaches them the shape the field wants.
     */
    if (requestsManualDiscount(req.body)) {
      const user = (req as any).user;
      const allowed =
        holdsEverything(user?.permissions, user?.roles) ||
        grants(user?.permissions ?? [], 'offer:manual_discount');

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message:
            'You do not have permission to take money off at the till. ' +
            'Ask a manager to approve it.',
          requiredPermission: 'offer:manual_discount'
        });
      }
    }

    const parsed = createFullOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Validation error", errors: parsed.error.errors });
    }

    let locationId = parsed.data.locationId;

    const user = (req as any).user;
    const order = await salesOrderService.createFullOrder(clientId, locationId, parsed.data as any, parsed.data.channel ?? 'POS', {
      userId: user?.id ?? null,
      mayExceedManualLimit:
        holdsEverything(user?.permissions, user?.roles) ||
        grants(user?.permissions ?? [], 'offer:manual_discount_unlimited')
    });
    res.locals.auditAction = 'CREATED';
    res.locals.auditEntityId = order.id;
    res.status(201).json(order);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};

export const getOrders = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const filters = { status: text(req.query.status), search: text(req.query.search), source: text(req.query.source) };
    const orders = await salesOrderService.getOrders(clientId, filters);
    res.json(orders);
  } catch (error: any) {
    return respondWithError(res, error, { status: 500 });
  }
};

export const getOrderById = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const order = await salesOrderService.getOrderById(clientId, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    return respondWithError(res, error, { status: 404 });
  }
};

export const updateOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    /*
     * Money off a draft, typed straight into the order. The same walk-round the /full route had: a
     * salesperson makes a draft at the catalogue price and then edits the discount to anything, with
     * no reason and no till limit. Only a manager may set it this way; everyone else takes money off
     * by hand, with a reason, when the sale is made.
     */
    const user = (req as any).user;
    const mayOverride = holdsEverything(user?.permissions, user?.roles) || grants(user?.permissions ?? [], 'offer:manual_discount_unlimited');
    if (!mayOverride && req.body && Number(req.body.discountAmount ?? 0) > 0) {
      return res.status(403).json({
        success: false,
        message: 'Taking money off an order needs a reason: use a discount by hand, or ask a manager.',
        requiredPermission: 'offer:manual_discount_unlimited'
      });
    }
    const order = await salesOrderService.updateOrder(clientId, req.params.id as string, req.body);
    res.json(order);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};

export const deleteOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    await salesOrderService.deleteOrder(clientId, req.params.id as string);
    res.json({ success: true });
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};

export const addOrderItem = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { variantId, quantity } = req.body;
    const item = await salesOrderService.addOrderItem(clientId, req.params.id as string, variantId, quantity);
    res.status(201).json(item);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};

export const removeOrderItem = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    await salesOrderService.removeOrderItem(clientId, req.params.id as string, req.params.itemId as string);
    res.json({ success: true });
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};

export const confirmOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const order = await salesOrderService.confirmOrder(clientId, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};

export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const order = await salesOrderService.cancelOrder(clientId, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};
