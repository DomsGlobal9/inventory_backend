import { Request, Response, NextFunction } from 'express';
import { searchService } from '../services/search.service';
import { z } from 'zod';

const searchQuerySchema = z.object({
  q: z.string().optional().default('')
});

export class SearchController {
  async search(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const { q } = searchQuerySchema.parse(req.query);
      
      const results = await searchService.performSearch(clientId, q);
      
      res.status(200).json({ success: true, data: results });
    } catch (error) {
      next(error);
    }
  }
}

export const searchController = new SearchController();
