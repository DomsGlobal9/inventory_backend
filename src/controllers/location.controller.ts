import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { LocationType } from '@prisma/client';
import { respondWithError } from '../utils/respondWithError';

export const getLocations = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const locations = await prisma.stockLocation.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' }
    });
    res.json(locations);
  } catch (error: any) {
    return respondWithError(res, error, { status: 500 });
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
    return respondWithError(res, error, { status: 400 });
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
    return respondWithError(res, error, { status: 400 });
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

    // Refuse while stock is still sitting there, and say how much and what to do about it.
    //
    // "Cannot delete location with active stock." is true but leaves the person nowhere: they
    // cannot tell whether it is one forgotten piece or the whole shop, and nothing suggests
    // the way out. Both facts are one query away.
    const stockRows = await prisma.inventoryStock.aggregate({
      where: { locationId: id, quantity: { gt: 0 } },
      _sum: { quantity: true },
      _count: { _all: true }
    });

    const units = stockRows._sum.quantity ?? 0;
    if (units > 0) {
      const lines = stockRows._count._all;
      return res.status(400).json({
        error:
          `"${location.name}" still holds ${units} ${units === 1 ? 'piece' : 'pieces'} ` +
          `across ${lines} ${lines === 1 ? 'item' : 'items'}. Move that stock to another ` +
          `location first, or count it out, and then this can be deleted.`
      });
    }    await prisma.stockLocation.delete({
      where: { id }
    });
    
    res.json({ success: true });
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};
