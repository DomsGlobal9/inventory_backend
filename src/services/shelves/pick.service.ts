import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../utils/httpError';
import { compareWalk, walkKeys } from './addresses';

/**
 * Pick lists: the orders waiting to go out from a location, and one walk through its shelves that
 * collects them. Suggesting never moves stock. The person scans each shelf and item, and the dispatch
 * that follows names those shelves, so the ledger records where every piece really came from.
 */

const MAX_ORDERS = 30;

const variantSelect = {
  id: true, sku: true, variantCode: true, barcode: true, colorName: true, hexCode: true, size: true,
  product: {
    select: {
      title: true,
      images: { where: { variantId: null }, orderBy: [{ isPrimary: 'desc' as const }, { orderIndex: 'asc' as const }], take: 1, select: { url: true } }
    }
  },
  images: { orderBy: [{ isPrimary: 'desc' as const }, { orderIndex: 'asc' as const }], take: 1, select: { url: true } }
};

const describe = (v: any) => ({
  variantId: v.id, title: v.product.title, sku: v.sku, code: v.variantCode, barcode: v.barcode,
  colorName: v.colorName, hexCode: v.hexCode, size: v.size,
  imageUrl: v.images[0]?.url ?? v.product.images[0]?.url ?? null
});

async function locationOf(clientId: string, locationId: unknown) {
  if (typeof locationId !== 'string' || !locationId) throw badRequest('Choose the location you are picking in.');
  const location = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true, name: true } });
  if (!location) throw notFound('That location was not found.');
  return location;
}

