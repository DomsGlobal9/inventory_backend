import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { inventoryMutationService } from './inventory-mutation.service';

export class ReturnService {
  /**
   * Initializes a return request.
   */
  async createReturn(clientId: string, salesOrderId: string, items: { dispatchItemId: string; quantity: number }[], notes?: string) {
    return prisma.$transaction(async (tx) => {
      // Validate sales order
      const order = await tx.salesOrder.findFirst({
        where: { id: salesOrderId, clientId }
      });
      if (!order) throw new Error('Sales order not found');

      // Create return record
      const returnNumber = await generateSequentialCode(clientId, 'RET', 'SALES_RETURN');

      const salesReturn = await tx.salesReturn.create({
        data: {
          clientId,
          salesOrderId,
          returnNumber,
          status: 'REQUESTED',
          reason: 'OTHER', // Default or could be passed in
          notes,
          items: {
            create: items.map(item => ({
              dispatchItemId: item.dispatchItemId,
              quantity: item.quantity,
              disposition: 'PENDING'
            }))
          }
        },
        include: {
          items: true
        }
      });

      // Validate quantities against dispatchItems
      for (const item of salesReturn.items) {
        const dispatchItem = await tx.dispatchItem.findUnique({
          where: { id: item.dispatchItemId },
          include: { dispatch: true }
        });

        if (!dispatchItem || dispatchItem.dispatch.clientId !== clientId) {
          throw new Error(`DispatchItem ${item.dispatchItemId} not found`);
        }

        const availableToReturn = dispatchItem.quantity - dispatchItem.returnedQty;
        if (item.quantity > availableToReturn) {
          throw new Error(`Cannot return ${item.quantity} units for dispatch item ${item.dispatchItemId}. Only ${availableToReturn} available to return.`);
        }
      }

      return salesReturn;
    }, { timeout: 15000 });
  }

  /**
   * Marks return as received
   */
  async receiveReturn(clientId: string, id: string) {
    const salesReturn = await prisma.salesReturn.findFirst({
      where: { id, clientId }
    });
    if (!salesReturn) throw new Error('Return not found');

    if (salesReturn.status !== 'REQUESTED') {
      throw new Error(`Cannot transition from ${salesReturn.status} to RECEIVED`);
    }

    return prisma.salesReturn.update({
      where: { id },
      data: { status: 'RECEIVED' }
    });
  }

  /**
   * Updates inspection disposition for items and transitions to INSPECTED
   */
  async inspectReturn(clientId: string, id: string, itemsDisposition: { salesReturnItemId: string; disposition: 'RESTOCK' | 'DAMAGED' | 'SCRAP'; reason?: any }[]) {
    return prisma.$transaction(async (tx) => {
      const salesReturn = await tx.salesReturn.findFirst({
        where: { id, clientId },
        include: { items: true }
      });

      if (!salesReturn) throw new Error('Return not found');
      if (salesReturn.status !== 'RECEIVED' && salesReturn.status !== 'REQUESTED') {
        throw new Error(`Cannot transition from ${salesReturn.status} to INSPECTED`);
      }

      for (const update of itemsDisposition) {
        await tx.salesReturnItem.update({
          where: { id: update.salesReturnItemId },
          data: { disposition: update.disposition }
        });
      }

      // We also update the main reason if provided, but the user requested ReturnReason at the top level
      // We'll leave it as an option
      
      return tx.salesReturn.update({
        where: { id },
        data: { status: 'INSPECTED' },
        include: { items: true }
      });
    }, { timeout: 15000 });
  }

  /**
   * Finalizes the return.
   */
  async completeReturn(clientId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      const salesReturn = await tx.salesReturn.findFirst({
        where: { id, clientId },
        include: { 
          items: {
            include: {
              dispatchItem: {
                include: { salesOrderItem: true }
              }
            }
          } 
        }
      });

      if (!salesReturn) throw new Error('Return not found');

      if (salesReturn.status === 'COMPLETED' || salesReturn.status === 'REJECTED') {
        throw new Error(`Return is already in terminal state: ${salesReturn.status}`);
      }

      // Validation: Fails immediately if any item still has a PENDING disposition.
      const hasPending = salesReturn.items.some(item => item.disposition === 'PENDING');
      if (hasPending) {
        throw new Error('Cannot complete return: One or more items still have a PENDING disposition');
      }

      // Loop over items atomically
      for (const item of salesReturn.items) {
        // Update the returnedQty on the parent DispatchItem
        await tx.dispatchItem.update({
          where: { id: item.dispatchItemId },
          data: {
            returnedQty: { increment: item.quantity }
          }
        });

        // Validate we didn't exceed returnedQty (should be caught by earlier checks, but good to be safe)
        const updatedDispatchItem = await tx.dispatchItem.findUnique({
          where: { id: item.dispatchItemId }
        });
        if (updatedDispatchItem!.returnedQty > updatedDispatchItem!.quantity) {
          throw new Error('Exceeded maximum return quantity for this dispatch item');
        }

        if (item.disposition === 'RESTOCK') {
          // Increase physical stock
          await inventoryMutationService.applyMovement({
            clientId,
            variantId: item.dispatchItem.salesOrderItem.variantId,
            movementType: 'IN',
            reason: 'CUSTOMER_RETURN',
            quantityDelta: item.quantity,
            notes: `Restock from return ${salesReturn.returnNumber}`,
            referenceType: 'SALES_RETURN',
            referenceId: salesReturn.id
          });
        }
      }

      return tx.salesReturn.update({
        where: { id },
        data: { 
          status: 'COMPLETED',
          completedAt: new Date()
        }
      });
    }, { timeout: 15000 });
  }

  /**
   * Rejects the return
   */
  async rejectReturn(clientId: string, id: string) {
    const salesReturn = await prisma.salesReturn.findFirst({
      where: { id, clientId }
    });

    if (!salesReturn) throw new Error('Return not found');

    if (salesReturn.status === 'COMPLETED' || salesReturn.status === 'REJECTED') {
      throw new Error(`Return is already in terminal state: ${salesReturn.status}`);
    }

    return prisma.salesReturn.update({
      where: { id },
      data: { status: 'REJECTED' }
    });
  }

  /**
   * Get returns for a client
   */
  async getReturns(clientId: string) {
    return prisma.salesReturn.findMany({
      where: { clientId },
      include: {
        salesOrder: { select: { orderNumber: true, customer: { select: { name: true } } } },
        items: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Get specific return
   */
  async getReturnById(clientId: string, id: string) {
    const ret = await prisma.salesReturn.findFirst({
      where: { clientId, id },
      include: {
        salesOrder: { 
          include: { customer: true }
        },
        items: {
          include: {
            dispatchItem: {
              include: {
                dispatch: true,
                salesOrderItem: {
                  include: {
                    variant: {
                      include: { product: true }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
    if (!ret) throw new Error('Return not found');
    return ret;
  }
}

export const returnService = new ReturnService();
