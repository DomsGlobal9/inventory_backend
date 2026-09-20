import { InventoryReason, ShelfIssueKind, SpotLegSource } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { compareWalk, WalkKey } from './addresses';

/**
 * Which shelves a stock movement touches. Pure: no database, so every rule here is tested directly.
 *
 * The rule it keeps, for one variant at one location:
 *
 *   sum of shelf quantities  <=  the location's official quantity
 *
 * Not shelved is the difference. A movement may name shelves itself (a scan: put away, move, pick
 * from a shelf); whatever it leaves unexplained is decided here, the same way every time, and anything
 * the rule had to guess becomes an issue rather than a quiet correction.
 */

export type ShelfState = {
  spotId: string;
  address: string;
  isShopFloor: boolean;
  walkKey: WalkKey;
  quantity: number;
};

/** A spot a scanned leg may name: anything in the location, so the refusal can say why. */
export type KnownSpot = {
  spotId: string;
  address: string;
  isShopFloor: boolean;
  walkKey: WalkKey;
  active: boolean;
  hasChildren: boolean;
};

export type PlannedLeg = { spotId: string; address: string; quantity: number; source: SpotLegSource };
export type PlannedIssue = { kind: ShelfIssueKind; spotId: string; address: string; quantity: number; message: string };

export type PlanInput = {
  reason: InventoryReason;
  /** The change to the location's quantity. 0 for SHELF_MOVE. */
  delta: number;
  officialBefore: number;
  officialAfter: number;
  /** Every shelf holding this variant here, before the movement. */
  shelves: ShelfState[];
  /** Legs a person named. Positive puts pieces on a shelf, negative takes them off. */
  scanned: { spotId: string; quantity: number }[];
  /** Spots the scanned legs may refer to. */
  spots: Map<string, KnownSpot>;
  /**
   * This location is in its FIRST FILL: staff are walking the shelves recording what is on them
   * (decision D1). A till sale then takes from Not shelved first, so a shelf counted a minute ago is
   * not quietly reduced by a sale of a piece that was still in the unshelved pile. It goes back to
   * the normal rule -- shop-floor shelves first -- the moment the first fill ends.
   */
  firstFill?: boolean;
  /** For the issue wording. */
  itemName: string;
};

/** Reductions that say "this is how many there really are", rather than "these left". */
const COUNT_REASONS = new Set<InventoryReason>(['AUDIT', 'AUDIT_CORRECTION', 'MANUAL_CORRECTION']);

const pieces = (n: number) => `${n} ${n === 1 ? 'piece' : 'pieces'}`;

