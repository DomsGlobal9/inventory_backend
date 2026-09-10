import { Request, Response } from 'express';
import { customerService } from '../services/customer.service';
import { customerSchema } from '../validations/customer.schema';

export const createCustomer = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Validation error", errors: parsed.error.errors });
    }
    
    const customer = await customerService.createCustomer(clientId, parsed.data);
    res.status(201).json({ success: true, data: customer });
  } catch (error: any) {
    // `message`, not `error` -- every other endpoint on this API answers with `message`, and the
    // frontend's error handler reads that. A duplicate came back with the reason in a key nobody
    // looked at, so the screen showed its generic "something went wrong" instead of the name of
    // the customer already on file.
    res.status(error.statusCode || 400).json({
      success: false,
      message: error.message,
      ...(error.existingCustomerId ? { existingCustomerId: error.existingCustomerId } : {})
    });
  }
};

export const getCustomers = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const filters = {
      search: req.query.search,
      status: req.query.status
    };
    const customers = await customerService.getCustomers(clientId, filters);
    res.json(customers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getCustomerById = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const customer = await customerService.getCustomerById(clientId, req.params.id as string);
    res.json(customer);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
};

export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    
    const parsed = customerSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Validation error", errors: parsed.error.errors });
    }
    
    const customer = await customerService.updateCustomer(clientId, req.params.id as string, parsed.data as any);
    res.json({ success: true, data: customer });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
};
