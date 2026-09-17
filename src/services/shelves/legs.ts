import { InventoryReason, Prisma } from '@prisma/client';
import { conflict } from '../../utils/httpError';
import { walkKeys } from './addresses';
import { KnownSpot, planShelfLegs, ShelfState } from './plan';

/**
 * The shelf half of a stock movement, run by applyMovement inside its own transaction and after its
 * variant lock -- so no other movement of this item can interleave, and the legs belong to the same
 * inventory_transactions row as the change to the location. There is no separate shelf ledger.
 */

export type ShelfLegInput = {
  clientId: string;
  variantId: string;
  locationId: string;
  reason: InventoryReason;
  delta: number;
  officialBefore: number;
  officialAfter: number;
  transactionId: string;
  scanned?: { spotId: string; quantity: number }[];
  itemName: string;
};

export type ShelfLegResult = {
  legs: { spotId: string; address: string; quantity: number; source: string }[];
  issues: { kind: string; address: string; quantity: number; message: string }[];
};

const NOTHING: ShelfLegResult = { legs: [], issues: [] };

export async function applyShelfLegs(tx: Prisma.TransactionClient, input: ShelfLegInput): Promise<ShelfLegResult> {
  const scanned = (input.scanned ?? []).filter(l => l && l.quantity !== 0);

  // Stock arriving with no shelf named never touches a shelf: it is Not shelved. No query at all, so
  // purchase receipts, returns and imports cost nothing extra.
  if (scanned.length === 0 && input.delta >= 0 && input.reason !== 'SHELF_MOVE') return NOTHING;

  // Shelves being put onto are held while this runs, so nobody switches one off, deletes it or adds a
  // box inside it in the same moment (spot.service locks the branch it changes FOR UPDATE).
  const receiving = [...new Set(scanned.filter(l => l.quantity > 0).map(l => l.spotId))];
  if (receiving.length > 0) {
    await tx.$queryRaw`SELECT id FROM storage_spots WHERE id IN (${Prisma.join(receiving)}) AND client_id = ${input.clientId} FOR SHARE`;
  }

  const shelfRows = await tx.spotStock.findMany({
    where: { variantId: input.variantId, locationId: input.locationId },
    select: { spotId: true, quantity: true }
  });

  // A shop without shelves for this item: nothing to do. One indexed lookup for every reduction.
  if (shelfRows.length === 0 && scanned.length === 0) return NOTHING;

  const spotRows = await tx.storageSpot.findMany({
    where: { clientId: input.clientId, locationId: input.locationId },
    select: { id: true, parentId: true, walkOrder: true, address: true, isShopFloor: true, active: true }
  });
  const keys = walkKeys(spotRows);
  const parents = new Set(spotRows.map(s => s.parentId).filter((p): p is string => !!p));
  const spots = new Map<string, KnownSpot>(spotRows.map(s => [s.id, {
    spotId: s.id, address: s.address, isShopFloor: s.isShopFloor, walkKey: keys.get(s.id) ?? [],
    active: s.active, hasChildren: parents.has(s.id)
  }]));

  const shelves: ShelfState[] = shelfRows.map(r => {
    const spot = spots.get(r.spotId)!;
    return { spotId: r.spotId, address: spot.address, isShopFloor: spot.isShopFloor, walkKey: spot.walkKey, quantity: r.quantity };
  });

  const { legs, issues } = planShelfLegs({
    reason: input.reason,
    delta: input.delta,
    officialBefore: input.officialBefore,
    officialAfter: input.officialAfter,
    shelves,
    scanned,
    spots,
    itemName: input.itemName
  });

  if (legs.length === 0) return NOTHING;

  // One write per shelf, whatever mix of named and automatic legs reached it.
  const net = new Map<string, number>();
  for (const leg of legs) net.set(leg.spotId, (net.get(leg.spotId) ?? 0) + leg.quantity);
  const before = new Map(shelfRows.map(r => [r.spotId, r.quantity]));

  for (const [spotId, change] of net) {
    if (change === 0) continue;
    const after = (before.get(spotId) ?? 0) + change;
    if (after < 0) {
      // The planner never does this; the check is here so a future change to it cannot corrupt a shelf.
      throw conflict(`${spots.get(spotId)?.address ?? 'A shelf'} does not hold that many pieces.`);
    }
    if (after === 0) {
      await tx.spotStock.delete({ where: { spotId_variantId: { spotId, variantId: input.variantId } } });
    } else {
      await tx.spotStock.upsert({
        where: { spotId_variantId: { spotId, variantId: input.variantId } },
        update: { quantity: after },
        create: { clientId: input.clientId, locationId: input.locationId, spotId, variantId: input.variantId, quantity: after }
      });
    }
  }

  await tx.inventoryTransactionSpot.createMany({
    data: legs.filter(l => l.quantity !== 0).map(l => ({
      clientId: input.clientId,
      transactionId: input.transactionId,
      spotId: l.spotId,
      address: l.address,
      variantId: input.variantId,
      locationId: input.locationId,
      quantity: l.quantity,
      source: l.source
    }))
  });

  if (issues.length > 0) {
    await tx.shelfIssue.createMany({
      data: issues.map(i => ({
        clientId: input.clientId,
        locationId: input.locationId,
        variantId: input.variantId,
        spotId: i.spotId,
        address: i.address,
        transactionId: input.transactionId,
        kind: i.kind,
        quantity: i.quantity,
        message: i.message
      }))
    });
    // Where the shop already looks. One alert for the movement, however many shelves it touched.
    await tx.inventoryAlert.create({
      data: {
        clientId: input.clientId,
        type: 'STOCK_DISCREPANCY',
        severity: 'WARNING',
        title: 'Shelves need a look',
        message: issues.length === 1 ? issues[0].message : `${issues[0].message} (${issues.length - 1} more in Shelf issues.)`,
        variantId: input.variantId,
        locationId: input.locationId,
        currentQuantity: input.officialAfter
      }
    });
  }

  // The rule, checked here for a sentence. The database checks it again at commit.
  const shelved = await tx.spotStock.aggregate({
    where: { variantId: input.variantId, locationId: input.locationId },
    _sum: { quantity: true }
  });
  if ((shelved._sum.quantity ?? 0) > input.officialAfter) {
    throw conflict('The shelves would hold more of this item than the location has. Nothing was saved.');
  }

  return {
    legs: legs.map(l => ({ spotId: l.spotId, address: l.address, quantity: l.quantity, source: l.source })),
    issues: issues.map(i => ({ kind: i.kind, address: i.address, quantity: i.quantity, message: i.message }))
  };
}
