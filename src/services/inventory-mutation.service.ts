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
      // 0. Serialize every movement for this VARIANT before reading anything else.
      //
      // The lock is on the variant, not the stock row, because a movement also rewrites
      // the variant's averageCost/inventoryValue from a sum across ALL its locations.
      // Locking only inventory_stocks would let two movements at different locations of
      // the same variant run concurrently and clobber each other's WAC.
      //
      // Taking it first also matters: a read performed before the lock establishes a
      // snapshot dependency, so a writer that locked later could still be aborted for a
      // read it did earlier.
      await tx.$queryRaw`
        SELECT id FROM inventory_product_variants WHERE id = ${variantId} FOR UPDATE
      `;

      // 1. Get the current variant and its global stock to calculate average cost
      const variant = await tx.productVariant.findUnique({
        where: { id: variantId },
        include: { stocks: true }
      });

      // These three are USER errors, not server faults. Thrown bare they inherited
      // errorHandler's `err.statusCode || 500` default, so "you asked to issue more stock
      // than you have" came back as HTTP 500 -- wrong semantics (a 5xx invites a retry
      // that can never succeed) and, because errorHandler persists only 5xx, every one of
      // them was written to the Platform Console's Errors page. That page is meant for
      // crashes; routine rejections were burying the real ones.
      if (!variant || variant.clientId !== clientId) {
        throw Object.assign(new Error(`Variant ${variantId} not found.`), { statusCode: 404 });
      }

      // Guard against a locationId belonging to a different tenant being used here —
      // applyMovement is the single choke point for every stock mutation, so this is
      // the one place that can actually enforce it regardless of which caller forgot to.
      const location = await tx.stockLocation.findUnique({ where: { id: locationId } });
      if (!location || location.clientId !== clientId) {
        throw Object.assign(new Error(`Location ${locationId} not found for this tenant.`), { statusCode: 404 });
      }

      // Calculate global current quantity
      const globalQty = variant.stocks.reduce((acc, stock) => acc + stock.quantity, 0);

      // 2. Apply the change to this location's stock. Safe to read-modify-write here:
      // the FOR UPDATE above means no other writer holds this row. Retries remain the
      // backstop for conflicts the lock cannot cover (notably the row not existing yet,
      // where there is nothing to lock).
      // We use upsert in case the location doesn't have stock record for this variant yet
      const stock = await tx.inventoryStock.findUnique({
        where: { variantId_locationId: { variantId, locationId } }
      });
      
      const oldLocationQty = stock ? stock.quantity : 0;
      const newLocationQty = oldLocationQty + quantityDelta;

      if (newLocationQty < 0) {
        throw Object.assign(
          new Error("Insufficient stock in this location to complete the transaction."),
          { statusCode: 400 }
        );
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
      // Already inside a caller's transaction -- retrying here is not ours to do. The
      // caller owns the transaction boundary and must retry the whole thing itself.
      return run(externalTx);
    }

    // Serializable transactions are EXPECTED to abort under concurrency: Postgres raises
    // 40001 ("could not serialize access due to read/write dependencies") and the caller is
    // supposed to retry. There was no retry, so a stock movement that merely overlapped
    // another writer failed outright -- and there is a permanent concurrent writer here,
    // the webhook dispatcher polling the same outbox table every 30s (server.ts:76), which
    // applyMovement also writes to via createStockUpdatedEvent.
    //
    // The whole `run` closure is re-executed, so every read is re-taken against the new
    // snapshot -- that is what makes the retry safe rather than a way to double-apply a
    // movement. Only serialization/deadlock aborts are retried; a business rejection like
    // "Insufficient stock" carries a statusCode and is rethrown on the first attempt.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        return await prisma.$transaction(run, {
          // Budgets sized for a QUEUE, not a race. Now that writers take a FOR UPDATE
          // lock they wait their turn instead of aborting, so the last of N concurrent
          // movements on one variant must sit through the N-1 ahead of it. Against a
          // high-latency database (this one averages ~1.3s per round trip) six queued
          // writers exceeded the old 30s budget and died with "Transaction not found --
          // refers to an old closed transaction", which is a timeout, not a conflict, and
          // is therefore not something the retry above can rescue.
          //
          // Waiting is the correct behaviour here: the lock guarantees each writer will
          // get its turn, so the only question is whether we are patient enough. On a
          // normal-latency database these transactions run in tens of milliseconds and
          // neither budget is approached.
          maxWait: 20000,
          timeout: 60000,
          // READ COMMITTED, not SERIALIZABLE. Correctness here comes from the explicit
          // FOR UPDATE above: it gives real mutual exclusion, so writers wait instead of
          // one of them being aborted. SERIALIZABLE added nothing on top of that lock but
          // did add spurious 40001 aborts from predicate locks -- measured at 3/6
          // concurrent receipts rejected, and still 1/6 once the lock was in place.
          // Every read below happens while holding the variant lock, and READ COMMITTED
          // takes a fresh snapshot per statement, so those reads see the latest committed
          // state. Retries stay as the backstop for deadlocks.
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
        });
      } catch (error: any) {
        if (attempt >= MAX_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
        // Short randomised backoff so two contending writers don't retry in lockstep.
        const delay = 40 * attempt + Math.floor(Math.random() * 40);
        console.warn(
          `[applyMovement] serialization conflict on attempt ${attempt}/${MAX_ATTEMPTS} ` +
          `(variant ${variantId}) -- retrying in ${delay}ms`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

/**
 * True only for aborts Postgres/Prisma expect the caller to retry:
 *   - P2034: Prisma's "write conflict or deadlock" wrapper
 *   - 40001: serialization failure   - 40P01: deadlock detected
 * Deliberately narrow: retrying anything else would mask real faults.
 */
function isRetryableTransactionError(error: any): boolean {
  if (!error) return false;
  if (error.code === 'P2034' || error.code === '40001' || error.code === '40P01') return true;
  const message = String(error.message || '');
  return /could not serialize access|deadlock detected|write conflict/i.test(message);
}

export const inventoryMutationService = new InventoryMutationService();
