import { Request, Response, NextFunction } from 'express';
import { stockCountService } from '../services/stock-count.service';

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
      const { name, categoryId, createdBy } = req.body;
      
      if (!name) {
        return res.status(400).json({ success: false, message: "Name is required" });
      }

      const count = await stockCountService.createCount(clientId, name, categoryId, createdBy);
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
      const { countedQty } = req.body;

      if (typeof countedQty !== 'number') {
        return res.status(400).json({ success: false, message: "countedQty (number) is required" });
      }

      const result = await stockCountService.updateItemCount(clientId, id, itemId, countedQty);
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
