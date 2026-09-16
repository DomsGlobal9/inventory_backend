import { transactionRepository } from '../repositories/transaction.repository';
import { TransactionType, InventoryReason } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { inventoryMutationService } from './inventory-mutation.service';
import { notFound } from '../utils/httpError';

export class TransactionService {

  /**
   * A stock movement recorded by hand (Record Stock Movement on a product page).
   *
   * It used to go through an older path of its own that bypassed everything the rest of the app
   * relies on: it always wrote to the store coded MAIN-STORE whatever store was selected, took no
   * lock (a sale landing between its read and its write was lost), never updated the stock's value,
   * and stored a stock-out as a positive number -- which the day book reads as stock coming IN.
   * Now it is one movement like every other: the selected store, the variant lock, the valuation,
   * and a signed quantity.
   */
  async addTransaction(clientId: string, data: any, context: { locationId?: string | null; userId?: string | null } = {}) {
    const store = context.locationId
      ? await prisma.stockLocation.findFirst({ where: { id: context.locationId, clientId }, select: { id: true } })
      : await prisma.stockLocation.findFirst({ where: { clientId, active: true }, orderBy: [{ code: 'asc' }], select: { id: true } })
        .then(async first => (await prisma.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' }, select: { id: true } })) ?? first);
    if (!store) throw notFound('Choose the store this movement is for.');

    const size = Math.abs(Number(data.quantity));
    const quantityDelta = data.type === 'OUT' ? -size : data.type === 'IN' ? size : Number(data.quantity);

    return prisma.$transaction(tx => inventoryMutationService.applyMovement({
      clientId,
      variantId: data.variantId,
      locationId: store.id,
      movementType: data.type,
      reason: data.reason,
      quantityDelta,
      notes: data.notes,
      referenceType: data.referenceType ?? 'MANUAL',
      referenceId: data.referenceId,
      createdBy: context.userId ?? undefined,
      tx
    }), { timeout: 30000 });
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
