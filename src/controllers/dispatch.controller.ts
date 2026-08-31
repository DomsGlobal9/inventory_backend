import { Request, Response } from 'express';
import { dispatchService } from '../services/dispatch.service';

export const createDispatch = async (req: Request, res: Response) => {
  try {
    const clientId = (req as any).clientId as string;
    const { salesOrderId, items } = req.body;
    const dispatch = await dispatchService.createDispatch(clientId, salesOrderId, items);
    res.status(201).json(dispatch);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
