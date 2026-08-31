import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { LocationType } from '@prisma/client';

export const getLocations = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const locations = await prisma.stockLocation.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' }
    });
    res.json(locations);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createLocation = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { name, code, type, active } = req.body;
    
    const location = await prisma.stockLocation.create({
      data: {
        clientId,
        name,
        code,
        type: type as LocationType || 'STORE',
        active: active ?? true
      }
    });
    res.status(201).json(location);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const updateLocation = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const id = req.params.id as string;
    const { name, code, type, active } = req.body;
    
    const location = await prisma.stockLocation.update({
      where: { id },
      data: {
        name,
        code,
        type: type as LocationType,
        active
      }
    });
    res.json(location);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const deleteLocation = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const id = req.params.id as string;
    
    const location = await prisma.stockLocation.findFirst({ where: { id, clientId } });
    if (!location) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // Prevent deletion if there's stock
    const stockCount = await prisma.inventoryStock.count({
      where: { locationId: id, quantity: { gt: 0 } }
    });
    
    if (stockCount > 0) {
      return res.status(400).json({ error: 'Cannot delete location with active stock.' });
    }
    
    await prisma.stockLocation.delete({
      where: { id }
    });
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
