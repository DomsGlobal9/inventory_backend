import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { notFound, conflict } from '../utils/httpError';

/** "  Surat  Silk Mills " and "surat silk mills" are the same supplier to a person. */
const tidyName = (name: string) => name.trim().replace(/\s+/g, ' ');
const nameKey = (name: string) => tidyName(name).toLowerCase();

/**
 * Refuses a name another supplier of this shop already has, locked for the rest of the transaction.
 *
 * Two suppliers called the same thing were saved without a word, and the purchase order picker
 * then listed "Surat Silk Mills" twice with nothing to tell them apart -- orders, spend and the
 * preferred-supplier star split across two records of one business. There is no unique index on
 * the name (and no schema change for one), so the lock is what stops two people adding the same
 * supplier at the same moment.
 */
async function refuseTakenName(tx: Prisma.TransactionClient, clientId: string, name: string, exceptId?: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-name:${clientId}`}))`;
  const others = await tx.supplier.findMany({
    where: { clientId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true, supplierCode: true, isActive: true }
  });
  const key = nameKey(name);
  const same = others.find(s => nameKey(s.name) === key);
  if (same) {
    throw conflict(same.isActive
      ? `${same.name} is already a supplier (${same.supplierCode}). Use that one, or give this one a different name.`
      : `${same.name} is already a supplier (${same.supplierCode}), switched off. Switch it back on instead, or give this one a different name.`);
  }
}

/** Four round trips at about a second each: Prisma's 5-second default is too tight. */
const SLOW_DB = { maxWait: 15000, timeout: 30000 };

export class SupplierService {
  async createSupplier(clientId: string, data: { name: string; email?: string; phone?: string; address?: string }) {
    const name = tidyName(data.name);
    return prisma.$transaction(async (tx) => {
      await refuseTakenName(tx, clientId, name);
      // Numbered after the name check, so a refused supplier uses no number.
      const supplierCode = await generateSequentialCode(clientId, 'SUP', 'SUPPLIER', tx as any);
      return tx.supplier.create({
        data: {
          clientId,
          supplierCode,
          ...data,
          name,
        },
      });
    }, SLOW_DB);
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
    if (data.name === undefined) {
      return prisma.supplier.update({ where: { id, clientId }, data });
    }
    const name = tidyName(data.name);
    return prisma.$transaction(async (tx) => {
      // The edit form sends the name with every save. Only a real rename is checked: a shop that
      // already had two suppliers of one name (from before this rule) must still be able to fix
      // a phone number on either of them.
      const current = await tx.supplier.findFirst({ where: { id, clientId }, select: { name: true } });
      if (!current) throw notFound('Supplier not found');
      if (nameKey(current.name) !== nameKey(name)) await refuseTakenName(tx, clientId, name, id);
      return tx.supplier.update({ where: { id, clientId }, data: { ...data, name } });
    }, SLOW_DB);
  }

  async deleteSupplier(clientId: string, id: string) {
    const supplier = await prisma.supplier.findUnique({ 
      where: { id, clientId },
      include: { purchaseOrders: true } 
    });
    
    if (!supplier) throw notFound("Supplier not found");
    
    if (supplier.purchaseOrders.length > 0) {
      throw new Error("Cannot delete supplier with historical purchase orders. Deactivate instead.");
    }

    return prisma.supplier.delete({
      where: { id, clientId }
    });
  }
}

export const supplierService = new SupplierService();
