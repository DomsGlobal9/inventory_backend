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

/**
 * A store's delivery address and phone, as printed on purchase orders. Both optional; blank clears.
 * Returns an error message, or the cleaned values. `undefined` means "not sent", so an update that
 * only switches a store off leaves its address alone.
 */
function contactFields(body: any): { error: string } | { address?: string | null; phone?: string | null } {
  const out: { address?: string | null; phone?: string | null } = {};
  if (body.address !== undefined) {
    if (body.address !== null && typeof body.address !== 'string') return { error: 'The address must be text.' };
    const address = (body.address ?? '').trim();
    if (address.length > 300) return { error: 'Keep the address under 300 characters.' };
    out.address = address || null;
  }
  if (body.phone !== undefined) {
    if (body.phone !== null && typeof body.phone !== 'string') return { error: 'The phone number must be text.' };
    const phone = (body.phone ?? '').trim();
    if (phone.length > 20) return { error: 'That phone number is too long.' };
    if (!/^[0-9+()\-\s]*$/.test(phone)) return { error: 'Use digits, spaces, + and - only for the phone number.' };
    out.phone = phone || null;
  }
  return out;
}

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
    const contact = contactFields(req.body);
    if ('error' in contact) return res.status(400).json({ error: contact.error });

    const location = await prisma.stockLocation.create({
      data: {
        clientId,
        name,
        code,
        type: type as LocationType || 'STORE',
        active: active ?? true,
        ...contact
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
    const contact = contactFields(req.body);
    if ('error' in contact) return res.status(400).json({ error: contact.error });

    /*
     * Switching a store off hides it from selling, receiving and reordering. Deleting one that still
     * held stock or had orders coming was already refused; switching it off was not, and stranded
     * both -- stock nobody could sell or move, and deliveries addressed to a store that no longer
     * shows anywhere. Same rule as delete.
     */
    if (active === false) {
      const [held, incoming] = await Promise.all([
        prisma.inventoryStock.aggregate({ where: { clientId, locationId: id }, _sum: { quantity: true } }),
        prisma.purchaseOrder.count({ where: { clientId, locationId: id, status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] } } })
      ]);
      const pieces = held._sum.quantity ?? 0;
      if (pieces > 0 || incoming > 0) {
        return res.status(409).json({
          error: `This store still has ${pieces > 0 ? `${pieces} pieces in stock` : ''}${pieces > 0 && incoming > 0 ? ' and ' : ''}${incoming > 0 ? `${incoming} open purchase order${incoming === 1 ? '' : 's'}` : ''}. Move the stock and finish or move the orders before switching it off.`
        });
      }
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
        active,
        ...contact
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
    }

    // Orders still on their way here would lose the only record of where they are going, and the
    // supplier has been told this address. Finished orders do not stop it: the link is cleared.
    const incoming = await prisma.purchaseOrder.findMany({
      where: { clientId, locationId: id, status: { in: ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'] } },
      select: { poNumber: true },
      orderBy: { createdAt: 'asc' },
      take: 4
    });
    if (incoming.length > 0) {
      const named = incoming.slice(0, 3).map(p => p.poNumber).join(', ') + (incoming.length > 3 ? ' and more' : '');
      return res.status(400).json({
        error:
          `"${location.name}" still has purchase orders on their way to it (${named}). ` +
          `Change where those orders are delivered, or cancel them, and then this can be deleted.`
      });
    }

    await prisma.stockLocation.delete({
      where: { id }
    });

    res.json({ success: true });
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};
