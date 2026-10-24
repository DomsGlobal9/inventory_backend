import { Request, Response } from 'express';
import { dispatchService } from '../services/dispatch.service';
import { shippingFor } from '../services/shipping';
import { respondWithError } from '../utils/respondWithError';

export const createDispatch = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { salesOrderId, items, courier } = req.body;
    // Optional: who is carrying it. Checked first, so a wrong courier or number sends nothing out.
    const shipping = await shippingFor(clientId, courier);
    const dispatch = await dispatchService.createDispatch(clientId, salesOrderId, items, shipping);
    res.status(201).json(dispatch);
  } catch (error: any) {
    return respondWithError(res, error, { status: 400 });
  }
};
