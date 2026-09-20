import { Prisma, SpotFillStateKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../utils/httpError';
import { inventoryMutationService } from '../inventory-mutation.service';
import { compareWalk, walkKeys } from './addresses';

/**
 * The FIRST FILL: staff walk the shelves once and record what is really on each one.
 *
 * It creates no stock and changes no quantity. Every line is a put-away through applyMovement, so the
 * one rule still holds: what is on the shelves can never be more than the location's own count.
 *
 * How far the walk has got is kept apart from stock (spot_fill_states), because a quantity can never
 * say whether a person has stood at that shelf: an empty shelf somebody checked and an empty shelf
 * nobody has seen look identical in the stock numbers.
 *
 * While a location is filling, a till sale takes from Not shelved first (decision D1, plan.ts), so a
 * shelf counted a minute ago is not quietly reduced.
 */

const TX = { maxWait: 20000, timeout: 60000 } as const;
/** After this long, somebody else's "I'm at this shelf" stops being shown. It is never a lock. */
const CLAIM_MINUTES = 30;
const MAX_LINES = 200;

const pieces = (n: number) => `${n} ${n === 1 ? 'piece' : 'pieces'}`;

async function locationOf(clientId: string, locationId: string) {
  const location = await prisma.stockLocation.findFirst({
    where: { id: locationId, clientId },
    select: { id: true, name: true }
  });
  if (!location) throw notFound('That location was not found.');
  return location;
}

/** Spots that can hold stock: switched on, with nothing inside them. */
async function fillTargets(db: Prisma.TransactionClient | typeof prisma, clientId: string, locationId: string) {
  const spots = await db.storageSpot.findMany({
    where: { clientId, locationId },
    select: { id: true, parentId: true, address: true, name: true, walkOrder: true, isShopFloor: true, active: true, capacity: true, labelCode: true }
  });
  const parents = new Set(spots.map(s => s.parentId).filter((p): p is string => !!p));
  const keys = walkKeys(spots.map(s => ({ id: s.id, parentId: s.parentId, walkOrder: s.walkOrder, address: s.address })));
  return spots
    .filter(s => s.active && !parents.has(s.id))
    .map(s => ({ ...s, walkKey: keys.get(s.id) ?? [] }))
    .sort(compareWalk);
}

/**
 * Pieces at this location that are on no shelf, and separately the items whose numbers do not add up.
 * Those are never folded into the count: a stock figure below zero, or more on the shelves than the
 * location holds, is something to look at, not something to hide behind a 0.
 */
async function notShelvedSummary(clientId: string, locationId: string) {
  const [[sums], [odd]] = await Promise.all([
    prisma.$queryRaw<{ waiting: bigint | null; items: bigint }[]>`
      SELECT COALESCE(SUM(s.quantity - COALESCE(shelved, 0)), 0) AS waiting, COUNT(*) AS items
      FROM inventory_stocks s
      LEFT JOIN (
        SELECT variant_id, location_id, SUM(quantity) AS shelved FROM spot_stocks
        WHERE client_id = ${clientId} AND location_id = ${locationId} GROUP BY variant_id, location_id
      ) ss ON ss.variant_id = s.variant_id AND ss.location_id = s.location_id
      WHERE s.client_id = ${clientId} AND s.location_id = ${locationId}
        AND s.quantity > COALESCE(shelved, 0) AND s.quantity > 0`,
    prisma.$queryRaw<{ items: bigint }[]>`
      SELECT COUNT(*) AS items FROM inventory_stocks s
      LEFT JOIN (
        SELECT variant_id, location_id, SUM(quantity) AS shelved FROM spot_stocks
        WHERE client_id = ${clientId} AND location_id = ${locationId} GROUP BY variant_id, location_id
      ) ss ON ss.variant_id = s.variant_id AND ss.location_id = s.location_id
      WHERE s.client_id = ${clientId} AND s.location_id = ${locationId}
        AND (s.quantity < 0 OR COALESCE(shelved, 0) > s.quantity)`
  ]);
  return {
    piecesWaiting: Number(sums?.waiting ?? 0),
    itemsWaiting: Number(sums?.items ?? 0),
    needStockCheck: Number(odd?.items ?? 0)
  };
}

export const fillService = {
  /** Where the walk has got to, for the screen and for ScaleEzy's onboarding board. */
  async status(clientId: string, locationId: string) {
    const location = await locationOf(clientId, locationId);
    const [targets, states, firstFill, waiting] = await Promise.all([
      fillTargets(prisma, clientId, locationId),
      prisma.spotFillState.findMany({ where: { clientId, locationId } }),
      prisma.locationFirstFill.findUnique({ where: { locationId } }),
      notShelvedSummary(clientId, locationId)
    ]);
    const byId = new Map(states.map(s => [s.spotId, s]));
    const counted = { total: targets.length, completed: 0, skipped: 0, inProgress: 0, notStarted: 0 };
    for (const t of targets) {
      const state = byId.get(t.id)?.state ?? 'NOT_STARTED';
      if (state === 'COMPLETED') counted.completed++;
      else if (state === 'SKIPPED') counted.skipped++;
      else if (state === 'IN_PROGRESS') counted.inProgress++;
      else counted.notStarted++;
    }
    // The next shelf to stand at: never seen first, then the ones skipped earlier.
    const next = targets.find(t => (byId.get(t.id)?.state ?? 'NOT_STARTED') === 'NOT_STARTED')
      ?? targets.find(t => byId.get(t.id)?.state === 'IN_PROGRESS')
      ?? targets.find(t => byId.get(t.id)?.state === 'SKIPPED')
      ?? null;

    return {
      location,
      firstFill: {
        state: firstFill?.state ?? 'NOT_STARTED',
        startedAt: firstFill?.startedAt ?? null,
        finishedAt: firstFill?.finishedAt ?? null,
        endedByItself: firstFill?.endedByItself ?? null
      },
      shelves: counted,
      ...waiting,
      next: next ? { spotId: next.id, address: next.address, name: next.name, position: targets.indexOf(next) + 1 } : null,
      skippedShelves: targets.filter(t => byId.get(t.id)?.state === 'SKIPPED').map(t => ({ spotId: t.id, address: t.address })).slice(0, 50)
    };
  },

  /** Stand at a shelf: what is recorded on it now, and whether somebody else is there. */
  async openShelf(clientId: string, userId: string | null, spotId: string, userName?: string | null) {
    const spot = await prisma.storageSpot.findFirst({
      where: { id: spotId, clientId },
      include: { _count: { select: { children: true } }, fillState: true, location: { select: { id: true, name: true } } }
    });
    if (!spot) throw notFound('That shelf was not found.');
    if (spot._count.children > 0) throw badRequest(`${spot.address} has shelves or boxes inside it. Stand at one of those.`);
    if (!spot.active) throw badRequest(`${spot.address} is switched off. Switch it on in Racks & shelves first.`);

    const held = spot.fillState;
    const claimAgeMin = held?.claimedAt ? (Date.now() - held.claimedAt.getTime()) / 60000 : Infinity;
    // Who is there, by name: "Ravi started this shelf 4 minutes ago" beats a row of letters and digits.
    const otherPerson = held?.claimedBy && held.claimedBy !== userId && claimAgeMin < CLAIM_MINUTES
      ? await prisma.user.findFirst({ where: { id: held.claimedBy, clientId }, select: { name: true } })
      : null;
    const heldBySomeoneElse = otherPerson
      ? { who: otherPerson.name || 'Somebody', minutesAgo: Math.max(1, Math.round(claimAgeMin)) }
      : null;

    // Claiming is a courtesy, never a lock: whoever opens it last is shown as being there, and both
    // people's lines are additions, so nobody's work is thrown away.
    const state = await prisma.spotFillState.upsert({
      where: { spotId },
      create: { clientId, locationId: spot.locationId, spotId, state: 'IN_PROGRESS', claimedBy: userId, claimedAt: new Date() },
      update: { state: held?.state === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS', claimedBy: userId, claimedAt: new Date() }
    });

    const rows = await prisma.spotStock.findMany({
      where: { clientId, spotId },
      select: { quantity: true, variantId: true, variant: { select: { id: true, sku: true, colorName: true, size: true, product: { select: { title: true } } } } }
    });
    return {
      spot: {
        id: spot.id, address: spot.address, name: spot.name, capacity: spot.capacity,
        isShopFloor: spot.isShopFloor, labelCode: spot.labelCode, location: spot.location
      },
      state: state.state,
      alreadyOnIt: rows.map(r => ({
        variantId: r.variantId, title: r.variant.product.title, sku: r.variant.sku,
        colour: r.variant.colorName, size: r.variant.size, quantity: r.quantity
      })),
      heldBySomeoneElse,
      userName: userName ?? null
    };
  },

  /**
   * Everything on one shelf, saved in one go. All of it or none of it: a line that no longer fits
   * (somebody sold the last piece a moment ago) sends the whole shelf back with a reason per line, so
   * nothing is half-recorded and the phone can keep the list.
   *
   * `saveKey` is made on the phone once per shelf visit. If the network drops after the save went
   * through, the same key returns the same answer instead of putting the pieces away twice.
   */
  async saveShelf(
    clientId: string,
    userId: string | null,
    spotId: string,
    input: { lines: { variantId: string; quantity: number }[]; saveKey: string }
  ) {
    const already = await prisma.shelfFillSave.findUnique({ where: { clientId_saveKey: { clientId, saveKey: input.saveKey } } });
    if (already) return { ...(already.result as object), repeat: true };

    const spot = await prisma.storageSpot.findFirst({
      where: { id: spotId, clientId },
      include: { _count: { select: { children: true } } }
    });
    if (!spot) throw notFound('That shelf was not found.');
    if (spot._count.children > 0) throw badRequest(`${spot.address} has shelves or boxes inside it. Stand at one of those.`);
    if (!spot.active) throw badRequest(`${spot.address} is switched off. Switch it on in Racks & shelves first.`);
    if (input.lines.length > MAX_LINES) throw badRequest(`That is more than ${MAX_LINES} items on one shelf. Save what you have, then carry on.`);

    // Two lines for the same item are one line. Sorted by item id so two phones saving shelves that
    // share items always lock those items in the same order, and wait for each other instead of
    // deadlocking.
    const merged = new Map<string, number>();
    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) throw badRequest('How many must be a whole number, at least 1.');
      merged.set(line.variantId, (merged.get(line.variantId) ?? 0) + line.quantity);
    }
    const lines = [...merged.entries()].map(([variantId, quantity]) => ({ variantId, quantity })).sort((a, b) => (a.variantId < b.variantId ? -1 : 1));

    const result = await prisma.$transaction(async tx => {
      const problems: { variantId: string; title: string; asked: number; free: number; message: string }[] = [];
      for (const line of lines) {
        try {
          await inventoryMutationService.applyMovement({
            tx,
            clientId,
            variantId: line.variantId,
            locationId: spot.locationId,
            movementType: 'ADJUSTMENT',
            reason: 'SHELF_MOVE',
            quantityDelta: 0,
            spots: [{ spotId, quantity: line.quantity }],
            referenceType: 'SHELF_MOVE',
            notes: 'First fill',
            createdBy: userId ?? undefined
          });
        } catch (error: any) {
          const variant = await tx.productVariant.findFirst({ where: { id: line.variantId, clientId }, select: { sku: true, product: { select: { title: true } } } });
          const free = await freeToShelve(tx, clientId, spot.locationId, line.variantId);
          problems.push({
            variantId: line.variantId,
            title: variant?.product.title ?? variant?.sku ?? 'That item',
            asked: line.quantity,
            free,
            message: free <= 0
              ? `ScaleEzy has none of these left to put on a shelf here. Put ${line.quantity === 1 ? 'it' : 'them'} aside for a stock count.`
              : `Only ${pieces(free)} can go on a shelf here now. Somebody may have just sold one.`
          });
        }
      }
      // All or nothing: one line that no longer fits sends the whole shelf back.
      if (problems.length > 0) throw new ShelfLinesProblem(problems);

      const state = await tx.spotFillState.upsert({
        where: { spotId },
        create: { clientId, locationId: spot.locationId, spotId, state: 'COMPLETED', finishedBy: userId, finishedAt: new Date(), claimedBy: null, claimedAt: null },
        update: { state: 'COMPLETED', finishedBy: userId, finishedAt: new Date(), claimedBy: null, claimedAt: null }
      });
      const first = await startFirstFill(tx, clientId, spot.locationId);
      const answer = {
        saved: true as const,
        spotId,
        address: spot.address,
        items: lines.length,
        pieces: lines.reduce((t, l) => t + l.quantity, 0),
        state: state.state,
        capacityWarning: spot.capacity ? await capacityNote(tx, spotId, spot.capacity, spot.address) : null,
        firstFillStarted: first
      };
      await tx.shelfFillSave.create({ data: { clientId, spotId, saveKey: input.saveKey, result: answer as any } });
      return answer;
    }, TX).catch((error: any) => {
      // Not an error to the person: the shelf simply is not saved yet, and the lines that need
      // changing say so beside themselves. The phone keeps everything they typed.
      if (error instanceof ShelfLinesProblem) {
        return {
          saved: false as const,
          spotId,
          address: spot.address,
          problems: error.problems,
          message: error.problems.length === 1
            ? 'Nothing was saved yet. One item needs a change.'
            : `Nothing was saved yet. ${error.problems.length} items need a change.`
        };
      }
      throw error;
    });

    if ((result as { saved?: unknown }).saved === false) return result;

    // Finishing by itself, once every shelf is done. Outside the save, so a tick of bookkeeping can
    // never undo a shelf that was recorded properly.
    const ended = await maybeFinishByItself(clientId, spot.locationId);
    return { ...result, firstFillFinished: ended };
  },

  /** Not now: it stays on the skipped list, and the walk comes back to it at the end. */
  async skipShelf(clientId: string, userId: string | null, spotId: string) {
    const spot = await prisma.storageSpot.findFirst({ where: { id: spotId, clientId }, select: { id: true, locationId: true, address: true } });
    if (!spot) throw notFound('That shelf was not found.');
    const state = await prisma.spotFillState.upsert({
      where: { spotId },
      create: { clientId, locationId: spot.locationId, spotId, state: 'SKIPPED', finishedBy: userId, finishedAt: new Date() },
      update: { state: 'SKIPPED', claimedBy: null, claimedAt: null }
    });
    return { spotId, address: spot.address, state: state.state };
  },

  /**
   * A person pressing Finished. Allowed with shelves still skipped, after the screen has named them,
   * because a real shop does stop half-way. `force` is the second press, after that warning.
   */
  async finish(clientId: string, userId: string | null, locationId: string, force: boolean) {
    await locationOf(clientId, locationId);
    const status = await fillService.status(clientId, locationId);
    if (status.firstFill.state === 'FINISHED') return { ...status, alreadyFinished: true };
    const left = status.shelves.notStarted + status.shelves.inProgress + status.shelves.skipped;
    if (left > 0 && !force) {
      return {
        ...status,
        needsConfirming: true,
        message: `${status.shelves.skipped ? `${status.shelves.skipped} ${status.shelves.skipped === 1 ? 'shelf was' : 'shelves were'} skipped` : `${left} ${left === 1 ? 'shelf has' : 'shelves have'} not been done`}` +
          `${status.piecesWaiting ? `, and ${pieces(status.piecesWaiting)} ${status.piecesWaiting === 1 ? 'is' : 'are'} still not on a shelf` : ''}. Finish anyway?`
      };
    }
    await endFirstFill(prisma, locationId, clientId, userId, false);
    return { ...(await fillService.status(clientId, locationId)), finished: true };
  },

  /** The owner opening it again, for a shop that reorganises everything. Recorded. */
  async reopen(clientId: string, userId: string | null, locationId: string) {
    await locationOf(clientId, locationId);
    const row = await prisma.locationFirstFill.findUnique({ where: { locationId } });
    if (!row || row.state !== 'FINISHED') throw badRequest('That location is not finished, so there is nothing to open again.');
    await prisma.locationFirstFill.update({
      where: { locationId },
      data: { state: 'FILLING', reopenedAt: new Date(), reopenedBy: userId, finishedAt: null, finishedBy: null, endedByItself: null }
    });
    return fillService.status(clientId, locationId);
  }
};

