import { Request, Response, NextFunction } from 'express';
import { productService } from '../services/product.service';
import { createProductSchema, updateProductSchema, productQuerySchema } from '../validations/product.schema';

export class ProductController {
  
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const validatedData = createProductSchema.parse(req.body);
      const product = await productService.createProduct(clientId, validatedData);
      res.status(201).json({ success: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const queryParams = productQuerySchema.parse(req.query);
      
      const result = await productService.getProducts(clientId, queryParams);
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  async getOne(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const product = await productService.getProductById(req.params.id as string, clientId);
      res.status(200).json({ success: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const validatedData = updateProductSchema.parse(req.body);
      const product = await productService.updateProduct(req.params.id as string, clientId, validatedData);
      res.status(200).json({ success: true, data: product });
    } catch (error) {
      next(error);
    }
  }

  async archive(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      await productService.archiveProduct(req.params.id as string, clientId);
      res.status(200).json({ success: true, message: "Product archived successfully" });
    } catch (error) {
      next(error);
    }
  }

  async restore(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      await productService.restoreProduct(req.params.id as string, clientId);
      res.status(200).json({ success: true, message: "Product restored successfully" });
    } catch (error) {
      next(error);
    }
  }

  async trash(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      await productService.trashProduct(req.params.id as string, clientId);
      res.status(200).json({ success: true, message: "Product moved to trash successfully" });
    } catch (error) {
      next(error);
    }
  }

  async hardDelete(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      await productService.hardDeleteProduct(req.params.id as string, clientId);
      res.status(200).json({ success: true, message: "Product permanently deleted" });
    } catch (error: any) {
      // Pass the specific rejection reason to the frontend
      res.status(400).json({ success: false, message: error.message });
    }
  }
}

export const productController = new ProductController();
