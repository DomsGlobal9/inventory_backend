import { PrismaClient } from '@prisma/client';

export class InventoryEventService {
  /**
   * Creates an outbox event representing a stock change.
   * This should be called within the same Prisma transaction as the stock mutation.
   */
  static async createStockUpdatedEvent(
    tx: any, 
    clientId: string,
    variantId: string,
    locationId: string,
    previousQuantity: number | null,
    newQuantity: number
  ) {
    // Determine effective availability
    // 1. Is there physical stock?
    const hasPhysicalStock = newQuantity > 0;

    // 2. Is this location allowed to sell this variant?
    const profile = await tx.variantLocationProfile.findUnique({
      where: {
        variantId_locationId: {
          variantId,
          locationId
        }
      }
    });

    // Default to true if profile is missing (backward compatibility)
    const isProfileAvailable = profile ? profile.isAvailable : true;

    // Effective availability
    const available = hasPhysicalStock && isProfileAvailable;

    // Create the canonical stock.updated event
    await tx.inventoryEvent.create({
      data: {
        clientId,
        eventType: 'inventory.stock.updated',
        variantId,
        locationId,
        previousQuantity,
        quantity: newQuantity,
        available,
        status: 'PENDING'
      }
    });

    // Optional: Emit a specialized OUT_OF_STOCK event if it just crossed the boundary
    if (previousQuantity && previousQuantity > 0 && newQuantity <= 0) {
      await tx.inventoryEvent.create({
        data: {
          clientId,
          eventType: 'inventory.stock.out_of_stock',
          variantId,
          locationId,
          previousQuantity,
          quantity: newQuantity,
          available: false,
          status: 'PENDING'
        }
      });
    }
  }
}
