import { prisma } from '../lib/prisma';
import { TransactionType, InventoryReason } from '@prisma/client';

interface MovementInput {
  clientId: string;
  variantId: string;
  movementType: TransactionType;
  reason: InventoryReason;
  quantityDelta: number; // positive for IN, negative for OUT
  unitCost?: number; // Needed for PURCHASE_RECEIPT or STOCK_IN to calculate WAC
  notes?: string;
  referenceType?: string;
  referenceId?: string;
  createdBy?: string;
}

export class InventoryMutationService {
  /**
   * Centralized inventory mutation.
   * Handles:
   * 1. Quantity updates
   * 2. WAC and Inventory Value calculation (only for IN movements)
   * 3. lastMovementAt updates
   * 4. Transaction ledger logging
   */
  async applyMovement(input: MovementInput) {
    const {
      clientId, variantId, movementType, reason, quantityDelta,
      unitCost, notes, referenceType, referenceId, createdBy
    } = input;

    return prisma.$transaction(async (tx) => {
      // Use a CTE to atomically update the variant and return the before/after state
      // We only recalculate averageCost if it's an IN movement (quantityDelta > 0).
      const result = await tx.$queryRaw<any[]>`
        WITH old_state AS (
          SELECT 
            quantity AS old_quantity, 
            average_cost AS old_average_cost,
            inventory_value AS old_inventory_value,
            sku,
            variant_code,
            barcode
          FROM "inventory_product_variants"
          WHERE id = ${variantId} AND client_id = ${clientId}
        ),
        updated_variant AS (
          UPDATE "inventory_product_variants" v
          SET 
            quantity = v.quantity + ${quantityDelta},
            
            -- Recalculate averageCost ONLY if quantity increases and we have a unitCost.
            -- Otherwise keep existing averageCost.
            average_cost = CASE 
              WHEN ${quantityDelta} > 0 AND ${unitCost !== undefined ? unitCost : null}::numeric IS NOT NULL THEN
                (v.inventory_value + (${quantityDelta} * ${unitCost !== undefined ? unitCost : 0}::numeric)) / (v.quantity + ${quantityDelta})
              ELSE
                v.average_cost
            END,
            
            -- Recalculate inventoryValue based on the (potentially updated) averageCost
            inventory_value = (v.quantity + ${quantityDelta}) * (
              CASE 
                WHEN ${quantityDelta} > 0 AND ${unitCost !== undefined ? unitCost : null}::numeric IS NOT NULL THEN
                  (v.inventory_value + (${quantityDelta} * ${unitCost !== undefined ? unitCost : 0}::numeric)) / (v.quantity + ${quantityDelta})
                ELSE
                  v.average_cost
              END
            ),
            
            last_movement_at = NOW(),
            last_cost_updated_at = CASE WHEN ${quantityDelta} > 0 AND ${unitCost !== undefined ? unitCost : null}::numeric IS NOT NULL THEN NOW() ELSE v.last_cost_updated_at END,
            updated_at = NOW()
          FROM old_state
          WHERE v.id = ${variantId} AND v.client_id = ${clientId}
          RETURNING 
            old_state.old_quantity,
            old_state.old_average_cost,
            old_state.sku,
            old_state.variant_code,
            old_state.barcode,
            v.quantity AS new_quantity,
            v.average_cost AS new_average_cost
        )
        SELECT * FROM updated_variant;
      `;

      if (!result || result.length === 0) {
        throw new Error(`Variant ${variantId} not found or update failed.`);
      }

      const state = result[0];
      
      // Check for negative stock and rollback if necessary
      if (state.new_quantity < 0) {
        throw new Error("Insufficient stock to complete this transaction");
      }

      // Create the transaction record
      await tx.inventoryTransaction.create({
        data: {
          clientId,
          variantId,
          type: movementType,
          reason,
          quantity: quantityDelta,
          balanceBefore: state.old_quantity,
          balanceAfter: state.new_quantity,
          unitCost: unitCost || state.old_average_cost,
          totalCost: Math.abs(quantityDelta) * Number(unitCost || state.old_average_cost),
          notes,
          referenceType,
          referenceId,
          createdBy,
          sku: state.sku,
          variantCode: state.variant_code,
          barcode: state.barcode
        }
      });

      return {
        quantity: state.new_quantity,
        averageCost: state.new_average_cost
      };
    });
  }
}

export const inventoryMutationService = new InventoryMutationService();
