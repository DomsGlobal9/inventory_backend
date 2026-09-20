import type { StorageSpotKind } from '@prisma/client';
import { badRequest } from '../../utils/httpError';
import { CodeRange, expandCodes, joinAddress, MAX_BULK, MAX_DEPTH } from './addresses';

/**
 * "Describe your shop": the answers turned into a list of spots to create, with no database.
 *
 * The rules it keeps (PLAN-shelves-onboarding.md):
 *
 *   R2  It only ever CREATES what is missing. Nothing here deletes, renames, re-kinds, switches off
 *       or reorders a spot that exists, so answering again later never replaces a shop's layout.
 *   R3  Preview and save both call this one function, so what preview showed as `created` is exactly
 *       what save creates.
 *   R4  Every limit is checked here, on the server.
 *
 * Deterministic: the same specification and the same snapshot always give the same rows in the same
 * order, whatever the timing. That is why it holds no ids, no clock and no randomness -- ids, label
 * codes and the write itself belong to the caller, after it has taken the lock and read the snapshot
 * again.
 *
 * A branch that cannot be built (something switched off, renamed away, or holding stock) is marked
 * and everything under it is skipped; the racks either side of it are still created.
 */

export type SetupLevel = {
  kind: StorageSpotKind;
  range: CodeRange;
  /**
   * How many children to create under each parent the level above produced, in generation order.
   * `perParent[j]` takes the FIRST `perParent[j]` codes of this level's range. Left out: every
   * parent gets every code. Not allowed on the first level, which has one parent.
   */
  perParent?: number[];
};

export type SetupSpec = {
  /** Build inside this spot (its id in the snapshot's `parent`), or at the top when null. */
  parentId?: string | null;
  /** Shop floor or back room, for a first level of areas. Never changes an area that exists. */
  isShopFloor?: boolean;
  levels: SetupLevel[];
};

/** One spot of the location, as it is now. */
export type SnapshotSpot = {
  id: string;
  parentId: string | null;
  address: string;
  kind: StorageSpotKind;
  depth: number;
  active: boolean;
  isShopFloor: boolean;
  walkOrder: number;
  /** Pieces sit on this spot itself. Nothing can be created inside it. */
  hasStock: boolean;
};

export type Snapshot = {
  spots: SnapshotSpot[];
  /**
   * Addresses that were used before and renamed away, with what they are called now: R01 -> SILK.
   * Latest rename per old address. Used so an answer does not build a second R01 beside the rack
   * the shop renamed.
   */
  renamedAway?: { oldAddress: string; newAddress: string }[];
  /** The spot named by `spec.parentId`, when there is one. */
  parent?: SnapshotSpot | null;
};

export type SetupOutcome = 'created' | 'already_exists' | 'conflict' | 'skipped';

export type PlannedSpot = {
  level: number;
  address: string;
  code: string;
  kind: StorageSpotKind;
  depth: number;
  parentAddress: string | null;
  /** The parent's id when it exists already; null at the top; undefined when the parent is new. */
  parentId?: string | null;
  isShopFloor: boolean;
  walkOrder: number;
  outcome: SetupOutcome;
  /** Why it was not created, in words for the shop. */
  reason?: string;
  /** Something true about a spot that exists and is left exactly as it is. */
  note?: string;
  /** The spot already there, for `already_exists`. */
  existingId?: string;
};

export type SetupPlan = {
  spots: PlannedSpot[];
  counts: { created: number; alreadyThere: number; conflict: number; skipped: number };
  /** Every address to be created, in order. */
  addresses: string[];
};

const WALK_STEP = 10;

