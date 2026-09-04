import { Request, Response, NextFunction } from 'express';
import { reorderService } from '../services/reorder.service';
import { createDraftOrdersSchema } from '../validations/reorder.schema';

const tenant = (req: Request) => (req as any).user?.clientId as string;

export const getReorderSuggestions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await reorderService.getSuggestions(tenant(req));
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

export const createReorderDrafts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { groups } = createDraftOrdersSchema.parse(req.body);
    const result = await reorderService.createDraftOrders(tenant(req), groups);
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
};
