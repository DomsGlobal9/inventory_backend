import { prisma } from '../lib/prisma';
import { legsTakenFrom } from './shelves/from-spots';
import { Prisma } from '@prisma/client';
import { generateSequentialCode } from '../utils/codeGenerator';
import { reservationService } from './reservation.service';
import { inventoryMutationService } from './inventory-mutation.service';
import { notFound, badRequest, conflict } from '../utils/httpError';
import { toMinor, minorToNumber, portionOf } from './pricing';

export class DispatchService {
  /**
   * Send out part or all of an order, in its own transaction.
   *
   * The work is dispatchInTransaction below; this is the door a person's Dispatch button and
   * Shopify fulfilment come through. Serializable, because a dispatch reads what is still reserved
   * and writes against it.
   */
  async createDispatch(clientId: string, salesOrderId: string, items: { salesOrderItemId: string; quantity: number; fromSpots?: unknown }[]) {
    return prisma.$transaction(
      (tx) => this.dispatchInTransaction(tx, clientId, salesOrderId, items),
      { timeout: 30000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  /**
   * Send out part or all of an order inside a transaction the caller already holds.
   *
   * Split out so a counter sale can create the order, hold its stock and send it out as ONE
   * transaction -- all of it saved or none of it. createDispatch opened its own transaction and
   * read the order before it began, so it could not be part of anything larger; and a dispatch
   * racing a cancel read an order that was no longer what it checked.
   */
  async dispatchInTransaction(tx: any, clientId: string, salesOrderId: string, items: { salesOrderItemId: string; quantity: number; fromSpots?: unknown }[]) {
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest('Choose at least one item to send out.');
    }
    const seen = new Set<string>();
    for (const item of items) {
      // The same line twice would be checked against what is reserved before either was taken off,
      // and could send out more than is held.
      if (seen.has(item.salesOrderItemId)) throw badRequest('Each item can appear once in a dispatch.');
      seen.add(item.salesOrderItemId);
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw badRequest('Send out whole pieces, at least one.');
    }
    // Shelves each item was picked from, when a pick list named them. Otherwise the shelf rule decides.
    const pickedFrom = new Map(items.map(i => [i.salesOrderItemId, legsTakenFrom(i.fromSpots, i.quantity)]));

    // Read inside the transaction: see above.
    const order = await tx.salesOrder.findFirst({
      where: { id: salesOrderId, clientId, deletedAt: null },
      include: { items: true }
    });

    if (!order) throw notFound("Order not found");
    if (order.status !== 'CONFIRMED' && order.status !== 'PARTIALLY_DISPATCHED') {
      throw conflict(`This order is ${String(order.status).toLowerCase().replace('_', ' ')}, so nothing can be sent out against it.`);
    }
    for (const item of items) {
      if (!order.items.some((oi: any) => oi.id === item.salesOrderItemId)) throw notFound('That item is not on this order.');
    }

    {
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
          spots: pickedFrom.get(dItem.salesOrderItemId),
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
    }
  }
}

export const dispatchService = new DispatchService();
