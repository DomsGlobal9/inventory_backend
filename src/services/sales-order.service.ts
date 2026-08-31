import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { validateTransition } from '../utils/sales-order-state-machine';
import { reservationService } from './reservation.service';
import { resolveVariantForLocation } from '../utils/variant-location';

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
          const customerCode = await generateSequentialCode(clientId, 'CUS', 'CUSTOMER');
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

      let subtotal = 0;
      const reservationItems = [];

      for (const item of data.items) {
        const variant = await tx.productVariant.findFirst({ 
          where: { id: item.variantId, clientId },
          include: { locationProfiles: true }
        });
        if (!variant) throw new Error(`Variant not found: ${item.variantId}`);

        const locationConfig = resolveVariantForLocation(variant, locationId);
        
        if (!locationConfig.isAvailable) {
          throw new Error(`Variant ${variant.sku} is not available for sale at this location`);
        }

        const unitPrice = locationConfig.price || 0;
        const unitCost = Number(variant.averageCost);
        const totalPrice = unitPrice * item.quantity;
        const totalCost = unitCost * item.quantity;
        const grossProfit = totalPrice - totalCost;

        const orderItem = await tx.salesOrderItem.create({
          data: {
            salesOrderId: order.id,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPrice,
            unitCost,
            totalPrice,
            totalCost,
            grossProfit
          }
        });

        subtotal += totalPrice;
        reservationItems.push({
          variantId: item.variantId,
          salesOrderItemId: orderItem.id,
          quantity: item.quantity
        });
      }

      const total = subtotal 
        - Number(order.discountAmount) 
        + Number(order.taxAmount) 
        + Number(order.shippingAmount);
      
      const updatedOrder = await tx.salesOrder.update({
        where: { id: order.id },
        data: {
          subtotal,
          total,
          status: data.status === 'CONFIRMED' ? 'CONFIRMED' : 'DRAFT'
        },
        include: { items: true, customer: true }
      });

      if (data.status === 'CONFIRMED' && reservationItems.length > 0) {
        await reservationService.reserveStock(clientId, locationId, reservationItems, tx);
      }

      return updatedOrder;
    });
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
    if (!order) throw new Error('Order not found');
    return order;
  }

  async updateOrder(clientId: string, id: string, data: any) {
    // Basic update for shipping, discount, tax (for Draft orders)
    const order = await prisma.salesOrder.findFirst({ where: { clientId, id } });
    if (!order) throw new Error('Order not found');
    
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
    if (!order) throw new Error('Order not found');
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

      const variant = await tx.productVariant.findFirst({ where: { id: variantId, clientId } });
      if (!variant) throw new Error('Variant not found');

      const unitPrice = variant.sellingPrice ? Number(variant.sellingPrice) : 0;
      const unitCost = Number(variant.averageCost);
      const totalPrice = unitPrice * quantity;
      const totalCost = unitCost * quantity;
      const grossProfit = totalPrice - totalCost;

      const item = await tx.salesOrderItem.create({
        data: {
          salesOrderId: orderId,
          variantId,
          quantity,
          unitPrice,
          unitCost,
          totalPrice,
          totalCost,
          grossProfit
        }
      });

      await this.recalculateOrderTotals(clientId, orderId, tx);
      return item;
    });
  }

  async removeOrderItem(clientId: string, orderId: string, itemId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findFirst({ where: { id: orderId, clientId, deletedAt: null } });
      if (!order || order.status !== 'DRAFT') throw new Error('Cannot remove items from non-DRAFT order');

      await tx.salesOrderItem.delete({
        where: { id: itemId }
      });

      await this.recalculateOrderTotals(clientId, orderId, tx);
    });
  }

  private async recalculateOrderTotals(clientId: string, orderId: string, transactionClient: any = prisma) {
    const items = await transactionClient.salesOrderItem.findMany({
      where: { salesOrderId: orderId }
    });

    const subtotal = items.reduce((sum: number, item: any) => sum + Number(item.totalPrice), 0);

    const order = await transactionClient.salesOrder.findUnique({ where: { id: orderId } });
    const total = subtotal 
      - Number(order.discountAmount) 
      + Number(order.taxAmount) 
      + Number(order.shippingAmount);

    return transactionClient.salesOrder.update({
      where: { id: orderId },
      data: {
        subtotal,
        total
      }
    });
  }

  async confirmOrder(clientId: string, id: string) {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, id, deletedAt: null },
      include: { items: true }
    });

    if (!order) throw new Error("Order not found");
    validateTransition(order.status, 'CONFIRMED');

    if (order.items.length === 0) {
      throw new Error("Cannot confirm an order with no items");
    }

    // Attempt to reserve stock
    const reservationItems = order.items.map((item: any) => ({
      variantId: item.variantId,
      salesOrderItemId: item.id,
      quantity: item.quantity
    }));

    await reservationService.reserveStock(clientId, order.locationId, reservationItems);

    return prisma.salesOrder.update({
      where: { id },
      data: { status: 'CONFIRMED' }
    });
  }

  async cancelOrder(clientId: string, id: string) {
    const order = await prisma.salesOrder.findFirst({
      where: { clientId, id, deletedAt: null },
      include: { items: true }
    });

    if (!order) throw new Error("Order not found");
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
