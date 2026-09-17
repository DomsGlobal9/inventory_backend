import { ShelfIssueStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { conflict, notFound } from '../../utils/httpError';

/**
 * Shelf issues: what the shelf rule could not do cleanly, kept in front of the shop until someone
 * has looked. Resolving one records who and why; it never changes stock -- a recount or a move does.
 */
export const shelfIssueService = {
  async list(clientId: string, query: { status?: unknown; locationId?: unknown; page?: unknown }) {
    const status = query.status === 'RESOLVED' ? ShelfIssueStatus.RESOLVED : query.status === 'ALL' ? undefined : ShelfIssueStatus.OPEN;
    const locationId = typeof query.locationId === 'string' && query.locationId ? query.locationId : undefined;
    const page = Math.max(1, Math.min(10_000, Number.parseInt(String(query.page ?? '1'), 10) || 1));
    const size = 50;
    const where = { clientId, ...(status ? { status } : {}), ...(locationId ? { locationId } : {}) };
    const [rows, total, open] = await Promise.all([
      prisma.shelfIssue.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * size,
        take: size,
        include: {
          location: { select: { id: true, name: true } },
          variant: { select: { id: true, sku: true, size: true, colorName: true, product: { select: { title: true } } } },
          spot: { select: { id: true, address: true, name: true } }
        }
      }),
      prisma.shelfIssue.count({ where }),
      prisma.shelfIssue.count({ where: { clientId, status: 'OPEN', ...(locationId ? { locationId } : {}) } })
    ]);
    return {
      issues: rows.map(i => ({
        id: i.id, kind: i.kind, status: i.status, quantity: i.quantity, message: i.message, createdAt: i.createdAt,
        // The address it had when this happened, and where that shelf is now if it still exists.
        address: i.address, spot: i.spot, location: i.location,
        item: { variantId: i.variant.id, title: i.variant.product.title, sku: i.variant.sku, size: i.variant.size, colorName: i.variant.colorName },
        resolvedAt: i.resolvedAt, resolvedBy: i.resolvedBy, resolutionNote: i.resolutionNote
      })),
      total, open, page, pages: Math.max(1, Math.ceil(total / size))
    };
  },

  async resolve(clientId: string, issueId: string, userId: string | null, note?: string | null) {
    const issue = await prisma.shelfIssue.findFirst({ where: { id: issueId, clientId }, select: { id: true, status: true } });
    if (!issue) throw notFound('That shelf issue was not found.');
    // Conditional, so two people pressing Resolve at once record one resolution, not two.
    const updated = await prisma.shelfIssue.updateMany({
      where: { id: issueId, clientId, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: userId, resolutionNote: note?.trim() || null }
    });
    if (updated.count === 0) throw conflict('Somebody has already marked this as resolved.');
    return prisma.shelfIssue.findUniqueOrThrow({ where: { id: issueId } });
  }
};
