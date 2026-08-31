import { Request, Response } from 'express';
import { inventoryTransferService } from '../services/inventory-transfer.service';

export const transferStock = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { originLocationId, destinationLocationId, items, notes } = req.body;
    const createdBy = (req as any).user?.id || 'SYSTEM';

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
    res.status(400).json({ error: error.message });
  }
};
