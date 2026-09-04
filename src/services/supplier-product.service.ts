import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * The supplier <-> item catalogue.
 *
 * Before this existed, Supplier was reachable only through PurchaseOrder, so raising an
 * order meant searching the entire product catalogue with nothing to say which items that
 * vendor actually sells, and "who supplies this?" had no answer anywhere in the product.
 */
export class SupplierProductService {
  /**
   * Confirms the supplier and variant both belong to the calling tenant.
   *
   * Both ids arrive from the client. Without this a caller could link one of their own
   * suppliers to another tenant's variant -- the row would carry their clientId and so pass
   * every later scoped read, quietly leaking the other tenant's product into their catalogue.
   */
  private async assertOwnership(clientId: string, supplierId: string, variantId: string) {
    const [supplier, variant] = await Promise.all([
      prisma.supplier.findFirst({ where: { id: supplierId, clientId }, select: { id: true } }),
      prisma.productVariant.findFirst({ where: { id: variantId, clientId }, select: { id: true } })
    ]);

    if (!supplier) {
      throw Object.assign(new Error('Supplier not found.'), { statusCode: 404 });
    }
    if (!variant) {
      throw Object.assign(new Error('Product variant not found.'), { statusCode: 404 });
    }
  }

  /**
   * Creates or updates the link. Upsert rather than create because re-linking an item a
   * supplier already sells is a terms change, not a second relationship -- the unique
   * constraint would reject it and the user would see a duplicate-key error for what is a
   * perfectly ordinary edit.
   */
  async link(
    clientId: string,
    data: {
      supplierId: string;
      variantId: string;
      supplierSku?: string | null;
      costPrice?: number | null;
      leadTimeDays?: number | null;
      minOrderQty?: number | null;
      isPreferred?: boolean;
      notes?: string | null;
    },
    userId?: string
  ) {
    await this.assertOwnership(clientId, data.supplierId, data.variantId);

    const fields = {
      supplierSku: data.supplierSku?.trim() || null,
      costPrice: data.costPrice ?? null,
      leadTimeDays: data.leadTimeDays ?? null,
      minOrderQty: data.minOrderQty ?? null,
      notes: data.notes?.trim() || null
    };

    return prisma.$transaction(async (tx) => {
      // One read for every link on this variant, rather than a findUnique plus a count.
      // Round trips are the cost that matters here: against the pooled database each is
      // ~1.3s, and four of them inside a transaction exceeded Prisma's 5s default and threw
      // "Transaction already closed" before any write landed.
      const siblings = await tx.supplierProduct.findMany({
        where: { clientId, variantId: data.variantId },
        select: { supplierId: true, isPreferred: true }
      });

      const existing = siblings.find(link => link.supplierId === data.supplierId);

      // The first supplier recorded for an item becomes its default. Leaving every link
      // unpreferred would mean nothing could ever be reordered automatically until someone
      // remembered to tick a box.
      const isPreferred = data.isPreferred ?? (existing?.isPreferred || siblings.length === 0);

      // Exclusivity is applied inside the same transaction as the write, or two concurrent
      // "make this preferred" calls could both clear and both set, leaving the variant with
      // two preferred suppliers and an auto-generated PO with no single source. Skipped
      // when nothing currently holds it, to save a round trip.
      if (isPreferred && siblings.some(link => link.isPreferred && link.supplierId !== data.supplierId)) {
        await tx.supplierProduct.updateMany({
          where: { clientId, variantId: data.variantId, isPreferred: true },
          data: { isPreferred: false }
        });
      }

      return tx.supplierProduct.upsert({
        where: { uq_supplier_variant: { supplierId: data.supplierId, variantId: data.variantId } },
        create: {
          clientId,
          supplierId: data.supplierId,
          variantId: data.variantId,
          ...fields,
          isPreferred,
          createdBy: userId,
          updatedBy: userId
        },
        update: { ...fields, isPreferred, updatedBy: userId },
        include: {
          supplier: { select: { id: true, name: true, supplierCode: true, phone: true, email: true } },
          variant: { select: { id: true, sku: true, size: true, colorName: true, product: { select: { title: true } } } }
        }
      });
    }, {
      // Sized for this database's latency rather than Prisma's 5s default, which two or
      // three sequential queries can exceed on their own here.
      maxWait: 15000,
      timeout: 30000
    });
  }

  async unlink(clientId: string, id: string) {
    const link = await prisma.supplierProduct.findFirst({ where: { id, clientId }, select: { id: true } });
    if (!link) throw Object.assign(new Error('Supplier link not found.'), { statusCode: 404 });
    await prisma.supplierProduct.delete({ where: { id } });
    return { id };
  }

