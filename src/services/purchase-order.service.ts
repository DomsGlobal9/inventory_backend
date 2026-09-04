import { PurchaseOrderStatus, InventoryReason, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { inventoryMutationService } from './inventory-mutation.service';

/**
 * Every rejection below carries an explicit statusCode. Thrown bare they inherited
 * errorHandler's `err.statusCode || 500`, so "you tried to receive more than you ordered"
 * came back as a 500 -- wrong semantics for a request that can never succeed on retry, and
 * errorHandler persists 5xx, so each one was written to the Platform Console's Errors page.
 * That page is for crashes; routine rejections were burying the real faults (one such entry,
 * "Cannot receive goods for PO in status ...", was visible there in production).
 */
export class PurchaseOrderService {
  async createPO(clientId: string, data: { supplierId: string; expectedDeliveryDate?: Date; notes?: string; items: { variantId: string; orderedQty: number; unitPrice: number; productTitle?: string; color?: string; size?: string }[] }) {
    // Generate PO- code
    const poNumber = await generateSequentialCode(clientId, 'PO', 'PURCHASE_ORDER');
    
    // Fetch variants to snapshot their identifiers
    const variantIds = data.items.map(i => i.variantId);
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      include: { product: true }
    });

    const variantMap = new Map(variants.map(v => [v.id, v]));

    return prisma.purchaseOrder.create({
      data: {
        clientId,
        poNumber,
        supplierId: data.supplierId,
        status: PurchaseOrderStatus.DRAFT,
        expectedDeliveryDate: data.expectedDeliveryDate,
        notes: data.notes,
        totalAmount: data.items.reduce((sum, item) => sum + (item.orderedQty * item.unitPrice), 0),
        items: {
          create: data.items.map(item => {
            const variant = variantMap.get(item.variantId);
            if (!variant) throw Object.assign(new Error(`Variant ${item.variantId} not found`), { statusCode: 404 });
            
            return {
              variantId: variant.id,
              sku: variant.sku,
              variantCode: variant.variantCode,
              barcode: variant.barcode,
              productTitle: item.productTitle || variant.product?.title || 'Unknown Product',
              color: item.color || variant.colorName,
              size: item.size || variant.size,
              orderedQty: item.orderedQty,
              unitPrice: item.unitPrice
            };
          })
        }
      },
      include: {
        items: true,
        supplier: true
      }
    });
  }

  async getPOs(clientId: string) {
    return prisma.purchaseOrder.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      include: {
        supplier: { select: { name: true, supplierCode: true } },
        _count: { select: { items: true } }
      }
    });
  }

  async getPOById(clientId: string, id: string) {
    return prisma.purchaseOrder.findFirst({
      where: { id, clientId },
      include: {
        supplier: true,
        items: {
          include: {
            variant: {
              select: {
                stocks: { select: { quantity: true } },
                product: {
                  select: { title: true }
                },
                // Needed so a reopened Draft PO can still show the margin warning --
                // previously omitted, which silently disabled it for anything but a
                // brand-new PO (see PurchaseOrderDetails.jsx's getMarginWarning).
                sellingPrice: true,
                averageCost: true
              }
            }
          }
        }
      }
    });
  }

  async updatePOStatus(clientId: string, id: string, status: PurchaseOrderStatus) {
    return prisma.$transaction(async (tx) => {
      // Scope the lookup by clientId too — otherwise a caller could pass another
      // tenant's PO id and corrupt that tenant's supplier counters below even
      // though the final update (correctly scoped) would go on to 404.
      const po = await tx.purchaseOrder.findFirst({ where: { id, clientId }, select: { supplierId: true } });
      if (!po) throw Object.assign(new Error('Purchase Order not found'), { statusCode: 404 });

      // If sent, we might want to update the supplier's last order date & total orders
      if (status === PurchaseOrderStatus.SENT) {
        await tx.supplier.update({
          where: { id: po.supplierId },
          data: {
            lastOrderDate: new Date(),
            totalOrders: { increment: 1 }
          }
        });
      }

      return tx.purchaseOrder.update({
        where: { id, clientId },
        data: { status }
      });
    });
  }

  async receiveGoods(clientId: string, id: string, receipts: { poItemId: string; quantityReceived: number; locationId?: string }[]) {
    // Wrap the entire receive logic in a transaction
    return await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findFirst({
        where: { id, clientId },
        include: { items: true }
      });

      if (!po) throw Object.assign(new Error('Purchase Order not found'), { statusCode: 404 });
      if (po.status === PurchaseOrderStatus.RECEIVED || po.status === PurchaseOrderStatus.CANCELLED) {
        throw Object.assign(new Error(`Cannot receive goods for PO in status ${po.status}`), { statusCode: 400 });
      }

      const itemMap = new Map(po.items.map(i => [i.id, i]));
      const now = new Date();

      for (const receipt of receipts) {
        if (receipt.quantityReceived <= 0) continue;

        // itemMap is built from THIS po's items; without this check the findUnique below
        // matched a line on any other PO in the tenant and booked the receipt -- and the
        // resulting stock/lastPurchaseCost writes -- against that unrelated PO instead.
        if (!itemMap.has(receipt.poItemId)) {
          throw Object.assign(new Error(`PO Item ${receipt.poItemId} does not belong to this purchase order`), { statusCode: 400 });
        }

        const currentPoItem = await tx.purchaseOrderItem.findUnique({ where: { id: receipt.poItemId } });
        if (!currentPoItem) throw Object.assign(new Error(`PO Item ${receipt.poItemId} not found`), { statusCode: 404 });

        if (currentPoItem.receivedQty + receipt.quantityReceived > currentPoItem.orderedQty) {
          throw Object.assign(new Error(`Cannot receive more than remaining quantity for SKU ${currentPoItem.sku}`), { statusCode: 400 });
        }

        // 1. Update PO Item atomically
        const poItem = await tx.purchaseOrderItem.update({
          where: { id: receipt.poItemId },
          data: {
            receivedQty: { increment: receipt.quantityReceived },
            lastReceivedAt: now
          }
        });

        // Atomic double-check
        if (poItem.receivedQty > poItem.orderedQty) {
          throw Object.assign(new Error(`Cannot receive more than remaining quantity for SKU ${poItem.sku}`), { statusCode: 400 });
        }

        // 2. Adjust Inventory atomically with WAC Calculation using central mutation service
        let targetLocationId = receipt.locationId;
        if (!targetLocationId) {
          const defaultLoc = await tx.stockLocation.findFirst({ where: { clientId } });
          targetLocationId = defaultLoc?.id;
        }
        
        await inventoryMutationService.applyMovement({
          clientId,
          locationId: targetLocationId!,
          variantId: poItem.variantId,
          movementType: 'IN',
          reason: InventoryReason.PURCHASE_RECEIPT,
          quantityDelta: receipt.quantityReceived,
          unitCost: Number(poItem.unitPrice),
          referenceType: 'PO',
          referenceId: po.poNumber,
          notes: 'PO Receipt',
          createdBy: 'Admin',
          tx
        });

        // applyMovement above already blends this into averageCost; lastPurchaseCost is
        // a separate, simpler field -- "what did the last PO actually charge", not a
        // blended figure -- and was never being written anywhere despite existing on
        // the schema and being exposed in variant API responses.
        await tx.productVariant.update({
          where: { id: poItem.variantId },
          data: { lastPurchaseCost: poItem.unitPrice }
        });
      }

      // Determine new PO Status
      // Re-fetch items to get the most updated received quantities
      const updatedItems = await tx.purchaseOrderItem.findMany({ where: { poId: id } });
      const isFullyReceived = updatedItems.every(i => i.receivedQty >= i.orderedQty);
      const isPartiallyReceived = updatedItems.some(i => i.receivedQty > 0);

      let newStatus: PurchaseOrderStatus = po.status;
      let receivedAt = po.receivedAt;
      
      if (isFullyReceived) {
        newStatus = PurchaseOrderStatus.RECEIVED;
        receivedAt = now;
      } else if (isPartiallyReceived) {
        newStatus = PurchaseOrderStatus.PARTIALLY_RECEIVED;
      }

      return await tx.purchaseOrder.update({
        where: { id },
        data: {
          status: newStatus,
          receivedAt
        },
        include: {
          items: true
        }
      });
    }, {
      timeout: 30000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  }
}

export const purchaseOrderService = new PurchaseOrderService();
