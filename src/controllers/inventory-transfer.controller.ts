import { Request, Response } from 'express';
import { inventoryTransferService } from '../services/inventory-transfer.service';
import { respondWithError } from '../utils/respondWithError';

export const transferStock = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { originLocationId, destinationLocationId, items, notes } = req.body ?? {};
    const createdBy = (req as any).user?.id || 'SYSTEM';

    // Refused here with a sentence, rather than failing somewhere inside with a server error.
    if (!originLocationId || !destinationLocationId) {
      return res.status(400).json({ success: false, message: 'Choose the store the stock leaves and the store it goes to.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Add at least one item to move.' });
    }
    if (items.some((i: any) => !i || typeof i.variantId !== 'string' || !Number.isInteger(i.quantity) || i.quantity <= 0)) {
      return res.status(400).json({ success: false, message: 'Move whole pieces, at least one of each item.' });
    }
    if (new Set(items.map((i: any) => i.variantId)).size !== items.length) {
      return res.status(400).json({ success: false, message: 'The same item is listed twice. Change its quantity instead.' });
    }

    const result = await inventoryTransferService.transferStock(
      clientId,
      originLocationId,
      destinationLocationId,
      items,
      notes,
      createdBy
    );

    res.status(200).json(result);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};
