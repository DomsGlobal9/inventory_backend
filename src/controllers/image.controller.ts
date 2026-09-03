import { Request, Response, NextFunction } from 'express';
import { imageService } from '../services/image.service';
import { createImageSchema, updateImageSchema } from '../validations/image.schema';

export class ImageController {
  
  /**
   * Hands the browser a signed, path-scoped upload URL. The tenant comes from the
   * authenticated session -- the request body is not consulted for it, which is the whole
   * point: the client can no longer choose which tenant folder it writes into.
   */
  async createUploadUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const productId = req.params.productId as string;
      const { fileName } = req.body || {};
      if (!fileName || typeof fileName !== 'string') {
        return res.status(400).json({ success: false, message: 'fileName is required' });
      }
      const result = await imageService.createUploadUrl(productId, clientId, fileName);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const productId = req.params.productId as string;
      const validatedData = createImageSchema.parse(req.body);
      const image = await imageService.addImage(productId, clientId, validatedData);
      res.status(201).json({ success: true, data: image });
    } catch (error) {
      next(error);
    }
  }

  async getByProduct(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const productId = req.params.productId as string;
      const images = await imageService.getImages(productId, clientId);
      res.status(200).json({ success: true, data: images });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const imageId = req.params.id as string;
      const validatedData = updateImageSchema.parse(req.body);
      const image = await imageService.updateImage(imageId, clientId, validatedData);
      res.status(200).json({ success: true, data: image });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      await imageService.deleteImage(req.params.id as string, clientId);
      res.status(200).json({ success: true, message: "Image deleted successfully" });
    } catch (error) {
      next(error);
    }
  }
}

export const imageController = new ImageController();
