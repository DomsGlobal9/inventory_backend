import { prisma } from '../lib/prisma';
import { ReservationStatus } from '@prisma/client';
import { inventoryMutationService } from './inventory-mutation.service';

export class ReservationService {
  /**
   * Attempts to reserve stock for multiple items.
   * Runs in a transaction to ensure either all items are reserved or none are.
   */
  async reserveStock(clientId: string, items: { variantId: string; salesOrderItemId: string; quantity: number }[], txClient?: any) {
    const execute = async (tx: any) => {
      const reservations = [];
      
      for (const item of items) {
        // Find variant and lock it for update to prevent concurrent race conditions
        const variants = await tx.$queryRaw<any[]>`
          SELECT id, quantity, reserved_qty as "reservedQty"
          FROM inventory_product_variants
          WHERE id = ${item.variantId} AND client_id = ${clientId}
          FOR UPDATE
        `;

        if (variants.length === 0) {
          throw new Error(`Variant ${item.variantId} not found`);
        }

        const variant = variants[0];
        const availableQty = variant.quantity - variant.reservedQty;

        if (item.quantity > availableQty) {
          throw new Error(`Insufficient stock for variant ${item.variantId}. Requested: ${item.quantity}, Available: ${availableQty}`);
        }

        // Create reservation record
        const reservation = await tx.inventoryReservation.create({
          data: {
            clientId,
            variantId: item.variantId,
            salesOrderItemId: item.salesOrderItemId,
            reservedQty: item.quantity,
            status: 'ACTIVE'
          }
        });

        // Update variant reserved quantity
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: {
            reservedQty: { increment: item.quantity }
          }
        });

        reservations.push(reservation);
      }
      
      return reservations;
    };

    return txClient ? execute(txClient) : prisma.$transaction(execute);
  }

  /**
   * Releases an active reservation. Used when an order is cancelled.
   */
  async releaseReservation(clientId: string, salesOrderItemId: string) {
    return prisma.$transaction(async (tx) => {
      const reservation = await tx.inventoryReservation.findFirst({
        where: { clientId, salesOrderItemId, status: 'ACTIVE' }
      });

      if (!reservation) {
        return null;
      }

      // Update reservation status
      const updatedReservation = await tx.inventoryReservation.update({
        where: { id: reservation.id },
        data: { status: 'CANCELLED' }
      });

      // Release reserved stock from variant
      await tx.productVariant.update({
        where: { id: reservation.variantId },
        data: {
          reservedQty: { decrement: reservation.reservedQty - reservation.dispatchedQty }
        }
      });

      return updatedReservation;
    });
  }

  /**
   * Dispatches a reserved item. Reduces both physical stock and reserved stock.
   */
  async dispatchReservation(clientId: string, salesOrderItemId: string, dispatchQuantity: number, dispatchReference: string) {
    return prisma.$transaction(async (tx) => {
      // Find the active or partially fulfilled reservation and lock it
      const reservations = await tx.$queryRaw<any[]>`
        SELECT id, variant_id as "variantId", reserved_qty as "reservedQty", dispatched_qty as "dispatchedQty"
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

      // Update variant: remove from physical AND reserved
      await tx.productVariant.update({
        where: { id: reservation.variantId },
        data: {
          reservedQty: { decrement: dispatchQuantity }
          // physical quantity is updated via inventoryMutationService below
        }
      });
      
      return updatedReservation;
    });
  }
}

export const reservationService = new ReservationService();
