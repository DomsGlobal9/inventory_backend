/**
 * What makes an offer a valid offer, and what it is worth.
 *
 * Pure: no database, no clock of its own. Every rule below can be checked against a shape without
 * a tenant existing, which is what keeps the refusals honest -- a rule that is only enforced at
 * the point of saving is a rule the pricing engine will meet in a state nobody tested.
 *
 * The engine that applies these is Phase 3. This file is the contract it will be handed.
 */

import { applyPercent, toMinor } from '../pricing';
import { validateSchedule } from './schedule';

export type OfferStatusName = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'ARCHIVED';

/** The shape a merchant fills in. Deliberately not the Prisma row: this is what is checked. */
export interface OfferDraft {
  name?: string | null;
  trigger?: 'AUTOMATIC' | 'CODE' | null;
  couponCode?: string | null;
  level?: 'LINE' | 'ORDER' | null;
  valueType?: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FIXED_PRICE' | null;
  value?: number | null;
  maxDiscount?: number | null;
  scope?: 'ALL' | 'CATEGORY' | 'DRESS_TYPE' | 'PRODUCT' | 'VARIANT' | null;
  targets?: { scope: string; refId: string }[] | null;
  minSubtotal?: number | null;
  minQuantity?: number | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  usageLimit?: number | null;
  usageLimitPerCustomer?: number | null;
  priority?: number | null;
  stackable?: boolean | null;
  channels?: string[] | null;
  locationIds?: string[] | null;
  perPiece?: boolean | null;
  exclusions?: { scope: string; refId: string }[] | null;
  customerTags?: string[] | null;
  schedule?: unknown;
  uniqueCodes?: boolean | null;
}

export const MAX_CUSTOMER_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

