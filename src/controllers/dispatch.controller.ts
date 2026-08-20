import { Request, Response } from 'express';
import { dispatchService } from '../services/dispatch.service';

const CLIENT_ID = 'demo-client';

export const createDispatch = async (req: Request, res: Response) => {
  try {
    const { salesOrderId, items } = req.body;
    const dispatch = await dispatchService.createDispatch(CLIENT_ID, salesOrderId, items);
    res.status(201).json(dispatch);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