class ShelfLinesProblem extends Error {
  constructor(public problems: { variantId: string; title: string; asked: number; free: number; message: string }[]) {
    super('Some lines no longer fit.');
  }
}

/** How many pieces of this item at this location are on no shelf right now. */
async function freeToShelve(tx: Prisma.TransactionClient, clientId: string, locationId: string, variantId: string) {
  const [stock, shelved] = await Promise.all([
    tx.inventoryStock.findFirst({ where: { clientId, locationId, variantId }, select: { quantity: true } }),
    tx.spotStock.aggregate({ where: { clientId, locationId, variantId }, _sum: { quantity: true } })
  ]);
  return Math.max(0, (stock?.quantity ?? 0) - (shelved._sum.quantity ?? 0));
}

async function capacityNote(tx: Prisma.TransactionClient, spotId: string, capacity: number, address: string) {
  const onIt = await tx.spotStock.aggregate({ where: { spotId }, _sum: { quantity: true } });
  const total = onIt._sum.quantity ?? 0;
  // A warning only, never a refusal: the pieces really are on that shelf (R6).
  return total > capacity ? `${address} now holds ${pieces(total)}, more than the ${capacity} it is meant for.` : null;
}

/** The first shelf saved starts the first fill, which changes how a till sale picks shelves (D1). */
async function startFirstFill(tx: Prisma.TransactionClient, clientId: string, locationId: string) {
  const row = await tx.locationFirstFill.findUnique({ where: { locationId }, select: { state: true } });
  if (row && row.state !== 'NOT_STARTED') return false;
  await tx.locationFirstFill.upsert({
    where: { locationId },
    create: { clientId, locationId, state: 'FILLING', startedAt: new Date() },
    update: { state: 'FILLING', startedAt: new Date() }
  });
  return true;
}

