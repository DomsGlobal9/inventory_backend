import { prisma } from '../lib/prisma';
import { inventoryMutationService } from './inventory-mutation.service';
import { TransactionType, InventoryReason } from '@prisma/client';

export class InventoryTransferService {
  
  /**
   * Transfers stock immediately from origin to destination location.
   */
  async transferStock(
    clientId: string,
    originLocationId: string,
    destinationLocationId: string,
    items: { variantId: string; quantity: number }[],
    notes?: string,
    createdBy?: string
  ) {
    if (originLocationId === destinationLocationId) {
      throw new Error("Origin and destination locations must be different");
    }

    for (const item of items) {
      if (item.quantity <= 0) {
        throw new Error(`Transfer quantity for variant ${item.variantId} must be greater than 0`);
      }

      // Deduct from origin
      await inventoryMutationService.applyMovement({
        clientId,
        locationId: originLocationId,
        variantId: item.variantId,
        movementType: 'OUT',
        reason: 'TRANSFER' as InventoryReason,
        quantityDelta: -item.quantity,
        notes: notes ? `Transfer OUT to ${destinationLocationId}: ${notes}` : `Transfer OUT to ${destinationLocationId}`,
        referenceType: 'TRANSFER',
        createdBy
      });

      // Add to destination
      await inventoryMutationService.applyMovement({
        clientId,
        locationId: destinationLocationId,
        variantId: item.variantId,
        movementType: 'IN',
        reason: 'TRANSFER' as InventoryReason,
        quantityDelta: item.quantity,
        notes: notes ? `Transfer IN from ${originLocationId}: ${notes}` : `Transfer IN from ${originLocationId}`,
        referenceType: 'TRANSFER',
        createdBy
      });
    }

    return { success: true, transferredItems: items.length };
  }
}

export const inventoryTransferService = new InventoryTransferService();
