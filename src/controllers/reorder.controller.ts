import { Request, Response, NextFunction } from 'express';
import { reorderService } from '../services/reorder.service';
import { createDraftOrdersSchema } from '../validations/reorder.schema';

const tenant = (req: Request) => (req as any).user?.clientId as string;

export const getReorderSuggestions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // The store selected at the top of the app, which tenantMiddleware has checked belongs to this shop.
    const data = await reorderService.getSuggestions(tenant(req), (req as any).locationId);
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

export const createReorderDrafts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { groups, locationId } = createDraftOrdersSchema.parse(req.body);
    const result = await reorderService.createDraftOrders(tenant(req), groups, locationId, (req as any).locationId);
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
};
