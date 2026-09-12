import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { generateSequentialCode } from '../utils/codeGenerator';
import { reservationService } from './reservation.service';
import { inventoryMutationService } from './inventory-mutation.service';
import { notFound } from '../utils/httpError';
import { toMinor, minorToNumber, portionOf } from './pricing';

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

    if (!order) throw notFound("Order not found");
    if (order.status !== 'CONFIRMED' && order.status !== 'PARTIALLY_DISPATCHED') {
      throw new Error(`Cannot dispatch order in ${order.status} state`);
    }

    // Everything below — the dispatch NUMBER, the Dispatch record, reservation consumption,
    // physical stock movement, ledger entry, and the order status update — runs as one
    // transaction. Previously each step committed independently, so a failure partway through
    // (e.g. an over-dispatch on item 2 of 3) left a Dispatch row and partial reservation/stock
    // changes behind with no order status update.
    //
    // The number was still being taken outside it, which is the same bug one level down: a
    // dispatch rejected for a bad line had already consumed DSP-000001, so the first dispatch
    // this shop ever completed was numbered DSP-000002 and nothing accounted for the one
    // before it. Inside the transaction, a rejected dispatch gives its number back.
    return prisma.$transaction(async (tx) => {
      const dispatchCode = await generateSequentialCode(clientId, 'DSP', 'DISPATCH', tx as any);

      const dispatch = await (tx as any).dispatch.create({
        data: {
          clientId,
          salesOrderId,
          dispatchNumber: dispatchCode,
          status: 'SHIPPED', // Simplified for Sprint 4
          /*
           * When the goods actually left.
           *
           * Nothing has ever set this. The column is nullable, nothing defaults it, and the day
           * book selects dispatches with `dispatchedAt` inside the day -- so its entire Sales
           * section (revenue, units dispatched, gross profit, the list of the day's orders) has
           * been empty for every shop since it was written. Confirmed against the database:
           * 0 of 14 dispatch rows across all tenants had a value.
           *
           * Set here rather than defaulted in the schema because the comment on the day book's
           * query is right about the intent -- a dispatch record could be prepared in advance
           * and only become a sale when it ships. This service does both in one step, so for
           * now the two moments are the same one.
           */
          dispatchedAt: new Date(),
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
        if (!orderItem) throw notFound("Order item not found");

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

        /*
         * Revenue recognised for the units going out now.
         *
         * Was `unitPrice x quantity`. That was exact while every line was sold at its list
         * price, and stopped being exact the moment a line could carry a discount: three items
         * sold for ₹7,458.32 have no whole-paisa unit price, so shipping all three recognised
         * ₹7,458.33 and left a paisa in the sales ledger that no customer ever paid.
         *
         * `portionOf` is cumulative -- the value of units (already shipped .. now shipped) --
         * so however a line is split across dispatches, the revenue recognised over all of them
         * adds up to the line total exactly.
         */
        const shippedBefore = Number(orderItem.fulfilledQty ?? 0);
        totalRevenue += minorToNumber(portionOf(
          toMinor(orderItem.totalPrice),
          orderItem.quantity,
          shippedBefore,
          shippedBefore + dItem.quantity
        ));
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
