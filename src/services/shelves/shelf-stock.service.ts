import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { literal } from '../../utils/likeText';
import { badRequest, notFound } from '../../utils/httpError';
import { inventoryMutationService } from '../inventory-mutation.service';
import { compareWalk, walkKeys } from './addresses';
import { MoveInput } from './shelf.schema';

/**
 * Stock on shelves: where an item is, what a shelf holds, what is waiting to be put away, and moving
 * pieces. Every change goes through applyMovement as a SHELF_MOVE, so it is locked, ledgered and held
 * to the shelf rule exactly like a sale.
 */

const LIMIT = 20;
const pieces = (n: number) => `${n} ${n === 1 ? 'piece' : 'pieces'}`;

const variantSelect = {
  id: true, sku: true, variantCode: true, barcode: true, colorName: true, hexCode: true, size: true, clientId: true,
  product: {
    select: {
      id: true, title: true, productCode: true, status: true, trashedAt: true,
      images: { where: { variantId: null }, orderBy: [{ isPrimary: 'desc' as const }, { orderIndex: 'asc' as const }], take: 1, select: { url: true } }
    }
  },
  images: { orderBy: [{ isPrimary: 'desc' as const }, { orderIndex: 'asc' as const }], take: 1, select: { url: true } }
};

type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;

const describe = (v: VariantRow) => ({
  variantId: v.id,
  productId: v.product.id,
  title: v.product.title,
  productCode: v.product.productCode,
  sku: v.sku,
  code: v.variantCode,
  barcode: v.barcode,
  colorName: v.colorName,
  hexCode: v.hexCode,
  size: v.size,
  imageUrl: v.images[0]?.url ?? v.product.images[0]?.url ?? null,
  // Still found, and marked: pieces of a retired product are still somewhere on a shelf.
  archived: v.product.status === 'ARCHIVED' || v.product.status === 'TRASHED' || !!v.product.trashedAt
});

async function findVariants(clientId: string, q: string): Promise<VariantRow[]> {
  const exact = await prisma.productVariant.findMany({
    where: {
      clientId,
      OR: [
        { barcode: q },
        { sku: { equals: literal(q), mode: 'insensitive' } },
        { variantCode: { equals: literal(q), mode: 'insensitive' } }
      ]
    },
    select: variantSelect,
    take: 5
  });
  if (exact.length > 0) return exact;

  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  return prisma.productVariant.findMany({
    where: {
      clientId,
      AND: words.map(word => ({
        OR: [
          { product: { title: { contains: literal(word), mode: 'insensitive' as const } } },
          { product: { productCode: { contains: literal(word), mode: 'insensitive' as const } } },
          { sku: { contains: literal(word), mode: 'insensitive' as const } },
          { variantCode: { contains: literal(word), mode: 'insensitive' as const } },
          { colorName: { contains: literal(word), mode: 'insensitive' as const } },
          { size: { equals: literal(word), mode: 'insensitive' as const } }
        ]
      }))
    },
    select: variantSelect,
    orderBy: [{ product: { title: 'asc' } }, { sku: 'asc' }],
    take: LIMIT
  });
}

/** For each variant, at each location (or the one asked): the official count, every shelf, Not shelved. */
async function whereFor(clientId: string, variants: VariantRow[], locationId?: string) {
  if (variants.length === 0) return [];
  const ids = variants.map(v => v.id);
  const [stocks, shelfStock] = await Promise.all([
    prisma.inventoryStock.findMany({
      where: { clientId, variantId: { in: ids }, ...(locationId ? { locationId } : {}) },
      select: { variantId: true, locationId: true, quantity: true, reservedQty: true, location: { select: { name: true, code: true, active: true } } }
    }),
    prisma.spotStock.findMany({
      where: { clientId, variantId: { in: ids }, ...(locationId ? { locationId } : {}) },
      select: { variantId: true, locationId: true, spotId: true, quantity: true }
    })
  ]);

  const locationIds = [...new Set([...stocks.map(s => s.locationId), ...shelfStock.map(s => s.locationId)])];
  const spots = locationIds.length
    ? await prisma.storageSpot.findMany({ where: { clientId, locationId: { in: locationIds } } })
    : [];
  const keys = walkKeys(spots);
  const spotById = new Map(spots.map(s => [s.id, s]));
  const locationsWithShelves = new Set(spots.map(s => s.locationId));

  return variants.map(v => {
    const places = stocks
      .filter(s => s.variantId === v.id && (s.quantity > 0 || shelfStock.some(x => x.variantId === v.id && x.locationId === s.locationId)))
      .map(s => {
        const shelves = shelfStock
          .filter(x => x.variantId === v.id && x.locationId === s.locationId)
          .map(x => {
            const spot = spotById.get(x.spotId)!;
            return {
              spotId: spot.id, address: spot.address, name: spot.name, kind: spot.kind, colour: spot.colour,
              isShopFloor: spot.isShopFloor, labelCode: spot.labelCode, quantity: x.quantity,
              walkKey: keys.get(spot.id) ?? []
            };
          })
          .sort(compareWalk)
          .map(({ walkKey, ...rest }) => rest);
        const onShelves = shelves.reduce((t, x) => t + x.quantity, 0);
        return {
          locationId: s.locationId,
          location: s.location.name,
          locationCode: s.location.code,
          total: s.quantity,
          held: s.reservedQty,
          usesShelves: locationsWithShelves.has(s.locationId),
          shelves,
          onShelves,
          notShelved: Math.max(0, s.quantity - onShelves)
        };
      });
    return { ...describe(v), places };
  });
}

