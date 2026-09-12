import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { validateTransition } from '../utils/sales-order-state-machine';
import { reservationService } from './reservation.service';
import { resolveVariantForLocation } from '../utils/variant-location';
import { notFound, badRequest } from '../utils/httpError';
import {
  toMinor, fromMinor, netUnitPrice,
  priceLine, allocateOrderDiscount, orderTotalsFrom, PricedLine
} from './pricing';

export class SalesOrderService {
  async createDraftOrder(clientId: string, locationId: string, customerId: string, channel: any = 'POS') {
    const orderNumber = await generateSequentialCode(clientId, 'SO', 'SALES_ORDER');
    return prisma.salesOrder.create({
      data: {
        clientId,
        locationId,
        channel,
        orderNumber,
        customerId,
        status: 'DRAFT',
        subtotal: 0,
        total: 0
      }
    });
  }

  async createFullOrder(clientId: string, locationId: string, data: any, channel: any = 'POS') {
    // 1. Idempotency Check
    if (data.externalOrderId && data.sourceSystem) {
      const existingOrder = await prisma.salesOrder.findFirst({
        where: {
          clientId,
          externalOrderId: data.externalOrderId,
          sourceSystem: data.sourceSystem
        },
        include: { items: true, customer: true }
      });
      if (existingOrder) {
        return existingOrder; // Idempotent return
      }
    }

    const orderNumber = await generateSequentialCode(clientId, 'SO', 'SALES_ORDER');
    
    return prisma.$transaction(async (tx) => {
      let customerId = data.customer?.id;
      
      // If external customer ID provided, sync/find the customer
      if (data.customer?.externalId) {
        let existingCustomer = await tx.customer.findFirst({
          where: { clientId, externalCustomerId: data.customer.externalId }
        });
        
        if (!existingCustomer) {
          const customerCode = await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any);
          existingCustomer = await tx.customer.create({
            data: {
              clientId,
              customerCode,
              externalCustomerId: data.customer.externalId,
              name: data.customer.name || 'Unknown',
              phone: data.customer.phone || null,
              email: data.customer.email || null,
              billingAddress: data.customer.billingAddress || null,
              shippingAddress: data.customer.shippingAddress || null,
              status: 'ACTIVE'
            }
          });
        }
        customerId = existingCustomer.id;
      } else if (!customerId) {
        throw new Error('Customer information or external ID is required');
      }

      const order = await tx.salesOrder.create({
        data: {
          clientId,
          locationId,
          channel,
          orderNumber,
          customerId,
          externalOrderId: data.externalOrderId || null,
          sourceSystem: data.sourceSystem || null,
          customerName: data.customer?.name || null,
          customerPhone: data.customer?.phone || null,
          shippingAddress: data.customer?.shippingAddress || null,
          billingAddress: data.customer?.billingAddress || null,
          status: 'DRAFT',
          subtotal: 0,
          total: 0,
          taxAmount: data.taxAmount || 0,
          discountAmount: data.discountAmount || 0,
          shippingAmount: data.shippingAmount || 0,
        }
      });

      /*
       * Price every line BEFORE writing any of them.
       *
       * The loop used to create each row as it went and accumulate a subtotal. It cannot any
       * more: an order-level discount has to be divided between the lines, and you cannot divide
       * something between lines you have not finished counting. So this is two passes -- resolve
       * and price, then allocate, then write.
       */
      const resolved: { item: any; unitCostMinor: number; priced: PricedLine }[] = [];

      for (const item of data.items) {
        const variant = await tx.productVariant.findFirst({
          where: { id: item.variantId, clientId },
          include: { locationProfiles: true, product: { select: { basePrice: true } } }
        });
        if (!variant) throw notFound(`Variant not found: ${item.variantId}`);

        const locationConfig = resolveVariantForLocation(variant, locationId, Number(variant.product.basePrice));

        if (!locationConfig.isAvailable) {
          throw new Error(`Variant ${variant.sku} is not available for sale at this location`);
        }

        resolved.push({
          item,
          unitCostMinor: toMinor(variant.averageCost),
          // The caller's prices win where it gave any, and our catalogue fills in where it did
          // not. Which is the whole point of this release: a till or a website that has already
          // charged somebody is telling us what was charged, not asking what it should be.
          priced: priceLine(
            item.quantity,
            toMinor(locationConfig.price || 0),
            item,
            variant.sku
          )
        });
      }

      const pricedLines = resolved.map(r => r.priced);
      allocateOrderDiscount(pricedLines, this.orderLevelDiscountMinor(data.discountAmount, pricedLines));

      const reservationItems = [];

      for (const { item, unitCostMinor, priced } of resolved) {
        const totalCostMinor = unitCostMinor * priced.quantity;

        const orderItem = await tx.salesOrderItem.create({
          data: {
            salesOrderId: order.id,
            variantId: item.variantId,
            quantity: priced.quantity,
            listUnitPrice: fromMinor(priced.listUnitPriceMinor),
            lineDiscount: fromMinor(priced.lineDiscountMinor),
            allocatedDiscount: fromMinor(priced.allocatedDiscountMinor),
            unitPrice: fromMinor(priced.unitPriceMinor),
            unitCost: fromMinor(unitCostMinor),
            totalPrice: fromMinor(priced.totalPriceMinor),
            totalCost: fromMinor(totalCostMinor),
            // Against the NET total. This is the line the whole change exists for: a saree sold
            // at ₹9,600 after ₹2,400 off used to report the margin of a ₹12,000 sale.
            grossProfit: fromMinor(priced.totalPriceMinor - totalCostMinor),
            priceSource: priced.priceSource
          }
        });

        reservationItems.push({
          variantId: item.variantId,
          salesOrderItemId: orderItem.id,
          quantity: priced.quantity
        });
      }

      const totals = orderTotalsFrom(
        pricedLines,
        toMinor(order.taxAmount),
        toMinor(order.shippingAmount)
      );

      const updatedOrder = await tx.salesOrder.update({
        where: { id: order.id },
        data: {
          subtotal: fromMinor(totals.subtotalMinor),
          // Re-stated from the lines rather than left as the caller sent it. For an order with
          // only an order-level discount the two are identical; for one carrying per-line
          // discounts this is what makes the order's figure and its lines agree.
          discountAmount: fromMinor(totals.discountMinor),
          total: fromMinor(totals.totalMinor),
          status: data.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT'
        },
        include: { items: true, customer: true }
      });

      if (data.status === 'CONFIRMED' && reservationItems.length > 0) {
        await reservationService.reserveStock(clientId, locationId, reservationItems, tx);
      }

      return updatedOrder;
    }, { timeout: 30000 });
    // No custom timeout previously — Prisma's 5000ms default was too short for the
    // per-item loop above (2 round-trips per item) under this environment's DB
    // latency, and failed with "Transaction not found" once the connection was
    // reclaimed mid-transaction. Same fix already applied to the other multi-step
    // transactions in inventory-mutation.service.ts / purchase-order.service.ts / etc.
  }

  async getOrders(clientId: string, filters: any = {}) {
    const where: any = { clientId, deletedAt: null };
    if (filters.status) where.status = filters.status;

    return prisma.salesOrder.findMany({
      where,
      include: {
        customer: {
          select: { name: true, companyName: true, email: true }
        },
        items: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getOrderById(clientId: string, id: string) {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, id, deletedAt: null },
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: { product: true }
            }
          }
        }
      }
    });
    if (!order) throw notFound('Order not found');
    return order;
  }

  async updateOrder(clientId: string, id: string, data: any) {
    // Basic update for shipping, discount, tax (for Draft orders)
    const order = await prisma.salesOrder.findFirst({ where: { clientId, id } });
    if (!order) throw notFound('Order not found');
    
    // We don't use state machine here because status isn't changing, but we enforce DRAFT
    if (order.status !== 'DRAFT') throw new Error('Can only update DRAFT orders');

    const updated = await prisma.salesOrder.update({
      where: { id },
      data: {
        discountAmount: data.discountAmount ?? order.discountAmount,
        taxAmount: data.taxAmount ?? order.taxAmount,
        shippingAmount: data.shippingAmount ?? order.shippingAmount,
      }
    });

    return this.recalculateOrderTotals(clientId, id);
  }

  async deleteOrder(clientId: string, id: string) {
    const order = await prisma.salesOrder.findFirst({ where: { clientId, id } });
    if (!order) throw notFound('Order not found');
    if (order.status !== 'DRAFT') throw new Error('Can only delete DRAFT orders');
    return prisma.salesOrder.update({
      where: { id },
      data: { deletedAt: new Date() }
    });
  }

  async addOrderItem(clientId: string, orderId: string, variantId: string, quantity: number) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findFirst({ where: { id: orderId, clientId, deletedAt: null } });
      if (!order || order.status !== 'DRAFT') throw new Error('Cannot add items to non-DRAFT order');

      // Same location-aware price + availability resolution as createFullOrder -- this
      // path used to skip both entirely (flat `variant.sellingPrice` with a silent ₹0
      // fallback, no per-location override, no availability check), so the same item
      // could price differently depending on which of the two endpoints added it.
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, clientId },
        include: { locationProfiles: true, product: { select: { basePrice: true } } }
      });
      if (!variant) throw notFound('Variant not found');

      const locationConfig = resolveVariantForLocation(variant, order.locationId, Number(variant.product.basePrice));
      if (!locationConfig.isAvailable) {
        throw new Error(`Variant ${variant.sku} is not available for sale at this location`);
      }

      const unitPriceMinor = toMinor(locationConfig.price || 0);
      const unitCostMinor = toMinor(variant.averageCost);
      const totalPriceMinor = unitPriceMinor * quantity;
      const totalCostMinor = unitCostMinor * quantity;

      const item = await tx.salesOrderItem.create({
        data: {
          salesOrderId: orderId,
          variantId,
          quantity,
          // Added one at a time from inside the app, so there is no external price to honour
          // and no line discount: this is the catalogue path, unchanged in substance.
          listUnitPrice: fromMinor(unitPriceMinor),
          lineDiscount: fromMinor(0),
          allocatedDiscount: fromMinor(0),
          unitPrice: fromMinor(unitPriceMinor),
          unitCost: fromMinor(unitCostMinor),
          totalPrice: fromMinor(totalPriceMinor),
          totalCost: fromMinor(totalCostMinor),
          grossProfit: fromMinor(totalPriceMinor - totalCostMinor),
          priceSource: 'CATALOGUE'
        }
      });

      // Any order-level discount already typed against this draft is spread again across the
      // new set of lines, including this one. Without that, adding a fourth item to a
      // three-line order left the discount attributed entirely to the original three.
      await this.recalculateOrderTotals(clientId, orderId, tx);
      return item;
    }, { timeout: 30000 });
  }

  async removeOrderItem(clientId: string, orderId: string, itemId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findFirst({ where: { id: orderId, clientId, deletedAt: null } });
      if (!order || order.status !== 'DRAFT') throw new Error('Cannot remove items from non-DRAFT order');

      // Scope the delete to THIS order. `id` alone is globally unique, so an itemId
      // belonging to a different order -- including another tenant's -- was accepted and
      // destroyed, while this order's totals were then recalculated as if nothing changed.
      const deleted = await tx.salesOrderItem.deleteMany({
        where: { id: itemId, salesOrderId: orderId }
      });
      if (deleted.count === 0) throw notFound('Order item not found on this order');

      await this.recalculateOrderTotals(clientId, orderId, tx);
    }, { timeout: 30000 });
  }

  /**
   * How much of an order's stated discount is NOT already attributed to a particular line.
   *
   * `SalesOrder.discountAmount` means the total taken off the order. A caller may express that
   * either way round -- Shopify sends per-line allocations AND their sum, a till sends one
   * figure for the basket -- so the order-level part is the difference, and a stated total
   * SMALLER than the lines it contains is a contradiction rather than a negative top-up.
   */
  private orderLevelDiscountMinor(declared: any, lines: PricedLine[]): number {
    if (declared === null || declared === undefined) return 0;

    const declaredMinor = toMinor(declared);
    const lineSumMinor = lines.reduce((sum, l) => sum + l.lineDiscountMinor, 0);

    if (declaredMinor < lineSumMinor) {
      throw badRequest(
        `This order says ${declaredMinor / 100} was taken off, but its lines already account ` +
        `for ${lineSumMinor / 100}.`
      );
    }
    return declaredMinor - lineSumMinor;
  }

  /**
   * Re-derive an order's money from its lines.
   *
   * Three things changed here, and the third is the one that matters:
   *
   *  - `subtotal` is the sum of LIST prices, not net ones. It has always been the gross figure
   *    -- `total = subtotal - discount + tax + shipping` only works if it is -- and now that a
   *    line's `totalPrice` is net, summing that instead would have subtracted every discount
   *    twice.
   *  - `discountAmount` is now written, not just read. It is the sum of what the lines carry, so
   *    an order and its own lines can no longer disagree about how much came off.
   *  - the order-level discount is re-allocated across whatever lines exist NOW. Adding or
   *    removing an item after a discount was typed used to leave the discount attributed to the
   *    old set of lines, which is how a removed line could take its share of the discount with
   *    it and quietly raise the total.
   *
   * Idempotent, which it has to be -- this runs after every item add, every item removal and
   * every draft edit. The order-level part is recovered as
   * `order.discountAmount - sum(lineDiscount)`, which after a previous run reproduces exactly
   * the figure that run used.
   */
  private async recalculateOrderTotals(clientId: string, orderId: string, transactionClient: any = prisma) {
    const items = await transactionClient.salesOrderItem.findMany({
      where: { salesOrderId: orderId },
      orderBy: { createdAt: 'asc' }
    });
    const order = await transactionClient.salesOrder.findUnique({ where: { id: orderId } });

    // An order with nothing on it. Its discount is left exactly as the merchant typed it rather
    // than derived down to zero: a draft whose last line was removed while they reconsider must
    // still have its discount there when they add the next one.
    if (items.length === 0) {
      return transactionClient.salesOrder.update({
        where: { id: orderId },
        data: {
          subtotal: fromMinor(0),
          total: fromMinor(
            toMinor(order.taxAmount) + toMinor(order.shippingAmount) - toMinor(order.discountAmount)
          )
        }
      });
    }

    const lines: PricedLine[] = items.map((item: any) => {
      const listUnitPriceMinor = toMinor(item.listUnitPrice);
      const lineDiscountMinor = toMinor(item.lineDiscount);
      return {
        quantity: item.quantity,
        listUnitPriceMinor,
        lineDiscountMinor,
        allocatedDiscountMinor: 0,
        totalPriceMinor: listUnitPriceMinor * item.quantity - lineDiscountMinor,
        unitPriceMinor: 0,
        priceSource: item.priceSource
      };
    });

    allocateOrderDiscount(
      lines,
      this.orderLevelDiscountMinor(order.discountAmount, lines),
      // Clamped, not refused: this runs in reaction to an edit the merchant has already made,
      // and refusing here would leave them unable to remove a line. See allocateOrderDiscount.
      { clamp: true }
    );

    // Write back only the lines whose share actually moved. An order being edited has one line
    // changing and the rest standing still; updating all of them makes the row versions churn
    // for no reason and turns a two-item edit into forty writes on a large order.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const line = lines[i];
      const totalCostMinor = toMinor(item.unitCost) * item.quantity;

      const unchanged =
        toMinor(item.allocatedDiscount) === line.allocatedDiscountMinor &&
        toMinor(item.totalPrice) === line.totalPriceMinor;
      if (unchanged) continue;

      await transactionClient.salesOrderItem.update({
        where: { id: item.id },
        data: {
          allocatedDiscount: fromMinor(line.allocatedDiscountMinor),
          totalPrice: fromMinor(line.totalPriceMinor),
          unitPrice: fromMinor(netUnitPrice(line.totalPriceMinor, line.quantity)),
          grossProfit: fromMinor(line.totalPriceMinor - totalCostMinor)
        }
      });
    }

    const totals = orderTotalsFrom(lines, toMinor(order.taxAmount), toMinor(order.shippingAmount));

    return transactionClient.salesOrder.update({
      where: { id: orderId },
      data: {
        subtotal: fromMinor(totals.subtotalMinor),
        discountAmount: fromMinor(totals.discountMinor),
        total: fromMinor(totals.totalMinor)
      }
    });
  }

  async confirmOrder(clientId: string, id: string) {
    // Re-read, validate, reserve and flip status inside ONE transaction. Previously
    // reserveStock opened its own transaction and the status update was a separate
    // statement, so two concurrent confirms both saw DRAFT, both passed validateTransition
    // and both reserved -- doubling reservedQty. Cancel then released only the first row
    // (findFirst), stranding the rest as stock nobody could ever sell. It also meant a
    // failed status write left live reservations against an order still shown as DRAFT.
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findFirst({
        where: { clientId, id, deletedAt: null },
        include: { items: true }
      });

      if (!order) throw notFound("Order not found");
      validateTransition(order.status, 'CONFIRMED');

      if (order.items.length === 0) {
        throw new Error("Cannot confirm an order with no items");
      }

      const reservationItems = order.items.map((item: any) => ({
        variantId: item.variantId,
        salesOrderItemId: item.id,
        quantity: item.quantity
      }));

      await reservationService.reserveStock(clientId, order.locationId, reservationItems, tx);

      return tx.salesOrder.update({
        where: { id },
        data: { status: 'CONFIRMED' }
      });
    }, { timeout: 30000 });
  }

  async cancelOrder(clientId: string, id: string) {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, id, deletedAt: null },
      include: { items: true }
    });

    if (!order) throw notFound("Order not found");
    validateTransition(order.status, 'CANCELLED');

    // If it was confirmed, we need to release reservations
    if (order.status === 'CONFIRMED' || order.status === 'PARTIALLY_DISPATCHED') {
      for (const item of order.items) {
        await reservationService.releaseReservation(clientId, item.id);
      }
    }

    return prisma.salesOrder.update({
      where: { id },
      data: { status: 'CANCELLED' }
    });
  }
}

export const salesOrderService = new SalesOrderService();
