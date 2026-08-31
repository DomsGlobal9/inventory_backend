import { PurchaseOrderStatus, InventoryReason } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { inventoryMutationService } from './inventory-mutation.service';

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
            if (!variant) throw new Error(`Variant ${item.variantId} not found`);
            
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
                }
              }
            }
          }
        }
      }
    });
  }

  async updatePOStatus(clientId: string, id: string, status: PurchaseOrderStatus) {
    // If sent, we might want to update the supplier's last order date & total orders
    if (status === PurchaseOrderStatus.SENT) {
      const po = await prisma.purchaseOrder.findUnique({ where: { id }, select: { supplierId: true } });
      if (po) {
        await prisma.supplier.update({
          where: { id: po.supplierId },
          data: {
            lastOrderDate: new Date(),
            totalOrders: { increment: 1 }
          }
        });
      }
    }

    return prisma.purchaseOrder.update({
      where: { id, clientId },
      data: { status }
    });
  }

  async receiveGoods(clientId: string, id: string, receipts: { poItemId: string; quantityReceived: number }[]) {
    // Wrap the entire receive logic in a transaction
    return await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findFirst({
        where: { id, clientId },
        include: { items: true }
      });

      if (!po) throw new Error('Purchase Order not found');
      if (po.status === PurchaseOrderStatus.RECEIVED || po.status === PurchaseOrderStatus.CANCELLED) {
        throw new Error(`Cannot receive goods for PO in status ${po.status}`);
      }

      const itemMap = new Map(po.items.map(i => [i.id, i]));
      const now = new Date();

      for (const receipt of receipts) {
        if (receipt.quantityReceived <= 0) continue;

        const currentPoItem = await tx.purchaseOrderItem.findUnique({ where: { id: receipt.poItemId } });
        if (!currentPoItem) throw new Error(`PO Item ${receipt.poItemId} not found`);

        if (currentPoItem.receivedQty + receipt.quantityReceived > currentPoItem.orderedQty) {
          throw new Error(`Cannot receive more than remaining quantity for SKU ${currentPoItem.sku}`);
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
          throw new Error(`Cannot receive more than remaining quantity for SKU ${poItem.sku}`);
        }

        // 2. Adjust Inventory atomically with WAC Calculation using central mutation service
        // Get default location
        const defaultLoc = await tx.stockLocation.findFirst({ where: { clientId, code: 'MAIN-STORE' } });
        
        await inventoryMutationService.applyMovement({
          clientId,
          locationId: defaultLoc!.id,
          variantId: poItem.variantId,
          movementType: 'IN',
          reason: InventoryReason.PURCHASE_RECEIPT,
          quantityDelta: receipt.quantityReceived,
          unitCost: Number(poItem.unitPrice),
          referenceType: 'PO',
          referenceId: po.poNumber,
          notes: 'PO Receipt',
          createdBy: 'Admin'
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
      timeout: 15000
    });
  }
}

export const purchaseOrderService = new PurchaseOrderService();
