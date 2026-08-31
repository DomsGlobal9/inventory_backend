import { Request, Response } from 'express';
import { salesOrderService } from '../services/sales-order.service';
import { prisma } from '../lib/prisma';

export const createOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    let locationId = req.body.locationId;
    if (!locationId) {
      const defaultLoc = await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
      locationId = defaultLoc?.id;
    }
    const order = await salesOrderService.createDraftOrder(clientId, locationId, req.body.customerId);
    res.status(201).json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const createFullOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    let locationId = req.body.locationId;
    if (!locationId) {
      const defaultLoc = await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
      locationId = defaultLoc?.id;
    }
    const order = await salesOrderService.createFullOrder(clientId, locationId, req.body);
    res.status(201).json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const getOrders = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const filters = { status: req.query.status };
    const orders = await salesOrderService.getOrders(clientId, filters);
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getOrderById = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const order = await salesOrderService.getOrderById(clientId, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
};

export const updateOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const order = await salesOrderService.updateOrder(clientId, req.params.id as string, req.body);
    res.json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const deleteOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    await salesOrderService.deleteOrder(clientId, req.params.id as string);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const addOrderItem = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { variantId, quantity } = req.body;
    const item = await salesOrderService.addOrderItem(clientId, req.params.id as string, variantId, quantity);
    res.status(201).json(item);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const removeOrderItem = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    await salesOrderService.removeOrderItem(clientId, req.params.id as string, req.params.itemId as string);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const confirmOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const order = await salesOrderService.confirmOrder(clientId, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const order = await salesOrderService.cancelOrder(clientId, req.params.id as string);
    res.json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
