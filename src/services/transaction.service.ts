import { transactionRepository } from '../repositories/transaction.repository';
import { TransactionType, InventoryReason } from '@prisma/client';

export class TransactionService {
  
  async addTransaction(clientId: string, data: any) {
    return transactionRepository.createTransaction(clientId, data);
  }

  async getTransactions(clientId: string, query: any) {
    const filters = {
      productId: query.productId,
      variantId: query.variantId,
      type: query.type as TransactionType,
      reason: query.reason as InventoryReason,
      from: query.from,
      to: query.to,
      page: parseInt(query.page) || 1,
      limit: parseInt(query.limit) || 50
    };
    
    return transactionRepository.getTransactions(clientId, filters);
  }
}

export const transactionService = new TransactionService();
