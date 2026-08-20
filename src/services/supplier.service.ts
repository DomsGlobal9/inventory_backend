import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';

export class SupplierService {
  async createSupplier(clientId: string, data: { name: string; email?: string; phone?: string; address?: string }) {
    // Generate SUP- code
    const supplierCode = await generateSequentialCode(clientId, 'SUP', 'SUPPLIER');

    return prisma.supplier.create({
      data: {
        clientId,
        supplierCode,
        ...data,
      },
    });
  }

  async getSuppliers(clientId: string) {
    return prisma.supplier.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { purchaseOrders: true } }
      }
    });
  }

  async getSupplierById(clientId: string, id: string) {
    const supplier = await prisma.supplier.findFirst({
      where: { id, clientId },
      include: {
        purchaseOrders: {
          orderBy: { createdAt: 'desc' },
          take: 20
        },
        _count: {
          select: { purchaseOrders: true }
        }
      }
    });

    if (!supplier) return null;

    // Calculate aggregates
    const allPos = await prisma.purchaseOrder.findMany({
      where: { supplierId: id, clientId }
    });

    const openOrders = allPos.filter(po => ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status)).length;
    const totalSpend = allPos.reduce((sum, po) => sum + Number(po.totalAmount || 0), 0);
    const lastOrderDate = allPos.length > 0 ? allPos.reduce((latest, po) => po.createdAt > latest ? po.createdAt : latest, new Date(0)) : null;

    return {
      ...supplier,
      metrics: {
        openOrders,
        totalSpend,
        lastOrderDate,
        totalOrders: allPos.length
      }
    };
  }

  async updateSupplier(clientId: string, id: string, data: { name?: string; email?: string; phone?: string; address?: string; isActive?: boolean }) {
    return prisma.supplier.update({
      where: { id, clientId },
      data,
    });
  }

  async deleteSupplier(clientId: string, id: string) {
    const supplier = await prisma.supplier.findUnique({ 
      where: { id, clientId },
      include: { purchaseOrders: true } 
    });
    
    if (!supplier) throw new Error("Supplier not found");
    
    if (supplier.purchaseOrders.length > 0) {
      throw new Error("Cannot delete supplier with historical purchase orders. Deactivate instead.");
    }

    return prisma.supplier.delete({
      where: { id, clientId }
    });
  }
}

export const supplierService = new SupplierService();
