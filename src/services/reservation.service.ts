import { prisma } from '../lib/prisma';
import { ReservationStatus } from '@prisma/client';
import { inventoryMutationService } from './inventory-mutation.service';
import { storefrontEventService } from './storefront-event.service';
import { afterCommit } from '../lib/afterCommit';
import { notFound, conflict } from '../utils/httpError';

/** "Silk saree (SKU-1)" for a message a person reads, rather than a variant id. */
async function describeVariant(tx: any, clientId: string, variantId: string, locationId: string) {
  const [variant, store] = await Promise.all([
    tx.productVariant.findFirst({
      where: { id: variantId, clientId },
      select: { sku: true, colorName: true, size: true, product: { select: { title: true } } }
    }),
    tx.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { name: true } })
  ]);
  const detail = [variant?.colorName, variant?.size].filter(Boolean).join(', ');
  const item = variant ? `${variant.product.title}${detail ? ` (${detail})` : ''} [${variant.sku}]` : 'That item';
  return { item, store: store?.name ?? 'this store' };
}

/**
 * Reserving or releasing changes what is AVAILABLE without changing what is physically held,
 * so it never produced a stock movement and therefore never produced an event. The result was
 * that a website order taking the last unit left every storefront still advertising it.
 *
 * Fire-and-forget, and after the transaction has committed (lib/afterCommit): the reservation is
 * the real work, a notification must not be able to fail it or hold its transaction open, and one
 * sent from inside a caller's transaction must not describe stock that has not been saved yet.
 */
function notifyStorefrontsOfAvailability(clientId: string, variantIds: string[]) {
  afterCommit(() => {
    for (const variantId of [...new Set(variantIds)]) {
      void storefrontEventService.stockUpdated(clientId, variantId)
        .catch(err => console.error('[StorefrontEvents] reservation change failed', err));
    }
  });
}

export class ReservationService {
  /**
   * Attempts to reserve stock for multiple items.
   * Runs in a transaction to ensure either all items are reserved or none are.
   */
  async reserveStock(clientId: string, locationId: string, items: { variantId: string; salesOrderItemId: string; quantity: number }[], txClient?: any) {
    const execute = async (tx: any) => {
      const reservations = [];

      // Locked in one fixed order. Two tills holding the same two items, scanned in opposite
      // orders, each locked one row and waited for the other -- a deadlock the database resolves
      // by failing one of the sales.
      for (const item of [...items].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
        // Find variant and lock it for update to prevent concurrent race conditions
        const stocks = await tx.$queryRaw<any[]>`
          SELECT id, quantity, reserved_qty as "reservedQty"
          FROM inventory_stocks
          WHERE variant_id = ${item.variantId} AND location_id = ${locationId} AND client_id = ${clientId}
          FOR UPDATE
        `;

        // Said with the item's name and the store's. A cashier could do nothing with two ids.
        if (stocks.length === 0) {
          const { item: label, store } = await describeVariant(tx, clientId, item.variantId, locationId);
          throw Object.assign(conflict(`Insufficient stock: ${label} is not stocked at ${store}.`),
            { details: { code: 'OUT_OF_STOCK', variantId: item.variantId, available: 0 } });
        }

        const stock = stocks[0];
        const availableQty = Math.max(0, stock.quantity - stock.reservedQty);

        if (item.quantity > availableQty) {
          const { item: label, store } = await describeVariant(tx, clientId, item.variantId, locationId);
          throw Object.assign(
            conflict(`Insufficient stock: only ${availableQty} of ${label} free at ${store}, and ${item.quantity} ${item.quantity === 1 ? 'is' : 'are'} needed.`),
            { details: { code: 'OUT_OF_STOCK', variantId: item.variantId, available: availableQty } }
          );
        }

        // Create reservation record
        const reservation = await tx.inventoryReservation.create({
          data: {
            clientId,
            locationId,
            variantId: item.variantId,
            salesOrderItemId: item.salesOrderItemId,
            reservedQty: item.quantity,
            status: 'ACTIVE'
          }
        });

        // Update variant reserved quantity on location
        await tx.inventoryStock.update({
          where: { variantId_locationId: { variantId: item.variantId, locationId } },
          data: {
            reservedQty: { increment: item.quantity }
          }
        });

        reservations.push(reservation);
      }

      return reservations;
    };

    const reservations = txClient ? await execute(txClient) : await prisma.$transaction(execute);

    // Reserving changes what is available to sell without changing what is physically held,
    // and nothing here ever said so. A shopper taking the last unit on the website left every
    // other storefront still advertising it, until some unrelated stock movement happened to
    // send an update -- which is precisely how an oversell happens.
    notifyStorefrontsOfAvailability(clientId, items.map(i => i.variantId));

    return reservations;
  }