export function planShelfLegs(input: PlanInput): { legs: PlannedLeg[]; issues: PlannedIssue[] } {
  const { reason, delta, officialAfter, spots, itemName } = input;

  // Current quantity per shelf, updated as legs are planned.
  const onShelf = new Map<string, ShelfState>(input.shelves.map(s => [s.spotId, { ...s }]));
  const legs: PlannedLeg[] = [];
  const issues: PlannedIssue[] = [];

  // ── Legs a person named ──────────────────────────────────────────────────────────────────────
  const named = new Map<string, number>();
  for (const leg of input.scanned) {
    if (!Number.isInteger(leg.quantity)) throw badRequest('A quantity must be a whole number of pieces.');
    named.set(leg.spotId, (named.get(leg.spotId) ?? 0) + leg.quantity);
  }
  let namedTotal = 0;
  for (const [spotId, quantity] of named) {
    if (quantity === 0) continue;
    const spot = spots.get(spotId);
    if (!spot) throw notFound('That shelf was not found in this location.');
    // Direction first: the clearest reason to refuse is that the leg points the wrong way at all.
    if (reason !== 'SHELF_MOVE' && delta > 0 && quantity < 0) throw badRequest('Stock coming in can only be put onto a shelf, not taken off one.');
    if (reason !== 'SHELF_MOVE' && delta < 0 && quantity > 0) throw badRequest('Stock going out can only be taken off a shelf, not put onto one.');
    const current = onShelf.get(spotId)?.quantity ?? 0;
    if (quantity > 0) {
      if (!spot.active) throw badRequest(`${spot.address} is switched off. Switch it on, or choose another shelf.`);
      if (spot.hasChildren) throw badRequest(`${spot.address} has shelves or boxes inside it. Choose one of those.`);
    } else if (-quantity > current) {
      throw conflict(current === 0
        ? `There is no ${itemName} on ${spot.address}.`
        : `Only ${pieces(current)} of ${itemName} ${current === 1 ? 'is' : 'are'} on ${spot.address}.`);
    }
    const state =onShelf.get(spotId) ?? { spotId, address: spot.address, isShopFloor: spot.isShopFloor, walkKey: spot.walkKey, quantity: 0 };
    state.quantity += quantity;
    onShelf.set(spotId, state);
    legs.push({ spotId, address: spot.address, quantity, source: 'SCANNED' });
    namedTotal += quantity;
  }

  if (reason === 'SHELF_MOVE') {
    if (delta !== 0) throw badRequest('Moving stock between shelves does not change how much the location holds.');
    if (legs.length === 0) throw badRequest('Say which shelf the pieces come from or go to.');
  } else if (Math.abs(namedTotal) > Math.abs(delta)) {
    throw badRequest(`The shelves named add up to ${pieces(Math.abs(namedTotal))}, more than the ${pieces(Math.abs(delta))} moving.`);
  }

  const total = () => [...onShelf.values()].reduce((sum, s) => sum + s.quantity, 0);

  // Nothing comes off a shelf when stock arrives or merely moves: it only has to fit.
  if (delta >= 0) {
    const shelved = total();
    if (shelved > officialAfter) {
      const free = Math.max(0, officialAfter - (shelved - Math.max(0, namedTotal)));
      throw conflict(free === 0
        ? `Every piece of ${itemName} here is already on a shelf. Move it from its shelf instead.`
        : `Only ${pieces(free)} of ${itemName} ${free === 1 ? 'is' : 'are'} not on a shelf here.`);
    }
    return { legs, issues };
  }

  // ── A reduction: the pieces not accounted for by named shelves ──────────────────────────────
  const take = (state: ShelfState, n: number, source: SpotLegSource) => {
    state.quantity -= n;
    const existing = legs.find(l => l.spotId === state.spotId && l.source === source);
    if (existing) existing.quantity -= n;
    else legs.push({ spotId: state.spotId, address: state.address, quantity: -n, source });
  };
  const stocked = () => [...onShelf.values()].filter(s => s.quantity > 0);
  const inWalk = (list: ShelfState[]) => list.sort(compareWalk);

  if (reason === 'SALE') {
    // Decision 1: a till sale comes off shop-floor shelves in walking order, then Not shelved.
    // During a first fill (D1) that is turned around: Not shelved is used first, and a shelf is only
    // touched once Not shelved has run out.
    if (!input.firstFill) {
      let remaining = -delta - Math.abs(namedTotal);
      for (const shelf of inWalk(stocked().filter(s => s.isShopFloor))) {
        if (remaining === 0) break;
        const n = Math.min(remaining, shelf.quantity);
        take(shelf, n, 'AUTO');
        remaining -= n;
      }
    }
    // Whatever Not shelved could not cover came from the back room, without anyone moving it first.
    // A shop with NO shop-floor shelves at all (everything in a godown, sold at a counter) is not
    // doing anything odd: every sale would otherwise raise an issue and an alert, for ever.
    const hasFloorShelves = [...spots.values()].some(s => s.isShopFloor);
    let excess = total() - officialAfter;
    for (const shelf of inWalk(stocked().filter(s => !s.isShopFloor))) {
      if (excess <= 0) break;
      const n = Math.min(excess, shelf.quantity);
      take(shelf, n, 'AUTO');
      excess -= n;
      if (!hasFloorShelves) continue;
      issues.push({
        kind: 'SOLD_FROM_BACK_ROOM', spotId: shelf.spotId, address: shelf.address, quantity: n,
        message: `${pieces(n)} of ${itemName} sold at the till came from ${shelf.address}, which is not on the shop floor. ` +
          'Nothing was moved to the floor first, so check that shelf.'
      });
    }
    // Only during a first fill: Not shelved ran out, so the piece sold did come off a floor shelf.
    // The rule must never leave more on the shelves than the location holds.
    for (const shelf of inWalk(stocked().filter(s => s.isShopFloor))) {
      if (excess <= 0) break;
      const n = Math.min(excess, shelf.quantity);
      take(shelf, n, 'AUTO');
      excess -= n;
      issues.push({
        kind: 'AUTO_TAKEN_FROM_SHELF', spotId: shelf.spotId, address: shelf.address, quantity: n,
        message: `${pieces(n)} of ${itemName} sold at the till while the shelves were being filled. Nothing was left ` +
          `off the shelves, so ${n === 1 ? 'it was' : 'they were'} taken off ${shelf.address}. Check that shelf.`
      });
    }
    return { legs, issues };
  }

  let excess = total() - officialAfter;
  if (excess <= 0) return { legs, issues };

  if (COUNT_REASONS.has(reason)) {
    // A count found fewer pieces than the shelves claimed. The count is the truth about the location;
    // which shelf was wrong is not known, so take from the back room first and ask for a recount.
    const order = [
      ...inWalk(stocked().filter(s => !s.isShopFloor)).reverse(),
      ...inWalk(stocked().filter(s => s.isShopFloor)).reverse()
    ];
    for (const shelf of order) {
      if (excess <= 0) break;
      const n = Math.min(excess, shelf.quantity);
      take(shelf, n, 'AUTO');
      excess -= n;
      issues.push({
        kind: 'COUNT_BELOW_SHELVES', spotId: shelf.spotId, address: shelf.address, quantity: n,
        message: `A count found fewer pieces of ${itemName} than the shelves said. ${pieces(n)} ${n === 1 ? 'was' : 'were'} taken off ` +
          `${shelf.address} to match. Recount that shelf.`
      });
    }
    return { legs, issues };
  }

  // Anything else going out with no shelf named: Not shelved has been used up, so the rest comes off
  // shelves in walking order, and the shop is told.
  for (const shelf of inWalk(stocked())) {
    if (excess <= 0) break;
    const n = Math.min(excess, shelf.quantity);
    take(shelf, n, 'AUTO');
    excess -= n;
    issues.push({
      kind: 'AUTO_TAKEN_FROM_SHELF', spotId: shelf.spotId, address: shelf.address, quantity: n,
      message: `${pieces(n)} of ${itemName} went out (${reason.replace(/_/g, ' ').toLowerCase()}) without a shelf being chosen, ` +
        `so ${n === 1 ? 'it was' : 'they were'} taken off ${shelf.address}. Check that shelf.`
    });
  }
  return { legs, issues };
}
