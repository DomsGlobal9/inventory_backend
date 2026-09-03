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

const VALID_LOCATION_TYPES: string[] = ['STORE', 'ONLINE', 'WAREHOUSE'];

export const createLocation = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { name, code, type, active } = req.body;

    if (!name || !code) {
      return res.status(400).json({ error: 'name and code are required' });
    }
    if (type !== undefined && !VALID_LOCATION_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_LOCATION_TYPES.join(', ')}` });
    }

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

    if (type !== undefined && !VALID_LOCATION_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_LOCATION_TYPES.join(', ')}` });
    }

    // updateMany + a scoped where clause is the safe way to enforce tenant
    // ownership on an update — `update({ where: { id } })` alone ignores clientId
    // entirely and would let a caller mutate another tenant's location by id.
    const result = await prisma.stockLocation.updateMany({
      where: { id, clientId },
      data: {
        name,
        code,
        type: type as LocationType,
        active
      }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const location = await prisma.stockLocation.findUnique({ where: { id } });
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
