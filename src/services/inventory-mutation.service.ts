import { prisma } from '../lib/prisma';
import { TransactionType, InventoryReason, Prisma } from '@prisma/client';
import { InventoryAlertService } from './inventory-alert.service';
import { InventoryEventService } from './inventory-event.service';

interface MovementInput {
  clientId: string;
  variantId: string;
  locationId: string; // NEW: Required for multi-location
  movementType: TransactionType;
  reason: InventoryReason;
  quantityDelta: number; // positive for IN, negative for OUT
  unitCost?: number; // Needed for PURCHASE_RECEIPT or STOCK_IN to calculate WAC
  notes?: string;
  referenceType?: string;
  referenceId?: string;
  createdBy?: string;
  // Pass the caller's own transaction client here when applyMovement is invoked
  // from inside an already-open prisma.$transaction. Opening a second, independent
  // transaction from within another one is a connection-pool deadlock risk against
  // pooled Postgres (observed in practice as "Unable to start a transaction in the
  // given time") — always thread the outer `tx` through instead of nesting.
  tx?: Prisma.TransactionClient;
}

export class InventoryMutationService {
  async applyMovement(input: MovementInput) {
    const {
      clientId, variantId, locationId, movementType, reason, quantityDelta,
      unitCost, notes, referenceType, referenceId, createdBy, tx: externalTx
    } = input;

    const run = async (tx: Prisma.TransactionClient) => {
      // 1. Get the current variant and its global stock to calculate average cost
      const variant = await tx.productVariant.findUnique({
        where: { id: variantId },
        include: { stocks: true }
      });

      if (!variant || variant.clientId !== clientId) {
        throw new Error(`Variant ${variantId} not found.`);
      }

      // Guard against a locationId belonging to a different tenant being used here —
      // applyMovement is the single choke point for every stock mutation, so this is
      // the one place that can actually enforce it regardless of which caller forgot to.
      const location = await tx.stockLocation.findUnique({ where: { id: locationId } });
      if (!location || location.clientId !== clientId) {
        throw new Error(`Location ${locationId} not found for this tenant.`);
      }

      // Calculate global current quantity
      const globalQty = variant.stocks.reduce((acc, stock) => acc + stock.quantity, 0);

      // 2. Atomically update the specific location stock
      // We use upsert in case the location doesn't have stock record for this variant yet
      const stock = await tx.inventoryStock.findUnique({
        where: { variantId_locationId: { variantId, locationId } }
      });
      
      const oldLocationQty = stock ? stock.quantity : 0;
      const newLocationQty = oldLocationQty + quantityDelta;

      if (newLocationQty < 0) {
        throw new Error("Insufficient stock in this location to complete the transaction.");
      }

      const updatedStock = await tx.inventoryStock.upsert({
        where: { variantId_locationId: { variantId, locationId } },
        update: { quantity: newLocationQty },
        create: {
          clientId,
          variantId,
          locationId,
          quantity: newLocationQty,
          reservedQty: 0
        }
      });

      // 3. Update financial metrics on ProductVariant if it's an IN movement with cost
      let newAverageCost = Number(variant.averageCost);
      if (quantityDelta > 0 && unitCost !== undefined && unitCost !== null) {
        const currentGlobalValue = Number(variant.inventoryValue);
        const incomingValue = quantityDelta * unitCost;
        const newGlobalQty = globalQty + quantityDelta;
        
        newAverageCost = (currentGlobalValue + incomingValue) / newGlobalQty;
        
        await tx.productVariant.update({
          where: { id: variantId },
          data: {
            averageCost: newAverageCost,
            inventoryValue: newGlobalQty * newAverageCost,
            lastMovementAt: new Date(),
            lastCostUpdatedAt: new Date()
          }
        });
      } else {
        // Just update lastMovementAt and recalculate global inventory value
        const newGlobalQty = globalQty + quantityDelta;
        await tx.productVariant.update({
          where: { id: variantId },
          data: {
            inventoryValue: newGlobalQty * newAverageCost,
            lastMovementAt: new Date()
          }
        });
      }

      // 4. Create the transaction record
      await tx.inventoryTransaction.create({
        data: {
          clientId,
          variantId,
          locationId,
          type: movementType,
          reason,
          quantity: quantityDelta,
          balanceBefore: oldLocationQty,
          balanceAfter: newLocationQty,
          unitCost: unitCost || newAverageCost,
          totalCost: Math.abs(quantityDelta) * (unitCost || newAverageCost),
          notes,
          referenceType,
          referenceId,
          createdBy,
          sku: variant.sku,
          variantCode: variant.variantCode,
          barcode: variant.barcode
        }
      });

      // 5. Evaluate Operational Alerts
      await InventoryAlertService.evaluateStockAlert(
        tx,
        clientId,
        variantId,
        locationId,
        newLocationQty,
        variant.reorderLevel
      );

      // 6. Dispatch Outbox Event for external systems
      await InventoryEventService.createStockUpdatedEvent(
        tx,
        clientId,
        variantId,
        locationId,
        oldLocationQty,
        newLocationQty
      );

      return {
        quantity: newLocationQty,
        globalQuantity: globalQty + quantityDelta,
        averageCost: newAverageCost
      };
    };

    if (externalTx) {
      return run(externalTx);
    }

    return prisma.$transaction(run, {
      maxWait: 10000,
      timeout: 30000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  }
}

export const inventoryMutationService = new InventoryMutationService();