  /** Everything a supplier sells -- powers their page and filters the PO item picker. */
  async listBySupplier(clientId: string, supplierId: string, search?: string) {
    const where: Prisma.SupplierProductWhereInput = { clientId, supplierId };

    if (search?.trim()) {
      const q = search.trim();
      where.variant = {
        OR: [
          { sku: { contains: q, mode: 'insensitive' } },
          { barcode: { contains: q, mode: 'insensitive' } },
          { product: { title: { contains: q, mode: 'insensitive' } } }
        ]
      };
    }

    return prisma.supplierProduct.findMany({
      where,
      orderBy: [{ isPreferred: 'desc' }, { createdAt: 'desc' }],
      include: {
        variant: {
          select: {
            id: true, sku: true, size: true, colorName: true, barcode: true,
            averageCost: true, reorderLevel: true, reorderQty: true,
            product: { select: { id: true, title: true } },
            stocks: { select: { quantity: true } }
          }
        }
      }
    });
  }

  /** Every supplier for one item -- answers "who do we buy this from?" and compares prices. */
  async listByVariant(clientId: string, variantId: string) {
    return prisma.supplierProduct.findMany({
      where: { clientId, variantId },
      orderBy: [{ isPreferred: 'desc' }, { costPrice: 'asc' }],
      include: {
        supplier: {
          select: { id: true, name: true, supplierCode: true, phone: true, email: true, isActive: true }
        }
      }
    });
  }

  /** Marks one supplier as the default source, clearing whichever held it before. */
  async setPreferred(clientId: string, id: string, userId?: string) {
    const link = await prisma.supplierProduct.findFirst({
      where: { id, clientId },
      select: { id: true, variantId: true }
    });
    if (!link) throw Object.assign(new Error('Supplier link not found.'), { statusCode: 404 });

    return prisma.$transaction(async (tx) => {
      await tx.supplierProduct.updateMany({
        where: { clientId, variantId: link.variantId, isPreferred: true },
        data: { isPreferred: false }
      });
      return tx.supplierProduct.update({
        where: { id },
        data: { isPreferred: true, updatedBy: userId }
      });
    }, { maxWait: 15000, timeout: 30000 });
  }

  /**
   * Reconstructs the supplier catalogue from purchase history.
   *
   * The relationship has always been present in the data -- a PO carries a supplier and its
   * items carry variants -- just not as anything queryable. Without this the new table
   * starts empty and every existing customer sees the feature as broken until they hand-link
   * a catalogue they have already been buying from for months.
   *
   * The most recent purchase wins the preferred slot, and its unit price seeds costPrice as
   * the best available estimate of what that vendor charges.
   */
  async backfillFromPurchaseHistory(clientId?: string, apply = false) {
    const items = await prisma.purchaseOrderItem.findMany({
      where: clientId ? { po: { clientId } } : undefined,
      select: {
        variantId: true,
        unitPrice: true,
        createdAt: true,
        po: { select: { clientId: true, supplierId: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Last write wins, so iterating oldest-first leaves the most recent price and date.
    const pairs = new Map<string, {
      clientId: string; supplierId: string; variantId: string;
      costPrice: number; purchasedAt: Date;
    }>();

    for (const item of items) {
      const key = `${item.po.supplierId}|${item.variantId}`;
      pairs.set(key, {
        clientId: item.po.clientId,
        supplierId: item.po.supplierId,
        variantId: item.variantId,
        costPrice: Number(item.unitPrice),
        purchasedAt: item.createdAt
      });
    }

    // Only variants still present can be linked; history outlives deleted products.
    const variantIds = [...new Set([...pairs.values()].map(p => p.variantId))];
    const liveVariants = new Set(
      (await prisma.productVariant.findMany({
        where: { id: { in: variantIds } }, select: { id: true }
      })).map(v => v.id)
    );

    const candidates = [...pairs.values()].filter(p => liveVariants.has(p.variantId));

    const existing = new Set(
      (await prisma.supplierProduct.findMany({ select: { supplierId: true, variantId: true } }))
        .map(l => `${l.supplierId}|${l.variantId}`)
    );
    const toCreate = candidates.filter(p => !existing.has(`${p.supplierId}|${p.variantId}`));

    // Most recently purchased source per variant becomes preferred, but only where the
    // variant has no preferred link already -- a choice made by hand outranks history.
    const alreadyPreferred = new Set(
      (await prisma.supplierProduct.findMany({
        where: { isPreferred: true }, select: { variantId: true }
      })).map(l => l.variantId)
    );

    const newestPerVariant = new Map<string, string>();
    for (const p of [...candidates].sort((a, b) => a.purchasedAt.getTime() - b.purchasedAt.getTime())) {
      newestPerVariant.set(p.variantId, p.supplierId);
    }

    if (!apply) {
      return { scanned: items.length, wouldCreate: toCreate.length, alreadyLinked: candidates.length - toCreate.length, applied: false };
    }

    let created = 0;
    for (const p of toCreate) {
      await prisma.supplierProduct.create({
        data: {
          clientId: p.clientId,
          supplierId: p.supplierId,
          variantId: p.variantId,
          costPrice: p.costPrice,
          isPreferred: !alreadyPreferred.has(p.variantId) && newestPerVariant.get(p.variantId) === p.supplierId,
          notes: 'Linked automatically from purchase history.'
        }
      });
      created++;
    }

    return { scanned: items.length, created, alreadyLinked: candidates.length - toCreate.length, applied: true };
  }
}

export const supplierProductService = new SupplierProductService();
