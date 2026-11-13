/**
 * Cloth by the metre in the online shop (13 Nov 2026, PLAN-fabrics.md). The same rules as the backend's
 * src/lib/units.ts, kept in step by hand: a metre product's quantities are centimetres (225 = 2.25 m) and its price
 * arrives per centimetre (4.50 = ₹450 per metre). Pieces and packets: factor 1, as always.
 */
export const isMetre = (soldBy) => soldBy === 'METRE';
const FACTOR = { METRE: 100, KILOGRAM: 1000 };
export const factorOf = (soldBy) => FACTOR[soldBy] ?? 1;

/** "2.25 m" for 225 cm; "3" for pieces. */
export const lengthText = (cm) => `${(Number(cm) / 100).toFixed(2)} m`;

/** The price per metre for a per-centimetre price (4.50 -> 450). */
export const perMetre = (perCm) => Math.round(Number(perCm) * 100 * 100) / 100;

/** The smallest sale in cm: the product's own, else the shop's, else 25 (0.25 m). */
export const cutOf = (product, shopLengths) => {
  const own = Number(product?.minCut);
  if (Number.isInteger(own) && own > 0) return own;
  const shop = Number(shopLengths?.minCut);
  return Number.isInteger(shop) && shop > 0 ? shop : 25;
};

/** A length rounded UP to the next multiple of the cut (so a 2.5 m quick length with a 1 m cut becomes 3 m). */
export const toCut = (cm, cut) => Math.max(cut, Math.ceil(Number(cm) / cut) * cut);

/** The most one bag line may hold: 100 m of cloth, 10 of anything else. */
export const lineMax = (soldBy) => (isMetre(soldBy) ? 10_000 : 10);

/** How many ITEMS a line is, for the bag count: a length is one item, never 225. */
export const itemsIn = (line) => (isMetre(line?.soldBy) ? 1 : Number(line?.quantity) || 0);
