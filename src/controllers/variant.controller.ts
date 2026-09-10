import { Request, Response, NextFunction } from 'express';
import { variantService } from '../services/variant.service';
import {
  createVariantSchema,
  updateVariantSchema,
  bulkCreateVariantSchema,
  bulkUpdateVariantSchema
} from '../validations/variant.schema';
import { z } from 'zod';
import { grants } from '../config/permissions';
import { respondWithError } from '../utils/respondWithError';

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
        productId, clientId, validatedData.variants, locationId,
        validatedData.applyToAllLocations, validatedData.supplierId
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

      // The route is gated on inventory:adjust, which is authority over QUANTITIES. This
      // endpoint also accepts prices and costs, and those are somebody else's authority:
      // /inventory/set-cost refuses cost:manage to exactly the role that could get here.
      //
      // Proven, not theorised: a user holding inventory:adjust and nothing else was refused
      // 403 by set-cost and then rewrote the same variant's cost and selling price through
      // this endpoint, 200, updated 1. A CSV import was a way round the permission.
      //
      // Refused whole rather than filtered quietly. An import that silently drops half the
      // columns leaves the merchant believing a file was applied that was not.
      const held: string[] = (req as any).user?.permissions || [];
      const rows = validatedData.updates;

      const touchesPrice = rows.some(u => u.sellingPrice !== undefined || u.priceOverride !== undefined);
      const touchesCost = rows.some(u => u.costPrice !== undefined);

      if (touchesPrice && !grants(held, 'product:update')) {
        return res.status(403).json({
          success: false,
          message: 'This file changes selling prices. You do not have permission to change product details and selling prices. Ask whoever manages your team.',
          requiredPermission: 'product:update'
        });
      }

      if (touchesCost && !grants(held, 'cost:manage')) {
        return res.status(403).json({
          success: false,
          message: 'This file changes what stock cost. You do not have permission to set and restate what stock cost. Ask whoever manages your team.',
          requiredPermission: 'cost:manage'
        });
      }
      
      // A CSV row gives one quantity, so it has to land somewhere. What the caller chose in
      // the import dialog wins; the header's location is the fallback for API clients that
      // did not say. The service verifies whichever it gets belongs to this tenant.
      const locationId = validatedData.locationId || ((req as any).locationId as string | undefined);
      const result = await variantService.bulkUpdateVariants(clientId, validatedData.updates, locationId);
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
        return respondWithError(res, error, { status: 400 });
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
