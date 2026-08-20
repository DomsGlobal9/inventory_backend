import { Request, Response, NextFunction } from 'express';
import { inventoryService } from '../services/inventory.service';
import { valuationService } from '../services/valuation.service';
import { stockChangeSchema } from '../validations/inventory.schema';

export class InventoryController {
  
  async stockIn(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const { variantId, quantity, reason, referenceType, reference, unitCost, notes } = stockChangeSchema.parse(req.body);
      if (quantity <= 0) return res.status(400).json({ success: false, message: "Quantity must be positive" });
      const result = await inventoryService.stockIn(clientId, variantId, quantity, reason, referenceType, reference, unitCost, notes);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async stockOut(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const { variantId, quantity, reason, referenceType, reference, notes } = stockChangeSchema.parse(req.body);
      if (quantity <= 0) return res.status(400).json({ success: false, message: "Quantity must be positive" });
      const result = await inventoryService.stockOut(clientId, variantId, quantity, reason, referenceType, reference, notes);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async adjustment(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      // For adjustments, we allow negative quantity in the payload if needed, 
      // but stockChangeSchema enforces positive for simplicity. 
      // Let's parse manually or adjust schema if we wanted negative.
      // For this MVP, we assume the payload dictates the exact change.
      
      const { variantId, quantity, reason, referenceType, reference, notes } = req.body;
      if (!variantId || typeof quantity !== 'number') {
        return res.status(400).json({ success: false, message: "variantId and quantity (number) required" });
      }

      const result = await inventoryService.adjustment(clientId, variantId, quantity, reason, referenceType, reference, notes);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getTransactions(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const transactions = await inventoryService.getTransactions(clientId, req.query);
      res.status(200).json({ success: true, data: transactions });
    } catch (error) {
      next(error);
    }
  }

  async getVariants(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const variants = await inventoryService.getVariants(clientId, req.query);
      res.status(200).json({ success: true, data: variants });
    } catch (error) {
      next(error);
    }
  }

  async getMetadata(req: Request, res: Response, next: NextFunction) {
    try {
      const metadata = await inventoryService.getMetadata();
      res.status(200).json({ success: true, data: metadata });
    } catch (error) {
      next(error);
    }
  }

  async getAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const alerts = await inventoryService.getAlerts(clientId);
      res.status(200).json({ success: true, data: alerts });
    } catch (error) {
      next(error);
    }
  }

  async reconcileValuation(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const mode = req.query.mode === 'repair' ? 'repair' : 'report';
      const result = await valuationService.reconcileValuation(clientId, mode);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async transfer(req: Request, res: Response, next: NextFunction) {
    // Scaffolded for future multi-location support
    res.status(501).json({
      success: false,
      message: "Multi-location inventory transfers are not yet enabled."
    });
  }
}

export const inventoryController = new InventoryController();
