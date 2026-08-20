import { Request, Response } from 'express';
import { customerService } from '../services/customer.service';

const CLIENT_ID = 'demo-client'; // Hardcoded for single-tenant MVP

export const createCustomer = async (req: Request, res: Response) => {
  try {
    const customer = await customerService.createCustomer(CLIENT_ID, req.body);
    res.status(201).json(customer);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const getCustomers = async (req: Request, res: Response) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status
    };
    const customers = await customerService.getCustomers(CLIENT_ID, filters);
    res.json(customers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getCustomerById = async (req: Request, res: Response) => {
  try {
    const customer = await customerService.getCustomerById(CLIENT_ID, req.params.id as string);
    res.json(customer);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
};

export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const customer = await customerService.updateCustomer(CLIENT_ID, req.params.id as string, req.body);
    res.json(customer);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