  /**
   * Releases an active reservation. Used when an order is cancelled.
   */
  async releaseReservation(clientId: string, salesOrderItemId: string, txClient?: any) {
    const execute = async (tx: any) => {
      // PARTIALLY_FULFILLED counts too: cancelling an order that was partly dispatched
      // must still release the un-shipped remainder. Matching only 'ACTIVE' meant that
      // remainder stayed reserved forever -- invisible stock that no future order could
      // ever claim. The decrement below already handles it correctly, subtracting only
      // (reserved - dispatched), so nothing already shipped is double-counted.
      //
      // findMany, not findFirst.
      //
      // One order item is supposed to have exactly one live reservation, and with the
      // compare-and-set in confirmOrder it now does. But "supposed to" is not a guarantee to
      // build a release on: any row this misses stays reserved for ever, and reserved stock
      // that belongs to no live order is invisible -- it never appears as missing, it simply
      // stops being sellable. Releasing every live row costs one extra query and cannot strand
      // anything, including rows left behind by an older build.
      //
      // Locked, like dispatchReservation locks them. Read without a lock, a dispatch landing at the
      // same moment could consume units this then released again from the stale figures -- the
      // reserved count dropping twice for the same pieces.
      const reservations = await tx.$queryRaw`
        SELECT id, variant_id AS "variantId", location_id AS "locationId", reserved_qty AS "reservedQty", dispatched_qty AS "dispatchedQty"
        FROM inventory_reservations
        WHERE sales_order_item_id = ${salesOrderItemId} AND client_id = ${clientId} AND status IN ('ACTIVE', 'PARTIALLY_FULFILLED')
        FOR UPDATE
      ` as { id: string; variantId: string; locationId: string | null; reservedQty: number; dispatchedQty: number }[];

      if (reservations.length === 0) {
        return null;
      }

      let updatedReservation = null;
      for (const reservation of reservations) {
        updatedReservation = await tx.inventoryReservation.update({
          where: { id: reservation.id },
          data: { status: 'CANCELLED' }
        });

        // Release reserved stock from location stock
        await tx.inventoryStock.update({
          where: { variantId_locationId: { variantId: reservation.variantId, locationId: reservation.locationId as string } },
          data: {
            reservedQty: { decrement: reservation.reservedQty - reservation.dispatchedQty }
          }
        });
      }

      return updatedReservation;
    };

    const released = txClient ? await execute(txClient) : await prisma.$transaction(execute);

    // Cancelling puts the units back on sale. Without this the storefront keeps showing them
    // as unavailable until something else moves that variant. Null when there was no active
    // reservation to release, in which case nothing changed and there is nothing to announce.
    if (released) notifyStorefrontsOfAvailability(clientId, [released.variantId]);

    return released;
  }

  /**
   * Dispatches a reserved item. Reduces both physical stock and reserved stock.
   */
  async dispatchReservation(clientId: string, salesOrderItemId: string, dispatchQuantity: number, dispatchReference: string, txClient?: any) {
    const execute = async (tx: any) => {
      // Find the active or partially fulfilled reservation and lock it
      const reservations = await tx.$queryRaw<any[]>`
        SELECT id, variant_id as "variantId", location_id as "locationId", reserved_qty as "reservedQty", dispatched_qty as "dispatchedQty"
        FROM inventory_reservations
        WHERE sales_order_item_id = ${salesOrderItemId} AND client_id = ${clientId} AND status IN ('ACTIVE', 'PARTIALLY_FULFILLED')
        FOR UPDATE
      `;

      if (reservations.length === 0) {
        throw new Error(`No active reservation found for item ${salesOrderItemId}`);
      }

      const reservation = reservations[0];
      const remainingToDispatch = reservation.reservedQty - reservation.dispatchedQty;

      if (dispatchQuantity > remainingToDispatch) {
        throw new Error(`Cannot dispatch ${dispatchQuantity}. Only ${remainingToDispatch} reserved remaining.`);
      }

      const newDispatchedQty = reservation.dispatchedQty + dispatchQuantity;
      const newStatus = newDispatchedQty >= reservation.reservedQty ? 'FULFILLED' : 'PARTIALLY_FULFILLED';

      // Update reservation
      const updatedReservation = await tx.inventoryReservation.update({
        where: { id: reservation.id },
        data: {
          dispatchedQty: newDispatchedQty,
          status: newStatus
        }
      });

      // Update stock: remove from reserved (physical removed via dispatch)
      await tx.inventoryStock.update({
        where: { variantId_locationId: { variantId: reservation.variantId, locationId: reservation.locationId } },
        data: {
          reservedQty: { decrement: dispatchQuantity }
          // physical quantity is updated via inventoryMutationService later during dispatch
        }
      });

      return updatedReservation;
    };

    return txClient ? execute(txClient) : prisma.$transaction(execute);
  }
}

export const reservationService = new ReservationService();
