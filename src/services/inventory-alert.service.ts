import { InventoryAlertType, InventoryAlertSeverity } from '@prisma/client';

export class InventoryAlertService {
  /**
   * Evaluates if a stock change should trigger or resolve an alert.
   * This should be called within the same Prisma transaction as the stock mutation.
   */
  static async evaluateStockAlert(
    tx: any,
    clientId: string,
    variantId: string,
    locationId: string,
    currentQuantity: number,
    reorderLevel: number
  ) {
    // Determine target alert state based on V1 location rules
    let targetType: InventoryAlertType | null = null;
    let targetSeverity: InventoryAlertSeverity | null = null;
    let title = '';
    let message = '';

    if (currentQuantity <= 0) {
      targetType = 'OUT_OF_STOCK';
      targetSeverity = 'CRITICAL';
      title = 'Out of Stock';
      message = 'This variant is out of stock at this location.';
    } else if (currentQuantity <= reorderLevel) {
      targetType = 'LOW_STOCK';
      targetSeverity = 'WARNING';
      title = 'Low Stock';
      message = `Stock is low (${currentQuantity} remaining). Reorder level is ${reorderLevel}.`;
    }

    // Find any existing unresolved operational alert for this variant/location
    const existingAlert = await tx.inventoryAlert.findFirst({
      where: {
        clientId,
        variantId,
        locationId,
        isResolved: false
      }
    });

    // Case 1: Stock is now NORMAL
    if (!targetType) {
      if (existingAlert) {
        // Resolve the existing alert
        await tx.inventoryAlert.update({
          where: { id: existingAlert.id },
          data: {
            isResolved: true,
            currentQuantity // snapshot final healthy quantity
          }
        });
      }
      return;
    }

    // Case 2: Stock is LOW or OUT, and we ALREADY have an active alert
    if (existingAlert) {
      // If the condition changed (e.g., LOW_STOCK -> OUT_OF_STOCK), update it
      // Or if just the quantity changed, update the quantity snapshot
      if (existingAlert.type !== targetType || existingAlert.currentQuantity !== currentQuantity) {
        await tx.inventoryAlert.update({
          where: { id: existingAlert.id },
          data: {
            type: targetType,
            severity: targetSeverity,
            title,
            message,
            currentQuantity,
            threshold: reorderLevel,
            isRead: false // Mark unread again so the user sees the worsening condition
          }
        });
      }
      return; // Do not create a duplicate
    }

    // Case 3: Stock is LOW or OUT, and NO active alert exists
    await tx.inventoryAlert.create({
      data: {
        clientId,
        variantId,
        locationId,
        type: targetType,
        severity: targetSeverity,
        title,
        message,
        currentQuantity,
        threshold: reorderLevel
      }
    });
  }
}
