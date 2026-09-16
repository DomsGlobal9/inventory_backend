import { Request, Response, NextFunction } from 'express';
import { transactionService } from '../services/transaction.service';
import { createTransactionSchema, getTransactionsSchema } from '../validations/transaction.schema';

export class TransactionController {

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const validatedData = createTransactionSchema.parse(req.body);
      const transaction = await transactionService.addTransaction(clientId, validatedData, {
        locationId: (req as any).locationId ?? null,
        userId: (req as any).user?.id ?? null
      });
      res.status(201).json({ success: true, data: transaction });
    } catch (error) {
      next(error);
    }
  }

  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const query = getTransactionsSchema.parse(req.query);
      const data = await transactionService.getTransactions(clientId, query);
      res.status(200).json({ success: true, ...data });
    } catch (error) {
      next(error);
    }
  }
}

export const transactionController = new TransactionController();
