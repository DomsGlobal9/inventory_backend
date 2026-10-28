import { Request, Response } from 'express';
import { dispatchService } from '../services/dispatch.service';
import { isOn as onLogistics } from '../services/logistics/parcels';
import { respondWithError } from '../utils/respondWithError';

export const createDispatch = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { salesOrderId, items } = req.body;
    /*
     * A shop on ScaleEzy Logistics sends orders out by packing them (Shelves -> Pick: box, weight,
     * Packed), which is what tells Logistics to book the courier. Sending one out here would leave a
     * parcel nobody books -- refused, saying where to go instead. (28 Oct 2026. Couriers are no longer
     * chosen in Inventory at all, so a `courier` in the body is ignored.)
     */
    if (await onLogistics(clientId)) {
      return res.status(409).json({ success: false, message: 'This shop ships with ScaleEzy Logistics. Pick and pack the order (Shelves → Pick) so Logistics books the courier.' });
    }
    const dispatch = await dispatchService.createDispatch(clientId, salesOrderId, items, null);
    res.status(201).json(dispatch);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};
