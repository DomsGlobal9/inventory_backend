import { Request, Response } from 'express';
import { customerService } from '../services/customer.service';
import { customerSchema, customerUpdateSchema } from '../validations/customer.schema';
import { respondWithError } from '../utils/respondWithError';
import { normalisePhone } from '../lib/phone';

/** The first reason a request was refused, as a sentence for the screen, with every issue kept. */
const invalid = (res: Response, errors: any[]) =>
  res.status(400).json({ success: false, message: errors[0]?.message || 'Validation error', errors });

/** A second customer on a number: who already has it, so the screen can offer to open them. */
const taken = (res: Response, error: any) =>
  res.status(409).json({
    success: false,
    message: error.message,
    existingCustomerId: error.existingCustomerId,
    existingCustomerName: error.existingCustomerName,
    existingCustomerCode: error.existingCustomerCode
  });

export const createCustomer = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;

    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.errors);

    const customer = await customerService.createCustomer(clientId, parsed.data);
    res.status(201).json({ success: true, data: customer });
  } catch (error: any) {
    if (error.existingCustomerId) return taken(res, error);
    // `message`, not `error` -- every other endpoint on this API answers with `message`, and the
    // frontend's error handler reads that. A duplicate came back with the reason in a key nobody
    // looked at, so the screen showed its generic "something went wrong" instead of the name of
    // the customer already on file.
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
};

/**
 * The customer with this number, for the counter. Answers 200 with null when nobody has it -- at a
 * till an unknown number is the normal start of a new customer, not an error to report.
 */
export const getCustomerByPhone = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const phone = normalisePhone(req.params.phone);
    if (!phone.ok) return res.status(400).json({ success: false, message: phone.reason });
    const customer = await customerService.findByPhone(clientId, phone.value);
    res.json({ success: true, data: customer, phone: phone.value });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500 });
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
    return respondWithError(res, error, { status: 500 });
  }
};

export const getCustomerById = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const customer = await customerService.getCustomerById(clientId, req.params.id as string);
    res.json(customer);
  } catch (error: any) {
    return respondWithError(res, error, { status: 404 });
  }
};

export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;

    const parsed = customerUpdateSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.errors);

    const customer = await customerService.updateCustomer(clientId, req.params.id as string, parsed.data as any);
    res.json({ success: true, data: customer });
  } catch (error: any) {
    if (error.existingCustomerId) return taken(res, error);
    return respondWithError(res, error, { status: 400 });
  }
};
