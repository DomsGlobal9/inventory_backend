import { badRequest } from '../../utils/httpError';

/**
 * "Take these pieces from these shelves", as a screen sends it with stock going out: a write-off, a
 * transfer, a dispatch after picking. Checked for shape here; whether the shelves exist, belong to the
 * location and hold that many is the shelf rule's job inside applyMovement.
 *
 * Returns the legs applyMovement takes (negative quantities), or undefined when none were named -- in
 * which case the rule decides, exactly as before.
 */
export function legsTakenFrom(raw: unknown, quantity: number, what = 'this item'): { spotId: string; quantity: number }[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw badRequest('Shelves to take from must be a list.');
  if (raw.length === 0) return undefined;
  if (raw.length > 50) throw badRequest('Name at most 50 shelves for one item.');
  const seen = new Set<string>();
  let total = 0;
  const legs = raw.map((leg: any) => {
    if (!leg || typeof leg.spotId !== 'string' || !leg.spotId || leg.spotId.length > 64) throw badRequest('Each shelf needs its id.');
    if (!Number.isInteger(leg.quantity) || leg.quantity <= 0) throw badRequest('Take whole pieces off a shelf, at least one.');
    if (seen.has(leg.spotId)) throw badRequest('The same shelf is listed twice. Add the pieces together instead.');
    seen.add(leg.spotId);
    total += leg.quantity;
    return { spotId: leg.spotId, quantity: -leg.quantity };
  });
  if (total > quantity) {
    throw badRequest(`The shelves chosen add up to ${total} pieces, more than the ${quantity} of ${what} going out.`);
  }
  return legs;
}
