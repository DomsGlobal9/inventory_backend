/**
 * What a basket costs.
 *
 * This is the thing the whole Offers project exists to produce. A till asks it, a merchant's own
 * website asks it, and both get the same answer -- which is the point: the website's developer
 * never sees the rules, so they cannot implement them slightly differently. Shopify is the
 * exception and always will be, because Shopify owns its checkout and cannot be made to ask;
 * there we push a copy of the rule instead and reconcile afterwards.
 *
 * PURE. Everything it needs is handed to it: the lines with their catalogue prices already
 * resolved, and the offers already loaded and filtered to this shop. No database, no clock of its
 * own, no randomness. That is what makes the awkward cases -- two offers competing for one line,
 * a discount that does not divide, a condition missed only because another offer applied first --
 * testable without a tenant existing.
 *
 * Money is in paise throughout, and every split goes through `allocate`, so the parts always add
 * up to the whole.
 */

import { allocate, netUnitPrice } from './money';
import { discountFor, compareCandidates } from '../offers/rules';

export interface BasketLine {
  variantId: string;
  quantity: number;
  /** Already resolved through resolveVariantForLocation -- the engine never re-prices. */
  listUnitPriceMinor: number;
  /** For matching an offer's targets. */
  productId: string;
  category: string | null;
  /** Product.dressType -- Saree, Lehenga. Matched case-blind and trimmed, as a shop types it. */
  dressType?: string | null;
  sku?: string;
  title?: string;
}

/** An offer, flattened to what pricing actually needs. */
export interface CandidateOffer {
  id: string;
  versionId: string | null;
  name: string;
  trigger: 'AUTOMATIC' | 'CODE';
  couponCode: string | null;
  level: 'LINE' | 'ORDER';
  valueType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FIXED_PRICE';
  value: any;
  maxDiscount: any;
  scope: 'ALL' | 'CATEGORY' | 'DRESS_TYPE' | 'PRODUCT' | 'VARIANT';
  targets: { scope: string; refId: string }[];
  minSubtotalMinor: number | null;
  minQuantity: number | null;
  priority: number;
  stackable: boolean;
  createdAt: Date;
  /** FIXED_AMOUNT on items: off every piece rather than once per line. */
  perPiece?: boolean;
  /** What it leaves out, whatever it applies to. */
  exclusions?: { scope: string; refId: string }[];
  /**
   * Single-use codes the customer gave that belong to this offer and are still unspent. Loaded by
   * the quote service for exactly the codes given, never the whole batch.
   */
  acceptedCodes?: string[];
}

export interface AppliedOffer {
  offerId: string;
  offerVersionId: string | null;
  title: string;
  amountMinor: number;
  level: 'LINE' | 'ORDER';
  /** The code that unlocked it, when a code did. A single-use code is spent against this. */
  code?: string | null;
}

export interface PricedBasketLine {
  variantId: string;
  sku?: string;
  title?: string;
  quantity: number;
  listUnitPriceMinor: number;
  discountMinor: number;
  netUnitPriceMinor: number;
  lineTotalMinor: number;
  appliedOffers: AppliedOffer[];
}

export interface PricedBasket {
  lines: PricedBasketLine[];
  discounts: AppliedOffer[];
  subtotalMinor: number;
  discountTotalMinor: number;
  totalMinor: number;
  /** Codes the customer gave that did nothing, and why. Never a bare "invalid code". */
  rejected: { code: string; reason: string }[];
  /** Offers that ALMOST applied. "Spend ₹80 more" is worth more than silence. */
  nearMisses: { offerId: string; title: string; reason: string }[];
}

export const normaliseType = (v: string | null | undefined) => String(v ?? '').trim().toLowerCase();

/** Does one target name this line? */
function hits(target: { scope: string; refId: string }, line: BasketLine): boolean {
  switch (target.scope) {
    case 'CATEGORY':
      return !!line.category && target.refId === line.category;
    case 'DRESS_TYPE': {
      // "Saree", "saree " and "SAREE" are the same shelf. The product form is free text, so the
      // comparison forgives what a person typing it would never notice.
      const type = normaliseType(line.dressType);
      return !!type && normaliseType(target.refId) === type;
    }
    case 'PRODUCT':
      return target.refId === line.productId;
    case 'VARIANT':
      return target.refId === line.variantId;
    default:
      return false;
  }
}

/** Is this line one the offer leaves out? An exclusion beats any target. */
function excluded(offer: CandidateOffer, line: BasketLine): boolean {
  return (offer.exclusions ?? []).some(e => hits(e, line));
}

