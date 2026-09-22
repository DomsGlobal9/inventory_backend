import { settleReturn, previewReturn } from './loyalty';
import { prisma } from '../lib/prisma';
import { runTransaction } from '../lib/txRetry';
import { Prisma, ReturnReason } from '@prisma/client';
import { generateSequentialCode } from '../utils/codeGenerator';
import { inventoryMutationService } from './inventory-mutation.service';
import { notFound, conflict, badRequest } from '../utils/httpError';
import { portionOf, toMinor, fromMinor } from './pricing';

export class ReturnService {
  /**
   * Initializes a return request.
   */
  async createReturn(
    clientId: string,
    salesOrderId: string,
    items: { dispatchItemId: string; quantity: number }[],
    notes?: string,
    reason?: ReturnReason
  ) {
    return prisma.$transaction(tx => this.createReturnIn(tx, clientId, salesOrderId, items, notes, reason), { timeout: 15000 });
  }

  /** The same, inside the caller's transaction (the counter return books and completes in one). */
  async createReturnIn(
    tx: Prisma.TransactionClient,
    clientId: string,
    salesOrderId: string,
    items: { dispatchItemId: string; quantity: number }[],
    notes?: string,
    reason?: ReturnReason
  ) {
      // Validate sales order
      const order = await tx.salesOrder.findFirst({
        where: { id: salesOrderId, clientId }
      });
      if (!order) throw notFound('Sales order not found');

      // Create return record
      const returnNumber = await generateSequentialCode(clientId, 'RET', 'SALES_RETURN', tx as any);

      const salesReturn = await tx.salesReturn.create({
        data: {
          clientId,
          salesOrderId,
          returnNumber,
          status: 'REQUESTED',
          // Was hardcoded to 'OTHER' with a note saying it "could be passed in". It never
          // was, and the parameter did not exist to pass -- so every return on every tenant
          // recorded the same reason regardless of what the caller sent. OTHER stays as the
          // fallback for a caller that genuinely has nothing to say.
          reason: reason ?? 'OTHER',
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
          throw notFound(`DispatchItem ${item.dispatchItemId} not found`);
        }

        // Shipped on THIS order. The shop check above was not enough: an item shipped on one order
        // could be returned against another of the same shop, crediting the wrong customer's order
        // and leaving the right one looking unreturned.
        if (dispatchItem.dispatch.salesOrderId !== salesOrderId) {
          throw badRequest('That shipped item belongs to a different order.');
        }

        /*
         * Open returns count too. The returned count only moves when a return is COMPLETED, so a
         * second press of Return made another return for the same pieces -- worth nothing, and
         * impossible to complete later. Pieces already on a return that is still open are not
         * available to return again.
         */
        const open = await tx.salesReturnItem.aggregate({
          // Other returns only: this one's own lines were written just above, in this transaction.
          where: { dispatchItemId: item.dispatchItemId, salesReturnId: { not: salesReturn.id }, salesReturn: { clientId, status: { in: ['REQUESTED', 'RECEIVED', 'INSPECTED'] } } },
          _sum: { quantity: true }
        });
        const openQty = open._sum.quantity ?? 0;
        const availableToReturn = dispatchItem.quantity - dispatchItem.returnedQty - openQty;
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
          throw badRequest('Return whole pieces, at least one.');
        }
        if (item.quantity > availableToReturn) {
          throw Object.assign(new Error(
            availableToReturn <= 0
              ? 'Those pieces are already returned, or on a return that is still open.'
              : `Only ${availableToReturn} of that item can still come back${openQty > 0 ? ` (${openQty} already on an open return)` : ''}.`
          ), { statusCode: 409 });
        }
      }

      /*
       * What is owed back: the NET price paid, never the tag.
       *
       * A return logged here used to record no money at all -- refundTotal stayed 0 -- so a saree
       * bought for 8,000 after an offer came back with no record that 8,000 was owed, and nothing
       * to stop somebody refunding the 10,000 on the tag. Shopify refunds already carried their
       * amount; returns taken at the counter did not.
       *
       * Divided with portionOf, cumulatively across every earlier return of the same line, so
       * returning three sarees one at a time refunds exactly what the three cost together, to the
       * paisa. Rejected returns do not count as returned. PENDING, because this records what is
       * owed -- the shop pays it back at the counter. (A Shopify refund overwrites this afterwards
       * with Shopify's own figure and REFUNDED.)
       */
      const dispatchItems = await tx.dispatchItem.findMany({
        where: { id: { in: salesReturn.items.map(i => i.dispatchItemId) } },
        select: { id: true, salesOrderItemId: true, salesOrderItem: { select: { id: true, quantity: true, totalPrice: true } } }
      });
      const lineOf = new Map(dispatchItems.map(d => [d.id, d.salesOrderItem]));
      const alreadyReturned = new Map<string, number>();
      let totalMinor = 0;

      for (const item of salesReturn.items) {
        const line = lineOf.get(item.dispatchItemId);
        if (!line) continue;

        if (!alreadyReturned.has(line.id)) {
          const earlier = await tx.salesReturnItem.aggregate({
            where: {
              salesOrderItemId: line.id,
              salesReturnId: { not: salesReturn.id },
              salesReturn: { status: { not: 'REJECTED' } }
            },
            _sum: { quantity: true }
          });
          alreadyReturned.set(line.id, earlier._sum.quantity ?? 0);
        }

        const before = alreadyReturned.get(line.id)!;
        const after = Math.min(before + item.quantity, line.quantity);
        const amountMinor = portionOf(toMinor(line.totalPrice), line.quantity, before, after);
        alreadyReturned.set(line.id, after);
        totalMinor += amountMinor;

        await tx.salesReturnItem.update({
          where: { id: item.id },
          data: { salesOrderItemId: line.id, refundAmount: fromMinor(amountMinor) }
        });
      }

      return tx.salesReturn.update({
        where: { id: salesReturn.id },
        data: { refundTotal: fromMinor(totalMinor), refundStatus: totalMinor > 0 ? 'PENDING' : 'NONE' },
        include: { items: true }
      });
  }

