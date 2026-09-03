import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { generateSequentialCode } from '../utils/codeGenerator';
import { reservationService } from './reservation.service';
import { inventoryMutationService } from './inventory-mutation.service';

export class DispatchService {
  async createDispatch(clientId: string, salesOrderId: string, items: { salesOrderItemId: string; quantity: number }[]) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('At least one item is required to create a dispatch');
    }

    // 1. Validate Order
    const order = await prisma.salesOrder.findFirst({
      where: { id: salesOrderId, clientId, deletedAt: null },
      include: { items: true }
    });

    if (!order) throw new Error("Order not found");
    if (order.status !== 'CONFIRMED' && order.status !== 'PARTIALLY_DISPATCHED') {
      throw new Error(`Cannot dispatch order in ${order.status} state`);
    }

    const dispatchCode = await generateSequentialCode(clientId, 'DSP', 'DISPATCH');

    // Everything below — the Dispatch record, reservation consumption, physical
    // stock movement, ledger entry, and the order status update — now runs as one
    // transaction. Previously each step committed independently, so a failure
    // partway through (e.g. an over-dispatch on item 2 of 3) left a Dispatch row
    // and partial reservation/stock changes behind with no order status update.
    return prisma.$transaction(async (tx) => {
      const dispatch = await (tx as any).dispatch.create({
        data: {
          clientId,
          salesOrderId,
          dispatchNumber: dispatchCode,
          status: 'SHIPPED', // Simplified for Sprint 4
          items: {
            create: items.map((item: any) => ({
              salesOrderItemId: item.salesOrderItemId,
              quantity: item.quantity
            }))
          }
        },
        include: { items: true }
      });

      // Process each item (Reservations, Inventory, Ledger)
      let totalRevenue = 0;
      let totalCogs = 0;

      for (const dItem of dispatch.items) {
        const orderItem = order.items.find((oi: any) => oi.id === dItem.salesOrderItemId);
        if (!orderItem) throw new Error("Order item not found");

        // a) Update Reservation (decrements reservedQty)
        await reservationService.dispatchReservation(clientId, dItem.salesOrderItemId, dItem.quantity, dispatch.id, tx);

        // a.1) Keep the order item's own fulfilledQty in sync — this is what the
        // order detail UI displays, separately from the reservation bookkeeping above.
        await tx.salesOrderItem.update({
          where: { id: dItem.salesOrderItemId },
          data: { fulfilledQty: { increment: dItem.quantity } }
        });

        // b) Update Physical Inventory (decrements physical quantity)
        await inventoryMutationService.applyMovement({
          clientId,
          locationId: order.locationId!,
          variantId: orderItem.variantId,
          movementType: 'OUT',
          reason: 'SALE',
          quantityDelta: -dItem.quantity, // Negative for OUT
          referenceType: 'DISPATCH',
          referenceId: dispatch.id,
          tx
        });

        totalRevenue += Number(orderItem.unitPrice) * dItem.quantity;
        totalCogs += Number(orderItem.unitCost) * dItem.quantity;
      }

      // c) Record Sales Ledger (Revenue recognition)
      if (totalRevenue > 0 || totalCogs > 0) {
        await (tx as any).salesLedger.create({
          data: {
            clientId,
            salesOrderId,
            dispatchId: dispatch.id,
            revenue: totalRevenue,
            costOfGoods: totalCogs,
            grossProfit: totalRevenue - totalCogs
          }
        });
      }

      // 4. Update Order Status
      // We need to check if ALL items are fully dispatched now.
      // To do this, we can check all reservations for this order.
      const allReservations = await tx.inventoryReservation.findMany({
        where: { clientId, salesOrderItem: { salesOrderId } }
      });

      const isFullyDispatched = allReservations.every((res: any) => res.status === 'FULFILLED');
      const newStatus = isFullyDispatched ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED';

      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: { status: newStatus }
      });

      return dispatch;
    }, {
      timeout: 30000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  }
}

export const dispatchService = new DispatchService();
