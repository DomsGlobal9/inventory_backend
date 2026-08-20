import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { reservationService } from './reservation.service';
import { inventoryMutationService } from './inventory-mutation.service';

export class DispatchService {
  async createDispatch(clientId: string, salesOrderId: string, items: { salesOrderItemId: string; quantity: number }[]) {
    // 1. Validate Order
    const order = await prisma.salesOrder.findFirst({
      where: { id: salesOrderId, clientId, deletedAt: null },
      include: { items: true }
    });

    if (!order) throw new Error("Order not found");
    if (order.status !== 'CONFIRMED' && order.status !== 'PARTIALLY_DISPATCHED') {
      throw new Error(`Cannot dispatch order in ${order.status} state`);
    }

    // 2. Prepare the dispatch record
    const dispatchCode = await generateSequentialCode(clientId, 'DSP', 'DISPATCH');
    
    // Create the Dispatch record first
    const dispatch = await (prisma as any).dispatch.create({
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

    // 3. Process each item (Reservations, Inventory, Ledger)
    let totalRevenue = 0;
    let totalCogs = 0;

    for (const dItem of dispatch.items) {
      const orderItem = order.items.find((oi: any) => oi.id === dItem.salesOrderItemId);
      if (!orderItem) throw new Error("Order item not found");

      // a) Update Reservation (decrements reservedQty)
      await reservationService.dispatchReservation(clientId, dItem.salesOrderItemId, dItem.quantity, dispatch.id);

      // b) Update Physical Inventory (decrements physical quantity)
      await inventoryMutationService.applyMovement({
        clientId,
        variantId: orderItem.variantId,
        movementType: 'OUT',
        reason: 'SALE',
        quantityDelta: -dItem.quantity, // Negative for OUT
        referenceType: 'DISPATCH',
        referenceId: dispatch.id
      });

      totalRevenue += Number(orderItem.unitPrice) * dItem.quantity;
      totalCogs += Number(orderItem.unitCost) * dItem.quantity;
    }

    // c) Record Sales Ledger (Revenue recognition)
    if (totalRevenue > 0 || totalCogs > 0) {
      await (prisma as any).salesLedger.create({
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
    const allReservations = await prisma.inventoryReservation.findMany({
      where: { clientId, salesOrderItem: { salesOrderId } }
    });

    const isFullyDispatched = allReservations.every(res => res.status === 'FULFILLED');
    const newStatus = isFullyDispatched ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED';

    await prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: { status: newStatus }
    });

    return dispatch;
  }
}

export const dispatchService = new DispatchService();
