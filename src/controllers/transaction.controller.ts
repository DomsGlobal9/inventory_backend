import { Request, Response, NextFunction } from 'express';
import { transactionService } from '../services/transaction.service';
import { createTransactionSchema, getTransactionsSchema } from '../validations/transaction.schema';

export class TransactionController {

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clientId = (req as any).clientId as string;
      const validatedData = createTransactionSchema.parse(req.body);
      // A sale takes its pieces off by itself; a hand-made SALE would count in the day book as a
      // sale no order made. Taking stock off by hand says why: damaged, a sample, or back to the
      // supplier. (inventory.controller's stock-out refuses the same.)
      // SALE is refused for every type, not only OUT: an ADJUSTMENT marked SALE lands in the same
      // day-book figure.
      if (validatedData.reason === 'SALE' || (validatedData.type === 'OUT' && !['DAMAGE', 'SAMPLE', 'RETURN_TO_VENDOR'].includes(validatedData.reason))) {
        return res.status(400).json({ success: false, message: validatedData.reason === 'SALE'
          ? 'Sales take stock off by themselves when the sale is made or the order is sent. To take pieces off by hand, choose damaged, a sample, or returned to the supplier.'
          : 'Choose why these pieces are going out: damaged, a sample, or returned to the supplier.' });
      }
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