  /**
   * Marks return as received
   */
  async receiveReturn(clientId: string, id: string) {
    const salesReturn = await prisma.salesReturn.findFirst({
      where: { id, clientId }
    });
    if (!salesReturn) throw notFound('Return not found');

    if (salesReturn.status !== 'REQUESTED') {
      // 409, not a bare Error: the request is fine, the return has moved on. And said in
      // words -- "Cannot transition from RECEIVED to RECEIVED" is not something to show
      // somebody standing at a counter with the customer in front of them.
      throw conflict(
        salesReturn.status === 'RECEIVED'
          ? 'These goods have already been booked in. Refresh to see where this return got to.'
          : 'This return has already moved past being booked in.'
      );
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

      if (!salesReturn) throw notFound('Return not found');
      // INSPECTED as well: a piece marked scrap that is fine must be correctable before completion.
      // Refusing it left completing the wrong decision, or turning the whole return down, as the
      // only ways out.
      if (!['REQUESTED', 'RECEIVED', 'INSPECTED'].includes(salesReturn.status)) {
        throw Object.assign(new Error(`This return is ${salesReturn.status.toLowerCase()}, so it cannot be inspected now.`), { statusCode: 409 });
      }

      // Every item must get a real disposition in this one call. Previously the UI's
      // "Pending" default was accepted verbatim and untouched items weren't sent at all,
      // yet the status still flipped to INSPECTED below -- and that combination is a
      // dead end: inspectReturn refuses to run again on an INSPECTED return, while
      // completeReturn refuses to finish while any item is PENDING. The return could
      // then only ever be rejected.
      const validDispositions = ['RESTOCK', 'DAMAGED', 'SCRAP'];
      const byItemId = new Map(itemsDisposition.map(u => [u.salesReturnItemId, u.disposition]));

      for (const item of salesReturn.items) {
        const disposition = byItemId.get(item.id);
        if (!disposition || !validDispositions.includes(disposition)) {
          throw new Error(`Every returned item needs a disposition of RESTOCK, DAMAGED or SCRAP before inspection can be saved`);
        }
      }

      for (const update of itemsDisposition) {
        // Scoped to this return: `id` is globally unique, so an unscoped update let a
        // crafted payload rewrite another return's -- or another tenant's -- line item.
        const changed = await tx.salesReturnItem.updateMany({
          where: { id: update.salesReturnItemId, salesReturnId: id },
          data: { disposition: update.disposition }
        });
        if (changed.count === 0) throw new Error(`Return item ${update.salesReturnItemId} does not belong to this return`);
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
    return runTransaction(tx => this.completeReturnIn(tx, clientId, id), {
      label: 'complete a return',
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      tooSlowMessage: 'Finishing this return took too long, so nothing was recorded. Try again.'
    });
  }

  /** The same, inside the caller's transaction. */
  async completeReturnIn(tx: Prisma.TransactionClient, clientId: string, id: string, opts: { restockAt?: string } = {}) {
      const salesReturn = await tx.salesReturn.findFirst({
        where: { id, clientId },
        include: {
          items: {
            include: {
              dispatchItem: {
                include: { salesOrderItem: { include: { salesOrder: true } } }
              }
            }
          }
        }
      });

      if (!salesReturn) throw notFound('Return not found');

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
            // Taken back at a counter: onto that store's stock, which may not be the one that sold it.
            locationId: opts.restockAt ?? item.dispatchItem.salesOrderItem.salesOrder.locationId!,
            variantId: item.dispatchItem.salesOrderItem.variantId,
            movementType: 'IN',
            reason: 'CUSTOMER_RETURN',
            quantityDelta: item.quantity,
            notes: `Restock from return ${salesReturn.returnNumber}`,
            referenceType: 'SALES_RETURN',
            referenceId: salesReturn.id,
            tx
          });
        }
      }

      // Loyalty points on the bill: those used on these goods come back as points (and the money
      // owed drops by as much), those earned on them are taken back. Nothing for a bill without points.
      await settleReturn(tx as any, clientId, id);

      return tx.salesReturn.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date()
        }
      });
  }

  /**
   * Rejects the return
   */
  async rejectReturn(clientId: string, id: string) {
    const salesReturn = await prisma.salesReturn.findFirst({
      where: { id, clientId }
    });

    if (!salesReturn) throw notFound('Return not found');

    if (salesReturn.status === 'COMPLETED' || salesReturn.status === 'REJECTED') {
      throw Object.assign(new Error(`This return is already ${salesReturn.status.toLowerCase()}.`), { statusCode: 409 });
    }

    // Nothing is owed on a return that was turned down, and it no longer counts against the line --
    // so a later, genuine return of the same saree is refunded in full.
    return prisma.salesReturn.update({
      where: { id },
      data: { status: 'REJECTED', refundTotal: 0, refundStatus: 'NONE' }
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
    if (!ret) throw notFound('Return not found');
    // Still open, on a bill paid partly with points: how the amount owed will split on completing.
    const pointsPreview = ret.status === 'COMPLETED' || ret.status === 'REJECTED' ? null : await previewReturn(clientId, id).catch(() => null);
    return { ...ret, pointsPreview };
  }
}

export const returnService = new ReturnService();
