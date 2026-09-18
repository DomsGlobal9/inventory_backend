import { Request, Response, NextFunction } from 'express';
import { stockCountService } from '../services/stock-count.service';
import { stockCountCreateSchema, stockCountUpdateItemSchema } from '../validations/stock-count.schema';
import { holdsEverything } from '../config/permissions';

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
        return res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Validation error', errors: parsed.error.errors });
      }

      const { name, locationId, categoryId } = parsed.data;
      // From the login. Taken from the request, anyone could write anyone's name on an audit.
      const createdBy = (req as any).user?.name || (req as any).user?.email || (req as any).user?.id;

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
        return res.status(400).json({ success: false, message: parsed.error.errors[0]?.message || 'Validation error', errors: parsed.error.errors });
      }

      const result = await stockCountService.updateItemCount(clientId, id, itemId, parsed.data.countedQty);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Only the shop's super admin -- the account owner, who holds everything -- may call a count
   * off. Deliberately not a permission from the catalogue: an ADMIN or manager who could cancel
   * could quietly abandon a count whose numbers they did not like, and a count is how an owner
   * checks the people who look after the stock.
   */
  async cancelCount(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!holdsEverything(user?.permissions, user?.roles)) {
        return res.status(403).json({ success: false, message: 'Only the shop’s super admin can cancel a stock count. Ask them to cancel it, or finish the count.' });
      }
      const clientId = (req as any).clientId as string;
      const cancelledBy = user?.name || user?.email || user?.id;
      const result = await stockCountService.cancelCount(clientId, req.params.id as string, cancelledBy);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async completeCount(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const id = req.params.id as string;
      const completedBy = (req as any).user?.name || (req as any).user?.email || (req as any).user?.id;

      const result = await stockCountService.completeCount(clientId, id, completedBy);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const stockCountController = new StockCountController();
