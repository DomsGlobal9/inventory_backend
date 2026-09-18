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
    // safeParse, so the person reads the sentence that went wrong rather than "Validation failed".
    const parsed = createDraftOrdersSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Check the quantities and try again.', errors: parsed.error.errors });
    }
    const { groups, locationId } = parsed.data;
    const result = await reorderService.createDraftOrders(tenant(req), groups, locationId, (req as any).locationId);
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
};