/** How many spots each level makes, before anything is generated (R4, and the 2000 limit). */
function levelCounts(levels: { codes: string[]; perParent?: number[] }[]): number[] {
  const counts: number[] = [];
  let parents = 1;
  levels.forEach((level, i) => {
    const per = level.perParent;
    if (per) {
      if (i === 0) throw badRequest('The first level has one parent, so it cannot have a different number for each parent.');
      if (per.length !== parents) {
        throw badRequest(`Level ${i + 1}: give one number for each of the ${parents} above it, not ${per.length}.`);
      }
      for (const n of per) {
        if (!Number.isInteger(n) || n < 0) throw badRequest(`Level ${i + 1}: how many must be a whole number, 0 or more.`);
        if (n > level.codes.length) {
          throw badRequest(`Level ${i + 1}: ${n} is more than the ${level.codes.length} codes named for this level.`);
        }
      }
      counts.push(per.reduce((t, n) => t + n, 0));
    } else {
      counts.push(parents * level.codes.length);
    }
    parents = counts[i];
    if (counts[i] === 0 && i < levels.length - 1) {
      throw badRequest(`Level ${i + 1} makes nothing, so the levels inside it cannot be made either.`);
    }
  });
  return counts;
}

export function planSetup(spec: SetupSpec, snapshot: Snapshot): SetupPlan {
  const parent = snapshot.parent ?? null;
  if (spec.parentId && !parent) throw badRequest('The rack or shelf to add these under was not found in this location.');
  if (parent && spec.isShopFloor !== undefined) {
    throw badRequest('Shop floor or back room is set on the area, and everything inside it follows.');
  }
  if (!spec.levels?.length) throw badRequest('Add at least one level.');
  if (spec.levels.length > MAX_DEPTH) throw badRequest(`At most ${MAX_DEPTH} levels.`);

  const levels = spec.levels.map((l, i) => ({
    kind: l.kind,
    codes: expandCodes(l.range, `Level ${i + 1}`),
    perParent: l.perParent
  }));

  if ((parent?.depth ?? 0) + levels.length > MAX_DEPTH) {
    throw badRequest(`That would be ${(parent?.depth ?? 0) + levels.length} levels deep. At most ${MAX_DEPTH}: area, rack, shelf, box.`);
  }

  const counts = levelCounts(levels);
  const total = counts.reduce((t, n) => t + n, 0);
  if (total > MAX_BULK) {
    throw badRequest(`That makes ${total} spots. At most ${MAX_BULK} at once: split it into smaller groups.`);
  }

  // Sorted by address, never in whatever order the database returned them: same snapshot, same plan.
  const spots = [...snapshot.spots].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const byAddress = new Map(spots.map(s => [s.address, s]));
  const renamedAway = new Map((snapshot.renamedAway ?? []).map(r => [r.oldAddress, r.newAddress]));

  // The next walking number under a parent: after everything already there, ten apart. A spot's
  // parent address is its own address without the last part ("FLOOR-C1-2" -> "FLOOR-C1", "FLOOR" -> "").
  const parentAddressOf = (address: string) => {
    const cut = address.lastIndexOf('-');
    return cut === -1 ? '' : address.slice(0, cut);
  };
  const highestWalk = new Map<string, number>();
  for (const s of spots) {
    const key = parentAddressOf(s.address);
    highestWalk.set(key, Math.max(highestWalk.get(key) ?? 0, s.walkOrder));
  }
  const nextWalk = new Map<string, number>();
  const walkAfter = (parentKey: string) => {
    const value = (nextWalk.get(parentKey) ?? highestWalk.get(parentKey) ?? 0) + WALK_STEP;
    nextWalk.set(parentKey, value);
    return value;
  };

  type Holder = {
    address: string | null;
    id?: string | null;
    depth: number;
    isShopFloor: boolean;
    /** Set when nothing can be built inside this one. */
    blocked?: { outcome: 'conflict' | 'skipped'; reason: string };
  };

  let frontier: Holder[] = [{
    address: parent?.address ?? null,
    id: parent?.id ?? null,
    depth: parent?.depth ?? 0,
    isShopFloor: parent ? parent.isShopFloor : spec.isShopFloor ?? true,
    blocked: parent && !parent.active
      ? { outcome: 'conflict', reason: `${parent.address} is switched off. Switch it on first, or choose another place.` }
      : parent?.hasStock
        ? { outcome: 'conflict', reason: `${parent.address} holds stock. Move it off first, then add shelves or boxes inside it.` }
        : undefined
  }];

  const planned: PlannedSpot[] = [];

  levels.forEach((level, i) => {
    const next: Holder[] = [];
    frontier.forEach((holder, j) => {
      const codes = level.perParent ? level.codes.slice(0, level.perParent[j]) : level.codes;
      for (const code of codes) {
        const address = joinAddress(holder.address, code);
        const depth = holder.depth + 1;

        // Its parent could not be built, or is in the way: this one is skipped, and so is everything
        // inside it. The reason names the spot the shop can act on.
        if (holder.blocked) {
          const row: PlannedSpot = {
            level: i, address, code, kind: level.kind, depth, parentAddress: holder.address,
            parentId: holder.id ?? null, isShopFloor: holder.isShopFloor, walkOrder: 0,
            outcome: 'skipped', reason: holder.blocked.reason
          };
          planned.push(row);
          next.push({ address, depth, isShopFloor: holder.isShopFloor, blocked: { outcome: 'skipped', reason: holder.blocked.reason } });
          continue;
        }

        const found = byAddress.get(address);
        const renamedTo = renamedAway.get(address);

        if (found) {
          const notes: string[] = [];
          if (found.kind !== level.kind) notes.push(`kept as it is, a ${word(found.kind)}`);
          if (depth === 1 && found.isShopFloor !== holder.isShopFloor) {
            notes.push(`kept where it is, in the ${found.isShopFloor ? 'shop floor' : 'back room'}`);
          }
          const blocked = !found.active
            ? { outcome: 'conflict' as const, reason: `${address} is switched off. Switch it on in Racks & shelves, or leave it out.` }
            : found.hasStock && i < levels.length - 1
              ? { outcome: 'conflict' as const, reason: `${address} holds stock. Move it off first, then add shelves or boxes inside it.` }
              : undefined;

          planned.push({
            level: i, address, code, kind: found.kind, depth, parentAddress: holder.address,
            parentId: holder.id ?? null, isShopFloor: found.isShopFloor, walkOrder: found.walkOrder,
            outcome: !found.active ? 'conflict' : 'already_exists',
            existingId: found.id,
            reason: !found.active ? blocked?.reason : undefined,
            note: found.active && notes.length ? notes.join('; ') : undefined
          });
          next.push({ address, id: found.id, depth: found.depth, isShopFloor: found.isShopFloor, blocked });
          continue;
        }

        if (renamedTo && byAddress.has(renamedTo)) {
          const reason = `${address} was renamed to ${renamedTo}, which is still there. It is not made a second time.`;
          planned.push({
            level: i, address, code, kind: level.kind, depth, parentAddress: holder.address,
            parentId: holder.id ?? null, isShopFloor: holder.isShopFloor, walkOrder: 0,
            outcome: 'conflict', reason
          });
          next.push({ address, depth, isShopFloor: holder.isShopFloor, blocked: { outcome: 'skipped', reason } });
          continue;
        }

        planned.push({
          level: i, address, code, kind: level.kind, depth, parentAddress: holder.address,
          parentId: holder.id ?? null, isShopFloor: holder.isShopFloor,
          walkOrder: walkAfter(holder.address ?? ''),
          outcome: 'created'
        });
        next.push({ address, depth, isShopFloor: holder.isShopFloor });
      }
    });
    frontier = next;
  });

  const tally = { created: 0, alreadyThere: 0, conflict: 0, skipped: 0 };
  for (const p of planned) {
    if (p.outcome === 'created') tally.created++;
    else if (p.outcome === 'already_exists') tally.alreadyThere++;
    else if (p.outcome === 'conflict') tally.conflict++;
    else tally.skipped++;
  }

  return { spots: planned, counts: tally, addresses: planned.filter(p => p.outcome === 'created').map(p => p.address) };
}

const word = (kind: StorageSpotKind) => kind.toLowerCase().replace(/_/g, ' ');
