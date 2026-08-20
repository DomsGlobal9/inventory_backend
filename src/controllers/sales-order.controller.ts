import { Request, Response } from 'express';
import { salesOrderService } from '../services/sales-order.service';

const CLIENT_ID = 'demo-client';

export const createOrder = async (req: Request, res: Response) => {
  try {
    const order = await salesOrderService.createDraftOrder(CLIENT_ID, req.body.customerId);
    res.status(201).json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const createFullOrder = async (req: Request, res: Response) => {
  try {
    const order = await salesOrderService.createFullOrder(CLIENT_ID, req.body);
    res.status(201).json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const getOrders = async (req: Request, res: Response) => {
  try {
    const filters = { status: req.query.status };
    const orders = await salesOrderService.getOrders(CLIENT_ID, filters);
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getOrderById = async (req: Request, res: Response) => {
  try {
    const order = await salesOrderService.getOrderById(CLIENT_ID, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
};

export const updateOrder = async (req: Request, res: Response) => {
  try {
    const order = await salesOrderService.updateOrder(CLIENT_ID, req.params.id as string, req.body);
    res.json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const deleteOrder = async (req: Request, res: Response) => {
  try {
    await salesOrderService.deleteOrder(CLIENT_ID, req.params.id as string);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const addOrderItem = async (req: Request, res: Response) => {
  try {
    const { variantId, quantity } = req.body;
    const item = await salesOrderService.addOrderItem(CLIENT_ID, req.params.id as string, variantId, quantity);
    res.status(201).json(item);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const removeOrderItem = async (req: Request, res: Response) => {
  try {
    await salesOrderService.removeOrderItem(CLIENT_ID, req.params.id as string, req.params.itemId as string);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const confirmOrder = async (req: Request, res: Response) => {
  try {
    const order = await salesOrderService.confirmOrder(CLIENT_ID, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const order = await salesOrderService.cancelOrder(CLIENT_ID, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
