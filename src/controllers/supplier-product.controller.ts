import { Request, Response, NextFunction } from 'express';
import { supplierProductService } from '../services/supplier-product.service';
import { linkSupplierProductSchema, listBySupplierSchema } from '../validations/supplier-product.schema';

const tenant = (req: Request) => (req as any).user?.clientId as string;
const actor = (req: Request) => (req as any).user?.id as string | undefined;

export const linkProduct = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = linkSupplierProductSchema.parse(req.body);
    const link = await supplierProductService.link(tenant(req), data as any, actor(req));
    res.status(201).json({ success: true, data: link });
  } catch (error) { next(error); }
};

export const unlinkProduct = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await supplierProductService.unlink(tenant(req), String(req.params.id));
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

export const listSupplierProducts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search } = listBySupplierSchema.parse(req.query);
    const items = await supplierProductService.listBySupplier(tenant(req), String(req.params.supplierId), search);
    res.json({ success: true, data: items });
  } catch (error) { next(error); }
};

export const listVariantSuppliers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await supplierProductService.listByVariant(tenant(req), String(req.params.variantId));
    res.json({ success: true, data: items });
  } catch (error) { next(error); }
};

export const setPreferredSupplier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const link = await supplierProductService.setPreferred(tenant(req), String(req.params.id), actor(req));
    res.json({ success: true, data: link });
  } catch (error) { next(error); }
};
