import { Request, Response, NextFunction } from 'express';
import { stockCountService } from '../services/stock-count.service';
import { stockCountCreateSchema, stockCountUpdateItemSchema } from '../validations/stock-count.schema';

export class StockCountController {
  
  async getCounts(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const counts = await stockCountService.getCounts(clientId);
      res.status(200).json({ success: true, data: counts });
    } catch (error) {
      next(error);
    }
  }

  async getCountById(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const id = req.params.id as string;
      const count = await stockCountService.getCountById(clientId, id);
      res.status(200).json({ success: true, data: count });
    } catch (error) {
      next(error);
    }
  }

  async createCount(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;

      const body = { ...req.body, locationId: req.body.locationId || (req as any).locationId };
      const parsed = stockCountCreateSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, message: "Validation error", errors: parsed.error.errors });
      }

      const { name, locationId, categoryId, createdBy } = parsed.data;

      const count = await stockCountService.createCount(clientId, name, locationId, categoryId as string, createdBy as string);
      res.status(201).json({ success: true, data: count });
    } catch (error) {
      next(error);
    }
  }

  async startCount(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const id = req.params.id as string;
      
      const result = await stockCountService.startCount(clientId, id);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async updateItemCount(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const id = req.params.id as string;
      const itemId = req.params.itemId as string;
      
      const parsed = stockCountUpdateItemSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, message: "Validation error", errors: parsed.error.errors });
      }

      const result = await stockCountService.updateItemCount(clientId, id, itemId, parsed.data.countedQty);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async completeCount(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const id = req.params.id as string;
      const { completedBy } = req.body;

      const result = await stockCountService.completeCount(clientId, id, completedBy);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const stockCountController = new StockCountController();
