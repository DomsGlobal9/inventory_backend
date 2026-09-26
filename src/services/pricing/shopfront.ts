/**
 * What a shop window may honestly say about an offer, before anything is in a bag.
 *
 * An offer was invisible until the shopper reached the bag. Nothing on the shop page, nothing on
 * the product page -- a fifteen per cent sale ran and the only people who found out were the ones
 * who had already decided to buy. The offers engine knew all along; nobody asked it.
 *
 * This answers the one question a tile needs: BUYING JUST THIS ONE PIECE, what comes off? That
 * qualifier is the whole point. "15% off when you spend 10,000" printed on a 6,400 saree is a
 * promise the bag then breaks, and a shopper who feels tricked at the last step is worse off than
 * one who was told nothing. So an offer with a minimum this single piece does not meet is left
 * out here, and the bag's own "add 3,600 more and you get it" picks it up instead.
 *
 * It reads publicOffers -- the same list handed to third-party storefronts, with targets already
 * turned into the codes a shop front knows. One matcher, here, rather than one in our shop app
 * and another in every integrator's: the rules about case-blind dress types and exclusions
 * beating targets are not obvious, and two copies of them would not stay the same for long.
 *
 * PURE. No database, no clock: the caller has already decided which offers are live.
 */

/** One entry of pricingQuoteService.publicOffers. */
export interface PublicOffer {
  name: string;
  valueType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FIXED_PRICE';
  value: number;
  maxDiscount: number | null;
  scope: 'ALL' | 'CATEGORY' | 'DRESS_TYPE' | 'PRODUCT' | 'VARIANT';
  appliesTo: {
    categories?: string[];
    dressTypes?: string[];
    productCodes?: string[];
    variantCodes?: string[];
  } | null;
  minSubtotal: number | null;
  minQuantity: number | null;
  perPiece?: boolean;
  excludes?: {
    categories?: string[];
    dressTypes?: string[];
    productCodes?: string[];
    variantCodes?: string[];
  } | null;
}

/** One buyable piece, as a shop front knows it. */
export interface ShopPiece {
  productCode: string;
  variantCode: string;
  category?: string | null;
  dressType?: string | null;
  /** The list price of ONE, in the shop's currency (not paise). */
  price: number;
}

/** What a tile may say. `saves` is for one piece, and is only used to pick the best offer. */
export interface ShopWindowOffer {
  name: string;
  kind: 'PERCENT' | 'AMOUNT' | 'PRICE';
  /** The percentage, the amount off, or the price it becomes. */
  value: number;
  saves: number;
}

/** "Saree", "saree " and "SAREE" are the same shelf -- the same rule the engine matches by. */
const same = (a: unknown, b: unknown) =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

function listed(where: PublicOffer['appliesTo'] | PublicOffer['excludes'], piece: ShopPiece): boolean {
  if (!where) return false;
  if (where.categories?.some(c => same(c, piece.category))) return true;
  if (where.dressTypes?.some(d => same(d, piece.dressType))) return true;
  if (where.productCodes?.includes(piece.productCode)) return true;
  if (where.variantCodes?.includes(piece.variantCode)) return true;
  return false;
}

/** Does this offer cover this piece at all? An exclusion beats any target, as in the engine. */
export function covers(offer: PublicOffer, piece: ShopPiece): boolean {
  if (listed(offer.excludes ?? null, piece)) return false;
  if (offer.scope === 'ALL') return true;
  return listed(offer.appliesTo, piece);
}

/**
 * What one piece saves under this offer, or 0.
 *
 * Deliberately refuses an offer whose conditions one piece cannot meet. A minimum spend above
 * this piece's price, or a minimum quantity above one, means the shopper does NOT get this by
 * buying the thing they are looking at -- so the window must not claim they do.
 */
export function savingOnOne(offer: PublicOffer, piece: ShopPiece): number {
  if (!covers(offer, piece)) return 0;
  if (offer.minQuantity != null && offer.minQuantity > 1) return 0;
  if (offer.minSubtotal != null && piece.price < offer.minSubtotal) return 0;

  const price = Number(piece.price);
  if (!Number.isFinite(price) || price <= 0) return 0;

  let off: number;
  if (offer.valueType === 'PERCENTAGE') off = (price * Number(offer.value)) / 100;
  else if (offer.valueType === 'FIXED_AMOUNT') off = Number(offer.value);
  else off = price - Number(offer.value);          // FIXED_PRICE: down to this

  if (!Number.isFinite(off) || off <= 0) return 0;
  if (offer.maxDiscount != null) off = Math.min(off, Number(offer.maxDiscount));
  // Never more than the piece is worth: a 500-off rule on a 300 blouse takes 300, not 500.
  return Math.min(off, price);
}

/** The best thing this piece can honestly be labelled with, or nothing. */
export function windowOfferFor(offers: PublicOffer[], piece: ShopPiece): ShopWindowOffer | null {
  let best: ShopWindowOffer | null = null;
  for (const o of offers) {
    const saves = savingOnOne(o, piece);
    if (saves <= 0) continue;
    // Ties broken by name so the same basket always shows the same badge rather than whichever
    // the database happened to return first.
    if (best && (saves < best.saves || (saves === best.saves && o.name >= best.name))) continue;
    best = {
      name: o.name,
      kind: o.valueType === 'PERCENTAGE' ? 'PERCENT' : o.valueType === 'FIXED_AMOUNT' ? 'AMOUNT' : 'PRICE',
      value: Number(o.value),
      saves
    };
  }
  return best;
}

/**
 * The one badge a PRODUCT tile may wear.
 *
 * Only when every piece a shopper could actually buy gets the same offer. A tile is one word
 * about a whole product, and "15% off" over a product where only the small size qualifies is a
 * promise three of the four sizes break. Where it differs, the tile says nothing and the product
 * page shows the truth per size.
 */
export function windowOfferForProduct(
  offers: PublicOffer[],
  pieces: ShopPiece[]
): ShopWindowOffer | null {
  if (pieces.length === 0) return null;
  const each = pieces.map(p => windowOfferFor(offers, p));
  const first = each[0];
  if (!first) return null;
  if (!each.every(o => o && o.name === first.name && o.kind === first.kind && o.value === first.value)) return null;
  return first;
}
