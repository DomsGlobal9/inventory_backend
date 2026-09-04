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

/**
 * Query strings are user input: "?days=abc" parses to NaN and "?days=-5" is nonsense. While
 * these numbers were being silently ignored that did not matter; now that they reach SQL and
 * Prisma's take, an unusable value has to be turned back into the default rather than passed on.
 */
function intParam(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

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
      const locationId = (req as any).locationId as string | undefined;
      const data = await valuationService.getCategoryValue(clientId, locationId);
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
      // Typically protected by strict admin-only middleware in production.
      // No hardcoded fallback: if ADMIN_SECRET isn't configured, this branch
      // can never be satisfied rather than silently accepting a known default.
      const adminSecret = req.headers['x-admin-secret'];
      if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
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
      const locationId = (req as any).locationId as string | undefined;
      const data = await reportService.getDashboardSummary(clientId, locationId);
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
      const locationId = (req as any).locationId as string | undefined;
      const data = await reportService.getLowStockValue(clientId, locationId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getMovementAging(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const locationId = (req as any).locationId as string | undefined;
      const data = await reportService.getMovementAging(clientId, locationId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getInventorySummary(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const locationId = (req as any).locationId as string | undefined;
      const data = await reportService.getInventorySummary(clientId, locationId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getDeadStock(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const days = intParam(req.query.days, 90, 1, 3650);
      const locationId = (req as any).locationId as string | undefined;
      const data = await reportService.getDeadStock(clientId, days, locationId);
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
      const days = intParam(req.query.days, 30, 1, 3650);
      const locationId = (req as any).locationId as string | undefined;
      const data = await reportService.getStockMovement(clientId, days, locationId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getRecentTransactions(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const limit = intParam(req.query.limit, 10, 1, 200);
      const locationId = (req as any).locationId as string | undefined;
      const data = await reportService.getRecentTransactions(clientId, limit, locationId);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getSnapshots(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = getClientId(req, res);
      if (!clientId) return;
      const days = intParam(req.query.days, 30, 1, 3650);
      const data = await reportService.getSnapshots(clientId, days);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
}

export const reportController = new ReportController();
