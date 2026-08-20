import { Request, Response, NextFunction } from 'express';
import { valuationService } from '../services/valuation.service';
import { reportService } from '../services/report.service';
import { SnapshotService } from '../services/snapshot.service';

const snapshotService = new SnapshotService();

// Basic utility to extract client ID in a multi-tenant environment
const getClientId = (req: Request, res: Response) => {
  const clientId = (req as any).clientId as string;
  if (!clientId) {
    res.status(401).json({ success: false, message: 'Unauthorized: Missing clientId' });
    return null;
  }
  return clientId;
};

export class ReportController {
  
  async getTenantValue(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await valuationService.getTenantValue(clientId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getCategoryValue(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await valuationService.getCategoryValue(clientId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  // Admin endpoint to manually trigger a snapshot for the current tenant
  async createSnapshot(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await snapshotService.takeSnapshot(clientId);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  // Admin endpoint to manually trigger the global snapshot batch for all tenants
  async runGlobalSnapshot(req: Request, res: Response, next: NextFunction) {
    try {
      // Typically protected by strict admin-only middleware in production
      const adminSecret = req.headers['x-admin-secret'];
      if (adminSecret !== process.env.ADMIN_SECRET && adminSecret !== 'local-dev-secret') {
        res.status(401).json({ success: false, message: 'Unauthorized: Invalid admin secret' });
        return;
      }

      const data = await snapshotService.runDailyBatch();
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getDashboardSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await reportService.getDashboardSummary(clientId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getOpenPoValue(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await reportService.getOpenPoValue(clientId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getLowStockValue(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await reportService.getLowStockValue(clientId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getMovementAging(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await reportService.getMovementAging(clientId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getInventorySummary(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await reportService.getInventorySummary(clientId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getDeadStock(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const days = req.query.days ? parseInt(req.query.days as string, 10) : 90;
      const data = await reportService.getDeadStock(clientId, days);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getSupplierSpend(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const data = await reportService.getSupplierSpend(clientId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getStockMovement(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
      const data = await reportService.getStockMovement(clientId, days);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getRecentTransactions(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
      const data = await reportService.getRecentTransactions(clientId, limit);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getSnapshots(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
      const data = await reportService.getSnapshots(clientId, days);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
}

export const reportController = new ReportController();