async function capacityWarning(spotId: string) {
  const spot = await prisma.storageSpot.findUnique({ where: { id: spotId }, select: { capacity: true, address: true } });
  if (!spot?.capacity) return null;
  const onIt = await prisma.spotStock.aggregate({ where: { spotId }, _sum: { quantity: true } });
  const total = onIt._sum.quantity ?? 0;
  return total > spot.capacity
    ? `${spot.address} now holds ${pieces(total)}, more than the ${spot.capacity} it is meant for.`
    : null;
}

export const shelfStockService = {
  /** "Where is it?" by a scan, a code or words. */
  async find(clientId: string, rawQuery: unknown, locationId?: string) {
    const q = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 80) : '';
    if (!q) return { items: [] };
    if (locationId) {
      const location = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true } });
      if (!location) throw notFound('That location was not found.');
    }
    const variants = await findVariants(clientId, q);
    return { items: await whereFor(clientId, variants, locationId) };
  },

  async whereIs(clientId: string, variantId: string, locationId?: string) {
    const variant = await prisma.productVariant.findFirst({ where: { id: variantId, clientId }, select: variantSelect });
    if (!variant) throw notFound('That item was not found.');
    if (locationId) {
      const location = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true } });
      if (!location) throw notFound('That location was not found.');
    }
    const [item] = await whereFor(clientId, [variant], locationId);
    return item;
  },

  /** What is on one shelf. */
  async onSpot(clientId: string, spotId: string) {
    const spot = await prisma.storageSpot.findFirst({
      where: { id: spotId, clientId },
      include: { location: { select: { id: true, name: true } }, _count: { select: { children: true } } }
    });
    if (!spot) throw notFound('That shelf was not found.');
    const rows = await prisma.spotStock.findMany({
      where: { clientId, spotId },
      select: { quantity: true, variant: { select: variantSelect } },
      orderBy: { updatedAt: 'desc' }
    });
    const total = rows.reduce((t, r) => t + r.quantity, 0);
    return {
      spot: {
        id: spot.id, address: spot.address, name: spot.name, kind: spot.kind, colour: spot.colour, capacity: spot.capacity,
        isShopFloor: spot.isShopFloor, active: spot.active, labelCode: spot.labelCode, location: spot.location,
        holdsStock: spot._count.children === 0
      },
      total,
      overCapacity: !!spot.capacity && total > spot.capacity,
      items: rows.map(r => ({ ...describe(r.variant), quantity: r.quantity }))
    };
  },

  /** Items with pieces not on any shelf: the put-away list. Empty for a location with no shelves. */
  async notShelved(clientId: string, locationId: string, page = 1) {
    const location = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true, name: true } });
    if (!location) throw notFound('That location was not found.');
    const hasShelves = await prisma.storageSpot.count({ where: { clientId, locationId } });
    if (hasShelves === 0) return { location, usesShelves: false, items: [], total: 0, page: 1, pages: 1 };

    const size = 50;
    const skip = (Math.max(1, page) - 1) * size;
    const rows = await prisma.$queryRaw<{ variant_id: string; quantity: number; shelved: bigint }[]>`
      SELECT s.variant_id, s.quantity, COALESCE(SUM(ss.quantity), 0) AS shelved
      FROM inventory_stocks s
      LEFT JOIN spot_stocks ss ON ss.variant_id = s.variant_id AND ss.location_id = s.location_id
      WHERE s.client_id = ${clientId} AND s.location_id = ${locationId} AND s.quantity > 0
      GROUP BY s.variant_id, s.quantity
      HAVING s.quantity > COALESCE(SUM(ss.quantity), 0)
      ORDER BY s.quantity - COALESCE(SUM(ss.quantity), 0) DESC, s.variant_id
      LIMIT ${size} OFFSET ${skip}`;
    const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM (
        SELECT s.variant_id FROM inventory_stocks s
        LEFT JOIN spot_stocks ss ON ss.variant_id = s.variant_id AND ss.location_id = s.location_id
        WHERE s.client_id = ${clientId} AND s.location_id = ${locationId} AND s.quantity > 0
        GROUP BY s.variant_id, s.quantity
        HAVING s.quantity > COALESCE(SUM(ss.quantity), 0)
      ) t`;
    const variants = rows.length
      ? await prisma.productVariant.findMany({ where: { clientId, id: { in: rows.map(r => r.variant_id) } }, select: variantSelect })
      : [];
    const byId = new Map(variants.map(v => [v.id, v]));
    const total = Number(count);
    return {
      location,
      usesShelves: true,
      items: rows.filter(r => byId.has(r.variant_id)).map(r => ({
        ...describe(byId.get(r.variant_id)!),
        total: r.quantity,
        onShelves: Number(r.shelved),
        notShelved: r.quantity - Number(r.shelved)
      })),
      total,
      page: Math.max(1, page),
      pages: Math.max(1, Math.ceil(total / size))
    };
  },

  /**
   * Put away (no from), move (both), or take off a shelf back to Not shelved (no to). One movement, one
   * ledger row, legs for each shelf.
   */
  async move(clientId: string, userId: string | null, input: MoveInput) {
    const location = await prisma.stockLocation.findFirst({ where: { id: input.locationId, clientId }, select: { id: true } });
    if (!location) throw notFound('That location was not found.');
    const spotIds = [input.fromSpotId, input.toSpotId].filter((s): s is string => !!s);
    const found = await prisma.storageSpot.findMany({ where: { clientId, id: { in: spotIds } }, select: { id: true, locationId: true } });
    for (const id of spotIds) {
      const spot = found.find(f => f.id === id);
      if (!spot) throw notFound('That shelf was not found.');
      if (spot.locationId !== input.locationId) throw badRequest('That shelf is in another location. Use a transfer to move stock between locations.');
    }

    const legs = [
      ...(input.fromSpotId ? [{ spotId: input.fromSpotId, quantity: -input.quantity }] : []),
      ...(input.toSpotId ? [{ spotId: input.toSpotId, quantity: input.quantity }] : [])
    ];
    const kind = !input.fromSpotId ? 'PUT_AWAY' : !input.toSpotId ? 'TAKEN_OFF_SHELF' : 'MOVED';
    const result = await inventoryMutationService.applyMovement({
      clientId,
      variantId: input.variantId,
      locationId: input.locationId,
      movementType: 'ADJUSTMENT',
      reason: 'SHELF_MOVE',
      quantityDelta: 0,
      spots: legs,
      referenceType: 'SHELF_MOVE',
      notes: input.note?.trim() || (kind === 'PUT_AWAY' ? 'Put away' : kind === 'MOVED' ? 'Moved between shelves' : 'Taken off a shelf'),
      createdBy: userId ?? undefined
    });

    return {
      kind,
      legs: result.shelves?.legs ?? [],
      warning: input.toSpotId ? await capacityWarning(input.toSpotId) : null,
      item: await shelfStockService.whereIs(clientId, input.variantId, input.locationId)
    };
  },

  /**
   * Everything on one shelf to another, item by item. Each item is its own movement: one that fails
   * (someone sold the last piece a moment ago) is reported and the rest still move.
   */
  async moveAll(clientId: string, userId: string | null, fromSpotId: string, toSpotId: string) {
    const [from, to] = await Promise.all([
      prisma.storageSpot.findFirst({ where: { id: fromSpotId, clientId } }),
      prisma.storageSpot.findFirst({ where: { id: toSpotId, clientId } })
    ]);
    if (!from || !to) throw notFound('That shelf was not found.');
    if (from.locationId !== to.locationId) throw badRequest('Those shelves are in different locations. Use a transfer to move stock between locations.');
    const rows = await prisma.spotStock.findMany({ where: { clientId, spotId: fromSpotId }, select: { variantId: true, quantity: true } });
    if (rows.length === 0) throw badRequest(`${from.address} is already empty.`);

    const moved: { variantId: string; quantity: number }[] = [];
    const failed: { variantId: string; message: string }[] = [];
    for (const row of rows) {
      try {
        const current = await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId: fromSpotId, variantId: row.variantId } }, select: { quantity: true } });
        if (!current) continue;
        await inventoryMutationService.applyMovement({
          clientId, variantId: row.variantId, locationId: from.locationId, movementType: 'ADJUSTMENT', reason: 'SHELF_MOVE',
          quantityDelta: 0, spots: [{ spotId: fromSpotId, quantity: -current.quantity }, { spotId: toSpotId, quantity: current.quantity }],
          referenceType: 'SHELF_MOVE', notes: `Everything on ${from.address} moved to ${to.address}`, createdBy: userId ?? undefined
        });
        moved.push({ variantId: row.variantId, quantity: current.quantity });
      } catch (error: any) {
        failed.push({ variantId: row.variantId, message: typeof error?.statusCode === 'number' ? error.message : 'Could not move this item.' });
      }
    }
    return {
      from: from.address,
      to: to.address,
      moved: moved.length,
      pieces: moved.reduce((t, m) => t + m.quantity, 0),
      failed,
      warning: await capacityWarning(toSpotId)
    };
  },

  /**
   * Which shelves a set of movements used, by what they were for: the dispatches of an order, a transfer.
   * For "taken from these shelves" on an order or a receipt.
   */
  async byReference(clientId: string, referenceType: unknown, referenceIds: unknown) {
    const TYPES = ['ORDER', 'DISPATCH', 'TRANSFER', 'MANUAL', 'SHELF_COUNT', 'PURCHASE_RECEIPT', 'RETURN'];
    if (typeof referenceType !== 'string' || !TYPES.includes(referenceType)) throw badRequest('Say what the movements were for.');
    let ids = (typeof referenceIds === 'string' ? referenceIds.split(',') : []).map(s => s.trim()).filter(Boolean).slice(0, 100);
    if (ids.length === 0) return [];
    if (referenceType === 'ORDER') {
      // An order's pieces left in its dispatches; only this shop's orders are looked at.
      const dispatches = await prisma.dispatch.findMany({ where: { salesOrder: { id: { in: ids }, clientId } }, select: { id: true } });
      ids = dispatches.map(d => d.id);
      if (ids.length === 0) return [];
    }
    const type = referenceType === 'ORDER' ? 'DISPATCH' : referenceType;
    const transactions = await prisma.inventoryTransaction.findMany({
      where: { clientId, referenceType: type, referenceId: { in: ids }, spotLegs: { some: {} } },
      orderBy: { createdAt: 'asc' },
      select: {
        referenceId: true, variantId: true, quantity: true, reason: true, sku: true, productTitle: true, createdAt: true, locationId: true,
        spotLegs: { select: { address: true, quantity: true, source: true, spotId: true } }
      }
    });
    return transactions.map(t => ({
      referenceId: t.referenceId, variantId: t.variantId, sku: t.sku, title: t.productTitle, quantity: t.quantity, reason: t.reason, at: t.createdAt,
      legs: t.spotLegs
    }));
  },

  /** A shelf's movements, newest first. */
  async history(clientId: string, spotId: string) {
    const spot = await prisma.storageSpot.findFirst({ where: { id: spotId, clientId }, select: { id: true } });
    if (!spot) throw notFound('That shelf was not found.');
    const legs = await prisma.inventoryTransactionSpot.findMany({
      where: { clientId, spotId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        quantity: true, source: true, address: true, createdAt: true,
        transaction: { select: { reason: true, notes: true, referenceType: true, referenceId: true, createdBy: true, sku: true, productTitle: true } }
      }
    });
    return legs.map(l => ({
      at: l.createdAt, quantity: l.quantity, source: l.source, address: l.address,
      reason: l.transaction.reason, notes: l.transaction.notes, reference: l.transaction.referenceType ? { type: l.transaction.referenceType, id: l.transaction.referenceId } : null,
      by: l.transaction.createdBy, sku: l.transaction.sku, title: l.transaction.productTitle
    }));
  }
};
