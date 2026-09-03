import { Request, Response, NextFunction } from 'express';
import { supplierService } from '../services/supplier.service';

/** Read the verified tenant ID set by tenantMiddleware — never trust the request body. */
function getClientId(req: Request, res: Response): string | null {
  const clientId = (req as any).clientId as string | undefined;
  if (!clientId) {
    res.status(401).json({ success: false, message: 'Unauthorized: tenant context missing' });
    return null;
  }
  return clientId;
}

export const getSuppliers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const data = await supplierService.getSuppliers(clientId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getSupplierById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const id = req.params.id as string;
    const data = await supplierService.getSupplierById(clientId, id);
    if (!data) return res.status(404).json({ success: false, message: 'Supplier not found' });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

import { supplierSchema } from '../validations/supplier.schema';

export const createSupplier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    
    const parsed = supplierSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Validation error", errors: parsed.error.errors });
    }

    const data = await supplierService.createSupplier(clientId, parsed.data as any);
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateSupplier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    
    const parsed = supplierSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Validation error", errors: parsed.error.errors });
    }

    const id = req.params.id as string;
    const data = await supplierService.updateSupplier(clientId, id, parsed.data as any);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const deleteSupplier = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = getClientId(req, res);
    if (!clientId) return;
    const id = req.params.id as string;
    await supplierService.deleteSupplier(clientId, id);
    res.json({ success: true, message: 'Supplier deleted successfully' });
  } catch (error: any) {
    // Surface business rule violations (has POs) as 400 instead of 500
    if (error.message?.includes('Cannot delete supplier')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};
