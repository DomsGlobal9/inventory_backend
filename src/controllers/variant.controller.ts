import { Request, Response, NextFunction } from 'express';
import { variantService } from '../services/variant.service';
import {
  createVariantSchema,
  updateVariantSchema,
  bulkCreateVariantSchema,
  bulkUpdateVariantSchema
} from '../validations/variant.schema';
import { z } from 'zod';

const searchQuerySchema = z.object({
  q: z.string().optional().default(''),
  page: z.string().transform(Number).pipe(z.number().min(1)).optional().default('1'),
  limit: z.string().transform(Number).pipe(z.number().min(1).max(100)).optional().default('20'),
});

export class VariantController {
  
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const productId = req.params.productId as string;
      const validatedData = createVariantSchema.parse(req.body);
      const locationId = validatedData.locationId || (req as any).locationId;
      const variant = await variantService.createVariant(productId, clientId, validatedData, locationId);
      res.status(201).json({ success: true, data: variant });
    } catch (error) {
      next(error);
    }
  }

  async bulkCreate(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const productId = req.params.productId as string;
      const validatedData = bulkCreateVariantSchema.parse(req.body);
      const locationId = validatedData.locationId || (req as any).locationId;

      const result = await variantService.bulkCreateVariants(
        productId, clientId, validatedData.variants, locationId, validatedData.applyToAllLocations
      );
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async bulkUpdate(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const validatedData = bulkUpdateVariantSchema.parse(req.body);
      
      const result = await variantService.bulkUpdateVariants(clientId, validatedData.updates);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getByProduct(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const productId = req.params.productId as string;
      const variants = await variantService.getVariants(productId, clientId);
      res.status(200).json({ success: true, data: variants });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const validatedData = updateVariantSchema.parse(req.body);
      const variant = await variantService.updateVariant(req.params.id as string, clientId, validatedData);
      res.status(200).json({ success: true, data: variant });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      await variantService.deleteVariant(req.params.id as string, clientId);
      res.status(200).json({ success: true, message: "Variant deleted successfully" });
    } catch (error: any) {
      // If our own validation blocked it, return descriptive 400
      if (error.message?.startsWith('Cannot delete variant:')) {
        return res.status(400).json({ success: false, message: error.message });
      }
      next(error);
    }
  }

  async search(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const { q, page, limit } = searchQuerySchema.parse(req.query);
      
      const results = await variantService.searchVariants(clientId, { q, page, limit });
      res.status(200).json({ success: true, data: results });
    } catch (error) {
      next(error);
    }
  }
}

export const variantController = new VariantController();