/**
 * Ends by itself only when every shelf is COMPLETED and at least one was really filled. A shop that
 * skipped every shelf has filled nothing, so a person must press Finished instead -- otherwise the
 * till would go back to taking pieces off shelves that are still empty.
 */
async function maybeFinishByItself(clientId: string, locationId: string) {
  const row = await prisma.locationFirstFill.findUnique({ where: { locationId }, select: { state: true } });
  if (row?.state !== 'FILLING') return false;
  const targets = await fillTargets(prisma, clientId, locationId);
  if (targets.length === 0) return false;
  const states = await prisma.spotFillState.findMany({ where: { clientId, locationId }, select: { spotId: true, state: true } });
  const byId = new Map(states.map(s => [s.spotId, s.state as SpotFillStateKind]));
  const allDone = targets.every(t => byId.get(t.id) === 'COMPLETED');
  if (!allDone) return false;
  const anythingOnShelves = await prisma.spotStock.count({ where: { clientId, locationId } });
  if (anythingOnShelves === 0) return false;
  await endFirstFill(prisma, locationId, clientId, null, true);
  return true;
}

async function endFirstFill(
  db: typeof prisma,
  locationId: string,
  clientId: string,
  userId: string | null,
  byItself: boolean
) {
  await db.locationFirstFill.upsert({
    where: { locationId },
    create: { clientId, locationId, state: 'FINISHED', startedAt: new Date(), finishedAt: new Date(), finishedBy: userId, endedByItself: byItself },
    update: { state: 'FINISHED', finishedAt: new Date(), finishedBy: userId, endedByItself: byItself }
  });
}