export const pickService = {
  /** Orders at this location with pieces still to send out, oldest first. */
  async orders(clientId: string, locationId: unknown) {
    const location = await locationOf(clientId, locationId);
    const orders = await prisma.salesOrder.findMany({
      where: { clientId, locationId: location.id, deletedAt: null, status: { in: ['CONFIRMED', 'PARTIALLY_DISPATCHED'] } },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true, orderNumber: true, channel: true, sourceSystem: true, handover: true, status: true, createdAt: true,
        customerName: true, customer: { select: { name: true } },
        items: { select: { quantity: true, fulfilledQty: true } }
      }
    });
    return {
      location,
      orders: orders
        .map(o => ({
          id: o.id, orderNumber: o.orderNumber, channel: o.channel, source: o.sourceSystem, handover: o.handover, status: o.status,
          createdAt: o.createdAt, customer: o.customerName || o.customer?.name || null,
          lines: o.items.filter(i => i.quantity > i.fulfilledQty).length,
          pieces: o.items.reduce((t, i) => t + Math.max(0, i.quantity - i.fulfilledQty), 0)
        }))
        .filter(o => o.pieces > 0)
    };
  },

  /**
   * One walk for the chosen orders: every stop is a shelf, in walking order, with what to take there
   * for which order. Pieces are shared out so two orders are never sent to the same last piece; what
   * no shelf holds is listed as Not shelved.
   */
  async list(clientId: string, locationId: unknown, orderIds: string[]) {
    const location = await locationOf(clientId, locationId);
    const ids = [...new Set(orderIds.filter(id => typeof id === 'string' && id))];
    if (ids.length === 0) throw badRequest('Choose at least one order to pick.');
    if (ids.length > MAX_ORDERS) throw badRequest(`Pick at most ${MAX_ORDERS} orders at once.`);

    const orders = await prisma.salesOrder.findMany({
      where: { clientId, id: { in: ids }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, orderNumber: true, status: true, locationId: true, customerName: true, channel: true,
        items: { select: { id: true, variantId: true, quantity: true, fulfilledQty: true, variant: { select: variantSelect } } }
      }
    });
    if (orders.length !== ids.length) throw notFound('One of those orders was not found.');
    for (const o of orders) {
      if (o.locationId !== location.id) throw badRequest(`${o.orderNumber} is sent from another location.`);
      if (o.status !== 'CONFIRMED' && o.status !== 'PARTIALLY_DISPATCHED') throw badRequest(`${o.orderNumber} is ${o.status.toLowerCase().replace('_', ' ')}, so there is nothing to pick for it.`);
    }

    const lines = orders.flatMap(o => o.items
      .filter(i => i.quantity > i.fulfilledQty)
      .map(i => ({ orderId: o.id, orderNumber: o.orderNumber, salesOrderItemId: i.id, variantId: i.variantId, quantity: i.quantity - i.fulfilledQty, item: describe(i.variant) })));
    const variantIds = [...new Set(lines.map(l => l.variantId))];

    const [spots, shelfStock, stock] = await Promise.all([
      prisma.storageSpot.findMany({ where: { clientId, locationId: location.id } }),
      prisma.spotStock.findMany({ where: { clientId, locationId: location.id, variantId: { in: variantIds } }, select: { spotId: true, variantId: true, quantity: true } }),
      prisma.inventoryStock.findMany({ where: { clientId, locationId: location.id, variantId: { in: variantIds } }, select: { variantId: true, quantity: true } })
    ]);
    const keys = walkKeys(spots);
    const spotById = new Map(spots.map(s => [s.id, s]));
    const left = new Map(shelfStock.map(r => [`${r.spotId}|${r.variantId}`, r.quantity]));
    const official = new Map(stock.map(s => [s.variantId, s.quantity]));
    const shelvedOf = (variantId: string) => shelfStock.filter(r => r.variantId === variantId).reduce((t, r) => t + r.quantity, 0);
    const unshelvedLeft = new Map(variantIds.map(v => [v, Math.max(0, (official.get(v) ?? 0) - shelvedOf(v))]));

    type Pick = { orderId: string; orderNumber: string; salesOrderItemId: string; quantity: number; item: any };
    const stops = new Map<string, Pick[]>();
    const notShelved: Pick[] = [];
    const short: Pick[] = [];

    for (const line of lines) {
      let need = line.quantity;
      // Shortest walk: shelves holding it, in the order the shop is walked.
      const holding = shelfStock
        .filter(r => r.variantId === line.variantId)
        .map(r => spotById.get(r.spotId)!)
        .map(s => ({ spot: s, walkKey: keys.get(s.id) ?? [], address: s.address }))
        .sort(compareWalk);
      for (const { spot } of holding) {
        if (need === 0) break;
        const key = `${spot.id}|${line.variantId}`;
        const take = Math.min(need, left.get(key) ?? 0);
        if (take <= 0) continue;
        left.set(key, (left.get(key) ?? 0) - take);
        need -= take;
        stops.set(spot.id, [...(stops.get(spot.id) ?? []), { ...line, quantity: take }]);
      }
      if (need > 0) {
        const loose = Math.min(need, unshelvedLeft.get(line.variantId) ?? 0);
        if (loose > 0) {
          unshelvedLeft.set(line.variantId, (unshelvedLeft.get(line.variantId) ?? 0) - loose);
          notShelved.push({ ...line, quantity: loose });
          need -= loose;
        }
      }
      if (need > 0) short.push({ ...line, quantity: need });
    }

    const walk = [...stops.entries()]
      .map(([spotId, picks]) => {
        const s = spotById.get(spotId)!;
        return { walkKey: keys.get(spotId) ?? [], address: s.address, stop: { spotId, address: s.address, name: s.name, colour: s.colour, isShopFloor: s.isShopFloor, labelCode: s.labelCode, picks } };
      })
      .sort(compareWalk)
      .map(x => x.stop);

    return {
      location,
      orders: orders.map(o => ({ id: o.id, orderNumber: o.orderNumber, customer: o.customerName, channel: o.channel })),
      stops: walk,
      notShelved,
      short,
      pieces: lines.reduce((t, l) => t + l.quantity, 0)
    };
  },

  /** A picker went to the shelf and the pieces were not there. Recorded as an issue; stock is not changed. */
  async notFound(clientId: string, userId: string | null, body: { spotId?: unknown; variantId?: unknown; missing?: unknown }) {
    if (typeof body.spotId !== 'string' || typeof body.variantId !== 'string') throw badRequest('Say which shelf and which item.');
    const missing = Number(body.missing);
    if (!Number.isInteger(missing) || missing < 1 || missing > 100000) throw badRequest('Say how many pieces are missing, at least one.');
    const spot = await prisma.storageSpot.findFirst({ where: { id: body.spotId, clientId }, select: { id: true, address: true, locationId: true } });
    if (!spot) throw notFound('That shelf was not found.');
    const variant = await prisma.productVariant.findFirst({ where: { id: body.variantId, clientId }, select: { id: true, sku: true, product: { select: { title: true } } } });
    if (!variant) throw notFound('That item was not found.');
    const recorded = (await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId: spot.id, variantId: variant.id } } }))?.quantity ?? 0;
    const name = `${variant.product.title} (${variant.sku})`;
    const message = `${missing} ${missing === 1 ? 'piece' : 'pieces'} of ${name} could not be found on ${spot.address}, which should hold ${recorded}. Count that shelf.`;
    const issue = await prisma.$transaction(async tx => {
      const created = await tx.shelfIssue.create({
        data: { clientId, locationId: spot.locationId, variantId: variant.id, spotId: spot.id, address: spot.address, kind: 'NOT_FOUND_ON_SHELF', quantity: missing, message }
      });
      await tx.inventoryAlert.create({
        data: { clientId, type: 'STOCK_DISCREPANCY', severity: 'WARNING', title: 'Shelves need a look', message, variantId: variant.id, locationId: spot.locationId, currentQuantity: recorded }
      });
      return created;
    });
    return { issueId: issue.id, message, reportedBy: userId };
  }
};
