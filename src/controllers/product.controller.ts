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

      // Where the try-on page should send the shopper when they press Back, and which screen
      // asked for this link. Both optional; both validated against an allow-list inside
      // scanUrlFor, so passing them straight through here is safe and a bad value simply
      // does not appear in the URL.
      const product = await productService.getProductById(req.params.id as string, clientId, {
        returnUrl: typeof req.query.returnUrl === 'string' ? req.query.returnUrl : null,
        source: typeof req.query.source === 'string' ? req.query.source : null
      });

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
      // Pass the specific rejection reason to the frontend, at the status it was raised with.
      //
      // This was a flat 400. The repository already distinguishes the two cases -- "you cannot
      // delete this yet" is a 400, "there is no such product" is a 404 -- and flattening them
      // meant a stale tab deleting something twice was told its request was malformed, and the
      // frontend could not tell "refresh, it is already gone" from "this is blocked for a reason".
      res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }
  }
}

export const productController = new ProductController();