/** Tags as a shop means them: trimmed, and "vip" and "VIP" one tag, spelt the first way given. */
export function normaliseTags(tags: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = String(raw ?? '').trim().replace(/\s+/g, ' ');
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export const OFFER_CHANNELS = ['POS', 'ONLINE', 'MANUAL', 'MARKETPLACE'] as const;
export const OFFER_DEPARTMENTS = ['WOMEN', 'MEN', 'KIDS', 'UNISEX'] as const;

/** One target per thing. A type typed twice with different capitals is still one type. */
export function dedupeTargets(scope: string, targets: { scope: string; refId: string }[]) {
  const seen = new Set<string>();
  const out: { scope: string; refId: string }[] = [];
  for (const t of targets) {
    const refId = String(t.refId ?? '').trim();
    const key = scope === 'DRESS_TYPE' ? refId.toLowerCase() : refId;
    if (!refId || seen.has(key)) continue;
    seen.add(key);
    out.push({ scope: t.scope, refId });
  }
  return out;
}

/** Said the way a merchant would hear it, because these end up on their screen. */
export function validateOffer(draft: OfferDraft): string[] {
  const problems: string[] = [];

  if (!draft.name || !String(draft.name).trim()) {
    problems.push('Give the offer a name. It is what the customer sees on their receipt.');
  }

  const valueType = draft.valueType;
  if (!valueType) problems.push('Choose whether this takes off a percentage, an amount, or sets a price.');

  const value = Number(draft.value ?? NaN);
  if (!Number.isFinite(value)) {
    problems.push('Enter how much this offer is worth.');
  } else if (value <= 0) {
    problems.push('An offer has to be worth more than nothing.');
  } else if (valueType === 'PERCENTAGE' && value > 100) {
    problems.push('A percentage cannot be more than 100.');
  }

  if (draft.maxDiscount != null) {
    if (valueType !== 'PERCENTAGE') {
      problems.push('A cap only means something on a percentage offer.');
    } else if (Number(draft.maxDiscount) <= 0) {
      problems.push('A cap has to be more than nothing.');
    }
  }

  if (draft.trigger === 'CODE' && draft.uniqueCodes) {
    // Its codes are made after it is saved, on the offer page. Nothing to check here.
  } else if (draft.trigger === 'CODE') {
    if (!draft.couponCode || !String(draft.couponCode).trim()) {
      problems.push('A code offer needs a code for the customer to type.');
    } else if (!/^[A-Za-z0-9_-]{3,32}$/.test(String(draft.couponCode).trim())) {
      // Spaces and punctuation are where codes go wrong: a customer reads it off a poster and
      // cannot tell a space from nothing, and a code with a comma in it breaks every paste.
      problems.push('A code can use letters, numbers, hyphens and underscores, 3 to 32 characters.');
    }
  } else if (draft.couponCode) {
    problems.push('This offer applies automatically, so it cannot also have a code.');
  }

  const scope = draft.scope ?? 'ALL';
  const targets = draft.targets ?? [];
  if (!['ALL', 'CATEGORY', 'DRESS_TYPE', 'PRODUCT', 'VARIANT'].includes(scope)) {
    problems.push('Choose what the offer applies to.');
  }
  if (draft.level != null && !['LINE', 'ORDER'].includes(draft.level)) {
    problems.push('Choose whether it comes off each item or the whole bill.');
  }
  if (valueType && !['PERCENTAGE', 'FIXED_AMOUNT', 'FIXED_PRICE'].includes(valueType)) {
    problems.push('Choose whether this takes off a percentage, an amount, or sets a price.');
  }
  if (scope !== 'ALL' && targets.length === 0) {
    const what = { CATEGORY: 'departments', DRESS_TYPE: 'types of garment', PRODUCT: 'products', VARIANT: 'items' }[scope as string] ?? 'items';
    problems.push(`Choose which ${what} this applies to.`);
  }
  if (scope === 'ALL' && targets.length > 0) {
    problems.push('This offer applies to everything, so it cannot also list particular items.');
  }
  if (targets.some(t => t.scope !== scope)) {
    problems.push('Every item chosen has to match what the offer applies to.');
  }
  if (scope === 'CATEGORY' && targets.some(t => !(OFFER_DEPARTMENTS as readonly string[]).includes(t.refId))) {
    problems.push('A department has to be Women, Men, Kids or Unisex.');
  }
  if (scope === 'DRESS_TYPE' && targets.some(t => !String(t.refId ?? '').trim() || String(t.refId).trim().length > 60)) {
    problems.push('Each type of garment needs a name of up to 60 characters.');
  }
  if (targets.length > 500) {
    problems.push('An offer can name at most 500 items. For more, apply it to a type of garment or a department.');
  }

  /*
   * What it leaves out.
   *
   * Any kind of thing but "everything", whatever the offer applies to -- "20% off sarees except the
   * Banarasi" names a product inside a garment type. Leaving out the very thing it applies to is
   * refused: an offer on sarees that excludes sarees applies to nothing, and nobody means that.
   */
  const exclusions = draft.exclusions ?? [];
  if (exclusions.some(e => !['CATEGORY', 'DRESS_TYPE', 'PRODUCT', 'VARIANT'].includes(e.scope))) {
    problems.push('Leave out departments, types of garment, products or particular items.');
  }
  if (exclusions.some(e => e.scope === 'CATEGORY' && !(OFFER_DEPARTMENTS as readonly string[]).includes(e.refId))) {
    problems.push('A department left out has to be Women, Men, Kids or Unisex.');
  }
  if (exclusions.some(e => e.scope === 'DRESS_TYPE' && (!String(e.refId ?? '').trim() || String(e.refId).trim().length > 60))) {
    problems.push('Each type of garment left out needs a name of up to 60 characters.');
  }
  if (exclusions.length > 500) problems.push('An offer can leave out at most 500 items.');
  const sameKey = (x: { scope: string; refId: string }) =>
    `${x.scope}:${x.scope === 'DRESS_TYPE' ? String(x.refId).trim().toLowerCase() : x.refId}`;
  const included = new Set(targets.map(sameKey));
  if (exclusions.some(e => included.has(sameKey(e)))) {
    problems.push('Something is both included and left out. Remove it from one of the two.');
  }

  const tags = draft.customerTags ?? [];
  if (tags.length > MAX_CUSTOMER_TAGS) problems.push(`An offer can be for at most ${MAX_CUSTOMER_TAGS} customer groups.`);
  if (tags.some(t => !String(t ?? '').trim() || String(t).trim().length > MAX_TAG_LENGTH)) {
    problems.push(`Each customer group needs a name of up to ${MAX_TAG_LENGTH} characters.`);
  }

  problems.push(...validateSchedule(draft.schedule));

  if (draft.uniqueCodes) {
    if (draft.trigger !== 'CODE') {
      problems.push('Single-use codes are for an offer given with a code.');
    } else if (draft.couponCode) {
      problems.push('An offer with single-use codes has no shared code as well. Remove the shared code.');
    }
  }

  const channels = draft.channels ?? [];
  if (channels.some(c => !(OFFER_CHANNELS as readonly string[]).includes(c))) {
    problems.push('Choose where it sells from the till, the online store, or both.');
  }

  /*
   * "Set a price" on a whole bill.
   *
   * "Everything for 999" means each piece at 999 -- which is a per-item offer. A bill set to 999
   * whatever is in it is not an offer any shop runs, and the engine would have to invent which
   * lines absorb the difference.
   */
  if (draft.level === 'ORDER' && draft.valueType === 'FIXED_PRICE') {
    problems.push('A whole bill cannot be set to one price. Set the price on the items instead.');
  }

  if (draft.usageLimit != null && draft.usageLimitPerCustomer != null
      && Number(draft.usageLimitPerCustomer) > Number(draft.usageLimit)) {
    problems.push('One customer cannot use it more times than the offer can be used in total.');
  }

  const starts = asDate(draft.startsAt);
  const ends = asDate(draft.endsAt);
  if (!starts) problems.push('Say when the offer starts.');
  if (starts && ends && ends <= starts) {
    problems.push('The offer cannot end before it starts.');
  }

  for (const [label, n] of [
    ['How many times it can be used', draft.usageLimit],
    ['How many times one customer can use it', draft.usageLimitPerCustomer],
    ['The smallest number of items', draft.minQuantity]
  ] as const) {
    if (n != null && (!Number.isInteger(Number(n)) || Number(n) < 1)) {
      problems.push(`${label} has to be a whole number above zero.`);
    }
  }

  if (draft.minSubtotal != null && Number(draft.minSubtotal) < 0) {
    problems.push('The smallest basket cannot be a negative amount.');
  }

  /*
   * An order-level offer that only applies to certain products.
   *
   * "500 off the order, but only for sarees" has no agreed meaning -- is it 500 off if a saree is
   * present, or 500 off the saree part? Merchants mean different things by it, and a pricing
   * engine cannot ask. Refused here rather than guessed at later.
   */
  if (draft.level === 'ORDER' && scope !== 'ALL') {
    problems.push(
      'An offer that comes off the whole order has to apply to everything. ' +
      'To discount particular items, make it come off those lines instead.'
    );
  }

  return problems;
}

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * What an offer IS right now, as opposed to what its column says.
 *
 * The stored status is what a merchant chose; time changes it without asking. An ACTIVE offer
 * whose end has passed is EXPIRED whatever the row says, and an ACTIVE offer that has not started
 * is not yet live. Deriving it in one place means the list, the editor and the engine cannot
 * disagree about whether something is running.
 *
 * `startsAt` is INCLUSIVE and `endsAt` EXCLUSIVE -- the two rules the whole schedule rests on.
 */
export function effectiveStatus(
  offer: { status: OfferStatusName; startsAt: Date; endsAt: Date | null },
  now: Date = new Date()
): OfferStatusName | 'SCHEDULED' {
  if (offer.status === 'DRAFT' || offer.status === 'PAUSED' || offer.status === 'ARCHIVED') {
    return offer.status;
  }
  if (offer.endsAt && now >= offer.endsAt) return 'EXPIRED';
  if (now < offer.startsAt) return 'SCHEDULED';
  return 'ACTIVE';
}

/** Whether an offer can be applied to a basket at this moment. Nothing else counts as live. */
export function isLive(
  offer: { status: OfferStatusName; startsAt: Date; endsAt: Date | null; usageLimit: number | null; usageCount: number },
  now: Date = new Date()
): boolean {
  if (effectiveStatus(offer, now) !== 'ACTIVE') return false;
  if (offer.usageLimit != null && offer.usageCount >= offer.usageLimit) return false;
  return true;
}

/**
 * What this offer takes off one amount, in paise.
 *
 * The engine will call this for a line and for a basket; it is here rather than there so that the
 * arithmetic of an offer is defined in the same file as the rules that validate it.
 *
 *   PERCENTAGE    a share of the amount, half-up, capped by maxDiscount
 *   FIXED_AMOUNT  that much off, never more than there is
 *   FIXED_PRICE   "this, for 999" -- the difference, and nothing when it is already cheaper
 */
export function discountFor(
  offer: { valueType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FIXED_PRICE'; value: any; maxDiscount?: any; perPiece?: boolean | null },
  amountMinor: number,
  quantity = 1
): number {
  if (amountMinor <= 0) return 0;

  switch (offer.valueType) {
    case 'PERCENTAGE': {
      const raw = applyPercent(amountMinor, Number(offer.value));
      const cap = offer.maxDiscount == null ? null : toMinor(offer.maxDiscount);
      const capped = cap == null ? raw : Math.min(raw, cap);
      return Math.min(capped, amountMinor);
    }

    case 'FIXED_AMOUNT':
      // Per piece, "200 off each saree" on a line of three is 600. Otherwise once off the line.
      return Math.min(toMinor(offer.value) * (offer.perPiece ? Math.max(1, quantity) : 1), amountMinor);

    case 'FIXED_PRICE': {
      // A price per unit, not per line: "sarees at 9,999" means each one, and a basket of three
      // should not be charged 9,999 in total.
      const target = toMinor(offer.value) * Math.max(1, quantity);
      return Math.max(0, Math.min(amountMinor - target, amountMinor));
    }

    default:
      return 0;
  }
}

/**
 * The order two offers compete in, when only one of them can win a line.
 *
 * A TOTAL ordering, deliberately. Three keys would leave two offers created in the same
 * millisecond to fall back on whatever order the database returned, and the same basket would
 * then price differently on two runs -- which is the kind of bug nobody can reproduce and
 * everybody remembers.
 *
 * Better first: higher priority, then bigger discount, then older, then by id.
 */
export function compareCandidates(
  a: { priority: number; amountMinor: number; createdAt: Date; id: string },
  b: { priority: number; amountMinor: number; createdAt: Date; id: string }
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.amountMinor !== b.amountMinor) return b.amountMinor - a.amountMinor;
  const byAge = a.createdAt.getTime() - b.createdAt.getTime();
  if (byAge !== 0) return byAge;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
