import { Request, Response, NextFunction } from 'express';
import { dashboardService } from '../services/dashboard.service';

export class DashboardController {
  
  async getSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const locationId = (req as any).locationId as string | undefined;
      const summary = await dashboardService.getSummary(clientId, locationId);
      res.status(200).json({ success: true, data: summary });
    } catch (error) {
      next(error);
    }
  }
}

export const dashboardController = new DashboardController();
