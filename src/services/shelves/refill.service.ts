import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../utils/httpError';
import { compareWalk, walkKeys, WalkKey } from './addresses';

/**
 * Refill the shop floor: what to carry from the back room before the floor runs out.
 *
 * A till sale takes from shop-floor shelves first; when the floor is empty it has to come off a
 * back-room shelf, which is the commonest Problem a shop sees ("sold from a back-room shelf"). This
 * list is the cure, done ahead of time: every item whose floor shelves hold fewer than the shop's
 * minimum while a back-room shelf has some, ordered as ONE walk through the back room.
 *
 * Suggesting moves nothing. Each line is carried and confirmed with the ordinary move (SHELF_MOVE
 * through applyMovement), so the shelf rule, the ledger and the locks are the ones every move uses.
 *
 * Where it goes on the floor: the floor shelf that already holds it; else the floor shelf it was last
 * on (from the shelf ledger); else nowhere yet, and the person chooses.
 */

export const DEFAULT_MIN_ON_FLOOR = 2;
const MAX_LINES = 300;
const DAY = 24 * 60 * 60 * 1000;

type SpotRow = { id: string; parentId: string | null; walkOrder: number; address: string; name: string | null; isShopFloor: boolean; active: boolean };

export async function refillList(clientId: string, locationId: string, minOnFloorRaw?: unknown) {
  const minOnFloor = minOnFloorRaw === undefined || minOnFloorRaw === '' ? DEFAULT_MIN_ON_FLOOR : Number(minOnFloorRaw);
  if (!Number.isInteger(minOnFloor) || minOnFloor < 1 || minOnFloor > 1000) {
    throw badRequest('Keep at least 1 to 1000 pieces on the floor.');
  }
  const location = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true, name: true } });
  if (!location) throw notFound('That location was not found.');

  const spots: SpotRow[] = await prisma.storageSpot.findMany({
    where: { clientId, locationId },
    select: { id: true, parentId: true, walkOrder: true, address: true, name: true, isShopFloor: true, active: true }
  });
  const parents = new Set(spots.map(s => s.parentId).filter((p): p is string => !!p));
  const keys = walkKeys(spots);
  // Pieces can only be moved onto a shelf that is in use and has nothing inside it.
  const usable = (s: SpotRow) => s.active && !parents.has(s.id);
  const floorShelves = spots.filter(s => s.isShopFloor && usable(s));
  const base = { location: { id: location.id, name: location.name }, minOnFloor };
  if (floorShelves.length === 0) return { ...base, usesFloorShelves: false, lines: [] as RefillLine[] };

  const spotById = new Map(spots.map(s => [s.id, s]));
  const walkOf = (id: string): WalkKey => keys.get(id) ?? [];
  const onSpots = await prisma.spotStock.findMany({
    where: { clientId, locationId, quantity: { gt: 0 } },
    select: { spotId: true, variantId: true, quantity: true }
  });

  // Per item: what the floor holds, and the back-room shelves that hold some.
  const byVariant = new Map<string, { floor: number; floorShelves: { spotId: string; quantity: number }[]; back: { spotId: string; quantity: number }[] }>();
  for (const r of onSpots) {
    const spot = spotById.get(r.spotId);
    if (!spot) continue;
    const v = byVariant.get(r.variantId) ?? { floor: 0, floorShelves: [], back: [] };
    if (spot.isShopFloor) { v.floor += r.quantity; v.floorShelves.push({ spotId: r.spotId, quantity: r.quantity }); }
    else v.back.push({ spotId: r.spotId, quantity: r.quantity });
    byVariant.set(r.variantId, v);
  }
  const wanted = [...byVariant.entries()].filter(([, v]) => v.floor < minOnFloor && v.back.length > 0);
  if (wanted.length === 0) return { ...base, usesFloorShelves: true, lines: [] as RefillLine[] };
  const ids = wanted.map(([id]) => id);

  const [variants, lastFloorLegs, sales, stocks] = await Promise.all([
    prisma.productVariant.findMany({
      where: { clientId, id: { in: ids } },
      select: {
        id: true, sku: true, colorName: true, hexCode: true, size: true,
        product: { select: { id: true, title: true, status: true, trashedAt: true, isService: true } },
        images: { orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }], take: 1, select: { url: true } }
      }
    }),
    // The floor shelf each item was last on, newest first: where it "lives" when the floor is empty.
    prisma.inventoryTransactionSpot.findMany({
      where: { clientId, locationId, variantId: { in: ids }, spotId: { in: floorShelves.map(s => s.id) } },
      orderBy: { createdAt: 'desc' },
      select: { variantId: true, spotId: true },
      take: 2000
    }),
    // Selling speed, for the person deciding what to carry first.
    prisma.inventoryTransaction.groupBy({
      by: ['variantId'],
      where: { clientId, locationId, variantId: { in: ids }, reason: 'SALE', createdAt: { gte: new Date(Date.now() - 7 * DAY) } },
      _sum: { quantity: true }
    }),
    // Pieces held for an order are on a shelf but already sold: never carry what is promised.
    prisma.inventoryStock.findMany({ where: { clientId, locationId, variantId: { in: ids } }, select: { variantId: true, reservedQty: true } })
  ]);
  const variantById = new Map(variants.map(v => [v.id, v]));
  const lastFloor = new Map<string, string>();
  for (const leg of lastFloorLegs) if (leg.spotId && !lastFloor.has(leg.variantId) && usable(spotById.get(leg.spotId)!)) lastFloor.set(leg.variantId, leg.spotId);
  const soldOf = new Map(sales.map(s => [s.variantId, Math.max(0, -(s._sum.quantity ?? 0))]));
  const heldOf = new Map(stocks.map(s => [s.variantId, s.reservedQty]));

  const lines: RefillLine[] = [];
  for (const [variantId, v] of wanted) {
    const variant = variantById.get(variantId);
    if (!variant || variant.product.isService) continue;
    // Retired products are not put back on display.
    if (variant.product.trashedAt || variant.product.status === 'ARCHIVED' || variant.product.status === 'TRASHED') continue;

    const backTotal = v.back.reduce((t, b) => t + b.quantity, 0);
    const carryable = Math.max(0, backTotal - (heldOf.get(variantId) ?? 0));
    let toCarry = Math.min(minOnFloor - v.floor, carryable);
    if (toCarry <= 0) continue;

    const already = [...v.floorShelves].filter(f => usable(spotById.get(f.spotId)!)).sort((a, b) => b.quantity - a.quantity)[0]?.spotId;
    const toId = already ?? lastFloor.get(variantId) ?? null;
    const to = toId ? spotById.get(toId)! : null;

    // From the back-room shelves in walking order, splitting the carry across them.
    for (const from of [...v.back].sort((a, b) => compareWalk(
      { walkKey: walkOf(a.spotId), address: spotById.get(a.spotId)!.address },
      { walkKey: walkOf(b.spotId), address: spotById.get(b.spotId)!.address }))) {
      if (toCarry <= 0) break;
      const n = Math.min(toCarry, from.quantity);
      const fromSpot = spotById.get(from.spotId)!;
      lines.push({
        variantId,
        productId: variant.product.id,
        title: variant.product.title,
        sku: variant.sku,
        colorName: variant.colorName,
        hexCode: variant.hexCode,
        size: variant.size,
        imageUrl: variant.images[0]?.url ?? null,
        from: { spotId: fromSpot.id, address: fromSpot.address, name: fromSpot.name },
        to: to ? { spotId: to.id, address: to.address, name: to.name } : null,
        quantity: n,
        onFloor: v.floor,
        inBackRoom: backTotal,
        soldLast7Days: soldOf.get(variantId) ?? 0,
        walkKey: walkOf(fromSpot.id)
      });
      toCarry -= n;
    }
  }

  // One walk through the back room; inside one shelf, the faster sellers first.
  lines.sort((a, b) => compareWalk({ walkKey: a.walkKey, address: a.from.address }, { walkKey: b.walkKey, address: b.from.address })
    || b.soldLast7Days - a.soldLast7Days || a.title.localeCompare(b.title));
  return {
    ...base,
    usesFloorShelves: true,
    lines: lines.slice(0, MAX_LINES).map(({ walkKey, ...line }) => line),
    more: Math.max(0, lines.length - MAX_LINES)
  };
}

export type RefillLine = {
  variantId: string; productId: string; title: string; sku: string;
  colorName: string | null; hexCode: string | null; size: string | null; imageUrl: string | null;
  from: { spotId: string; address: string; name: string | null };
  to: { spotId: string; address: string; name: string | null } | null;
  quantity: number; onFloor: number; inBackRoom: number; soldLast7Days: number;
  walkKey: WalkKey;
};