/** Does this offer apply to this line at all? */
function matches(offer: CandidateOffer, line: BasketLine): boolean {
  if (excluded(offer, line)) return false;
  if (offer.scope === 'ALL') return true;
  return offer.targets.some(t => hits({ scope: offer.scope, refId: t.refId }, line));
}

/**
 * Price a basket.
 *
 * `offers` must already be filtered to those that are live, on this channel and at this location.
 * Deciding that needs a clock and a database, and this function has neither on purpose.
 *
 * `coupons` are the codes the customer actually gave, upper-cased.
 */
export function priceBasket(
  lines: BasketLine[],
  offers: CandidateOffer[],
  coupons: string[] = []
): PricedBasket {
  const given = new Set(coupons.map(c => c.trim().toUpperCase()).filter(Boolean));

  const priced: PricedBasketLine[] = lines.map(l => ({
    variantId: l.variantId,
    sku: l.sku,
    title: l.title,
    quantity: l.quantity,
    listUnitPriceMinor: l.listUnitPriceMinor,
    discountMinor: 0,
    netUnitPriceMinor: l.listUnitPriceMinor,
    lineTotalMinor: l.listUnitPriceMinor * l.quantity,
    appliedOffers: []
  }));

  const subtotalMinor = priced.reduce((s, l) => s + l.lineTotalMinor, 0);
  const totalQuantity = lines.reduce((s, l) => s + l.quantity, 0);

  const rejected: { code: string; reason: string }[] = [];
  const nearMisses: { offerId: string; title: string; reason: string }[] = [];

  /*
   * A code the customer typed that belongs to no offer here.
   *
   * Worth saying separately from "your basket does not qualify": one is a typo and the other is
   * an instruction to add something. "Invalid code" at a till with a customer waiting tells
   * nobody which.
   */
  const knownCodes = new Set([
    ...offers.filter(o => o.trigger === 'CODE' && o.couponCode).map(o => o.couponCode!.toUpperCase()),
    ...offers.flatMap(o => (o.acceptedCodes ?? []).map(c => c.toUpperCase()))
  ]);
  for (const code of given) {
    if (!knownCodes.has(code)) {
      rejected.push({ code, reason: 'There is no offer with that code.' });
    }
  }

  /**
   * The code that unlocks an offer in this basket, if any. A single-use code is one per offer: a
   * customer giving two of the same batch spends one, and the other stays good for next time.
   */
  const unlockingCode = (o: CandidateOffer): string | null => {
    if (o.couponCode && given.has(o.couponCode.toUpperCase())) return o.couponCode.toUpperCase();
    const single = (o.acceptedCodes ?? []).map(c => c.toUpperCase()).filter(c => given.has(c)).sort()[0];
    return single ?? null;
  };

  /** Usable at all: an automatic offer, or a code offer whose code was given. */
  const usable = offers.filter(o => o.trigger === 'AUTOMATIC' || unlockingCode(o) != null);
  const codeOf = (o: CandidateOffer) => (o.trigger === 'CODE' ? unlockingCode(o) : null);

  /** Whether the basket meets an offer's conditions, and what to say when it does not. */
  const conditionsMet = (offer: CandidateOffer, againstMinor: number, againstQuantity = totalQuantity): string | null => {
    if (offer.minSubtotalMinor != null && againstMinor < offer.minSubtotalMinor) {
      const short = offer.minSubtotalMinor - againstMinor;
      return `Spend ${(short / 100).toFixed(2)} more to get this.`;
    }
    if (offer.minQuantity != null && againstQuantity < offer.minQuantity) {
      return `Add ${offer.minQuantity - againstQuantity} more item(s) to get this.`;
    }
    return null;
  };

  /*
   * A per-item offer's minimums count only the items it COVERS.
   *
   * "Buy 2 sarees, get 10% off sarees" was satisfied by one saree and one blouse, and "10% off
   * sarees when you spend 15,000 on sarees" by a 10,000 saree and 6,000 of blouses -- the conditions
   * were measured against the whole basket. That is not what either offer says, and it is not what
   * Shopify does either: a product discount's minimum requirement applies to its selected items, so a
   * copy on Shopify and the till would have charged the same basket differently.
   *
   * For an offer on everything the covered items ARE the basket, so nothing changes there.
   */
  const coveredBy = new Map<string, { minor: number; quantity: number }>();
  const covered = (offer: CandidateOffer) => {
    let hit = coveredBy.get(offer.id);
    if (!hit) {
      hit = lines.reduce((acc, l) => matches(offer, l)
        // At LIST price, as the basket's own subtotal is -- measured before any offer has touched a
        // line, so the answer cannot depend on which line happened to be priced first.
        ? { minor: acc.minor + l.listUnitPriceMinor * l.quantity, quantity: acc.quantity + l.quantity }
        : acc, { minor: 0, quantity: 0 });
      coveredBy.set(offer.id, hit);
    }
    return hit;
  };

  // ── LINE-LEVEL ─────────────────────────────────────────────────────────────
  const lineOffers = usable.filter(o => o.level === 'LINE');

  for (let i = 0; i < priced.length; i++) {
    const line = priced[i];
    const source = lines[i];

    const eligible = lineOffers.filter(o => matches(o, source));
    if (eligible.length === 0) continue;

    /*
     * Non-stackable offers COMPETE; only the best one applies.
     *
     * This is Shopify's own rule for product discounts, adopted deliberately so that ours and
     * theirs agree by default rather than by accident -- an offer mirrored into Shopify should
     * not price differently there.
     */
    const exclusive = eligible.filter(o => !o.stackable);
    const stackable = eligible.filter(o => o.stackable);

    let running = line.lineTotalMinor;

    if (exclusive.length > 0) {
      const scored = exclusive.map(o => {
        const condition = conditionsMet(o, covered(o).minor, covered(o).quantity);
        return {
          offer: o,
          blocked: condition,
          amountMinor: condition ? 0 : discountFor({ ...o, perPiece: !!o.perPiece }, running, line.quantity),
          priority: o.priority,
          createdAt: o.createdAt,
          id: o.id
        };
      });

      const winner = scored.filter(s => !s.blocked && s.amountMinor > 0).sort(compareCandidates)[0];

      if (winner) {
        running -= winner.amountMinor;
        line.appliedOffers.push({
          offerId: winner.offer.id, offerVersionId: winner.offer.versionId,
          title: winner.offer.name, amountMinor: winner.amountMinor, level: 'LINE',
          code: codeOf(winner.offer)
        });
        // Everything it beat is a near miss worth nothing to say -- the customer lost nothing.
        // Only a BLOCKED offer is worth reporting, and that is done below.
      }

      for (const s of scored) {
        if (s.blocked) nearMisses.push({ offerId: s.offer.id, title: s.offer.name, reason: s.blocked });
      }
    }

    // Stackable ones apply after, each on what is left.
    for (const o of stackable.sort((a, b) => b.priority - a.priority)) {
      const condition = conditionsMet(o, covered(o).minor, covered(o).quantity);
      if (condition) {
        nearMisses.push({ offerId: o.id, title: o.name, reason: condition });
        continue;
      }
      const amountMinor = discountFor({ ...o, perPiece: !!o.perPiece }, running, line.quantity);
      if (amountMinor <= 0) continue;
      running -= amountMinor;
      line.appliedOffers.push({
        offerId: o.id, offerVersionId: o.versionId, title: o.name, amountMinor, level: 'LINE',
        code: codeOf(o)
      });
    }

    // Never below nothing. A line sold for less than zero is not a discount, it is a payout.
    if (running < 0) running = 0;

    line.lineTotalMinor = running;
    line.discountMinor = line.listUnitPriceMinor * line.quantity - running;
    line.netUnitPriceMinor = netUnitPrice(running, line.quantity);
  }

  // ── ORDER-LEVEL ────────────────────────────────────────────────────────────
  /*
   * Conditions are checked against the subtotal AFTER line discounts.
   *
   * This is the case merchants are caught by: "500 off over 20,000" on a basket that comes to
   * 19,920 once a line offer has applied. It genuinely does not qualify, and the engine reports
   * it as a near miss with the shortfall rather than silently doing nothing.
   */
  const discounts: AppliedOffer[] = [];

  /*
   * Which bill offer goes first: higher priority, then the one worth MORE to this customer, then
   * older. Sorting on priority and age alone let an older 100 off beat a newer 300-off card on the
   * same bill -- the customer handed over a card and got the worse deal. Worth is measured the way
   * the offer will actually apply: after line discounts, on the part of the bill it covers.
   */
  const worthOf = new Map<string, number>();
  for (const o of usable.filter(x => x.level === 'ORDER')) {
    const inBill = lines.map(l => !excluded(o, l));
    const base = priced.reduce((s, l, i) => s + (inBill[i] ? l.lineTotalMinor : 0), 0);
    const qty = lines.reduce((s, l, i) => s + (inBill[i] ? l.quantity : 0), 0);
    worthOf.set(o.id, conditionsMet(o, base, qty) ? 0 : Math.min(discountFor({ ...o, perPiece: false }, base, qty), base));
  }
  const orderOffers = usable.filter(o => o.level === 'ORDER').sort((a, b) => compareCandidates(
    { priority: a.priority, amountMinor: worthOf.get(a.id) ?? 0, createdAt: a.createdAt, id: a.id },
    { priority: b.priority, amountMinor: worthOf.get(b.id) ?? 0, createdAt: b.createdAt, id: b.id }
  ));
  for (let k = 0; k < orderOffers.length; k++) {
    const offer = orderOffers[k];
    /*
     * A whole-bill offer with exclusions is an offer on the rest of the bill.
     *
     * "500 off bills over 5,000, not on bridal wear": the lehenga neither counts towards the 5,000
     * nor takes a share of the 500. Anything else lets a customer reach the minimum with the very
     * item the shop said the offer was not for.
     */
    const inBill = lines.map(l => !excluded(offer, l));
    const eligibleAfterLines = priced.reduce((s, l, i) => s + (inBill[i] ? l.lineTotalMinor : 0), 0);
    const eligibleQuantity = lines.reduce((s, l, i) => s + (inBill[i] ? l.quantity : 0), 0);

    const condition = conditionsMet(offer, eligibleAfterLines, eligibleQuantity);
    if (condition) {
      nearMisses.push({ offerId: offer.id, title: offer.name, reason: condition });
      continue;
    }

    const remaining = priced.reduce((s, l, i) => s + (inBill[i] ? l.lineTotalMinor : 0), 0);
    // Never per piece on a bill: "200 off the bill" is 200.
    const amountMinor = Math.min(discountFor({ ...offer, perPiece: false }, remaining, eligibleQuantity), remaining);
    if (amountMinor <= 0) continue;

    // Divided between the lines by what each is still worth, so the parts add up exactly and a
    // line already marked down does not absorb a share of a price nobody is paying.
    const shares = allocate(amountMinor, priced.map((l, i) => (inBill[i] ? l.lineTotalMinor : 0)));
    priced.forEach((l, idx) => {
      if (shares[idx] <= 0) return;
      l.lineTotalMinor -= shares[idx];
      l.discountMinor += shares[idx];
      l.netUnitPriceMinor = netUnitPrice(l.lineTotalMinor, l.quantity);
      l.appliedOffers.push({
        offerId: offer.id, offerVersionId: offer.versionId,
        title: offer.name, amountMinor: shares[idx], level: 'ORDER', code: codeOf(offer)
      });
    });

    discounts.push({
      offerId: offer.id, offerVersionId: offer.versionId,
      title: offer.name, amountMinor, level: 'ORDER', code: codeOf(offer)
    });

    // Only one order-level offer applies unless it says it stacks. Two "500 off the order"
    // rules both firing is almost never what a merchant meant.
    if (!offer.stackable) {
      /*
       * The bill offers that lose to it are still worth explaining. A customer who typed a code
       * for 300 off, on a bill already getting 500 off that does not combine, was told "nothing in
       * this basket qualifies" -- which is false, and sends them back to the counter to argue.
       */
      for (const lost of orderOffers.slice(k + 1)) {
        nearMisses.push({
          offerId: lost.id, title: lost.name,
          reason: `"${offer.name}" already takes money off this bill, and the two do not combine.`
        });
      }
      break;
    }
  }

  // Line-level offers, gathered per offer so the basket can say what each rule did in total.
  const byOffer = new Map<string, AppliedOffer>();
  for (const line of priced) {
    for (const a of line.appliedOffers) {
      if (a.level !== 'LINE') continue;
      const at = byOffer.get(a.offerId);
      if (at) at.amountMinor += a.amountMinor;
      else byOffer.set(a.offerId, { ...a });
    }
  }

  const allDiscounts = [...byOffer.values(), ...discounts];
  const totalMinor = priced.reduce((s, l) => s + l.lineTotalMinor, 0);

  /*
   * A code that matched an offer and still took nothing off.
   *
   * It happens: the code is for sarees and the basket has none, or another offer already beat it
   * on every line. Either way the customer typed something and deserves to know why it did
   * nothing, rather than watching the total not change.
   */
  for (const offer of usable) {
    const code = codeOf(offer);
    if (offer.trigger !== 'CODE' || !code) continue;
    const did = allDiscounts.some(d => d.offerId === offer.id);
    if (did) continue;
    const near = nearMisses.find(n => n.offerId === offer.id);
    rejected.push({
      code,
      reason: near ? near.reason : 'Nothing in this basket qualifies for that offer.'
    });
  }

  return {
    lines: priced,
    discounts: allDiscounts,
    subtotalMinor,
    discountTotalMinor: subtotalMinor - totalMinor,
    totalMinor,
    rejected,
    // One entry per offer, keeping the first reason -- the same rule blocked on several lines is
    // still one thing to tell the customer.
    nearMisses: nearMisses.filter((n, i, all) => all.findIndex(x => x.offerId === n.offerId) === i)
  };
}
