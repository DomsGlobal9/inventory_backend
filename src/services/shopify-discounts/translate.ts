/**
 * An offer, said in Shopify's words -- or the plain reason it cannot be.
 *
 * Shopify owns its checkout and will not ask our pricing engine what a basket costs. So for a
 * Shopify store we push a COPY of the rule, and the copy is only acceptable if Shopify will charge
 * exactly what we would. A copy that is merely close is worse than no copy: the same saree costs
 * one price in the shop and another online, and nobody can say which is the mistake.
 *
 * So this file refuses honestly. Each rule below was checked against Shopify's Admin API reference
 * (2026-07) rather than assumed:
 *
 *   Percentage       Shopify takes 0.00-1.00, not 20. Supported.
 *   Percentage cap   Shopify has no cap. "20% up to 2,000" mirrored without it gives more away.
 *   Fixed amount     Shopify takes it off EACH item, or ONCE split across the order. We take it
 *                    off each LINE. Only the order-level form means the same thing in both.
 *   Fixed price      "Sarees at 9,999" has no Shopify basic-discount equivalent.
 *   Category         Shopify discounts products, variants or collections. It has no categories.
 *   Products         Only those matched to Shopify by SKU can be named there.
 *   Usage limit      An allowance shared with the till cannot be split between two checkouts --
 *                    "first 50" would become 50 here and 50 more on Shopify.
 *   Per customer     A code can be limited to once per customer. Nothing else can.
 *   Minimums         Subtotal OR quantity. Shopify refuses both at once.
 *   Channels         An offer for the till only is not a Shopify offer.
 *   Locations        Shopify cannot limit a discount to a location. An offer limited to locations
 *                    is mirrored only if Shopify sells from one of them.
 *
 * PURE. The caller loads the maps and the currencies; nothing here touches a database or a network,
 * so every one of those refusals is provable without a store.
 *
 * It also defines the CANONICAL form of a discount -- the handful of facts that decide what a
 * customer is charged -- built identically from what we push and from what Shopify reads back.
 * Drift detection compares hashes of that form, so the two builders must agree field for field.
 */

import crypto from 'crypto';
import { effectiveStatus } from '../offers/rules';

export interface MirrorableOffer {
  id: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'ARCHIVED';
  trigger: 'AUTOMATIC' | 'CODE';
  couponCode: string | null;
  level: 'LINE' | 'ORDER';
  valueType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FIXED_PRICE';
  value: number;
  maxDiscount: number | null;
  scope: 'ALL' | 'CATEGORY' | 'DRESS_TYPE' | 'PRODUCT' | 'VARIANT';
  targets: { scope: string; refId: string }[];
  minSubtotal: number | null;
  minQuantity: number | null;
  channels: string[];
  locationIds: string[];
  startsAt: Date;
  endsAt: Date | null;
  usageLimit: number | null;
  usageLimitPerCustomer: number | null;
  stackable: boolean;
  perPiece?: boolean;
  exclusions?: { scope: string; refId: string }[];
  customerTags?: string[];
  schedule?: unknown;
  uniqueCodes?: boolean;
}

export interface TranslationContext {
  now: Date;
  /** This shop's own currency, from ClientSettings. */
  shopCurrency: string;
  /** The Shopify store's currency. Null when it could not be read. */
  storeCurrency: string | null;
  /** Our variant id -> Shopify's numeric variant id, from ShopifyIdMap. */
  shopifyVariantOf: Map<string, string>;
  /** Our product id -> the Shopify product ids its matched variants belong to. */
  shopifyProductsOf: Map<string, string[]>;
  /** Our location ids that are paired with a Shopify location. */
  sellingLocationIds: string[];
  /** Labels for messages: our product/variant id -> a name a merchant recognises. */
  labelOf?: Map<string, string>;
}

/** The facts that decide what a customer is charged, in a form both sides can be reduced to. */
export interface CanonicalDiscount {
  kind: 'AUTOMATIC' | 'CODE';
  title: string;
  code: string | null;
  window: { startsAt: string; endsAt: string | null } | 'ENDED';
  value: { percentage: string } | { amount: string; eachItem: boolean };
  items: 'ALL' | { products: string[]; variants: string[] };
  minSubtotal: string | null;
  minQuantity: number | null;
  combines: { product: boolean; order: boolean; shipping: boolean };
  oncePerCustomer: boolean;
}

export type Translation =
  | { ok: true; kind: 'AUTOMATIC' | 'CODE'; input: Record<string, unknown>; canonical: CanonicalDiscount; hash: string }
  | { ok: false; reasons: string[] };

/** The tag every discount we create carries, so a retry can find what a timed-out push made. */
export const mirrorTag = (offerId: string) => `scaleezy-offer-${offerId}`;

const gid = (type: 'Product' | 'ProductVariant', id: string) => `gid://shopify/${type}/${id}`;

/** Seconds precision, UTC. Shopify returns its own spelling of a DateTime; both are reduced to this. */
export const isoSeconds = (d: Date | string) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

const money = (n: number | string) => Number(n).toFixed(2);

/** Money as a merchant reads it in a sentence -- "₹1,000", not "1000.00". Only for messages. */
const shown = (n: number | string, currency: string) => {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n));
  } catch {
    return `${currency} ${Number(n).toFixed(2)}`;
  }
};
const pct = (fraction: number | string) => Number(fraction).toFixed(4);

export function hashCanonical(c: CanonicalDiscount): string {
  // Keys in a fixed order, and lists sorted, so the same facts always hash the same.
  const ordered = {
    kind: c.kind,
    title: c.title,
    code: c.code ? c.code.toUpperCase() : null,
    window: c.window,
    value: c.value,
    items: c.items === 'ALL' ? 'ALL' : { products: [...c.items.products].sort(), variants: [...c.items.variants].sort() },
    minSubtotal: c.minSubtotal,
    minQuantity: c.minQuantity,
    combines: c.combines,
    oncePerCustomer: c.oncePerCustomer
  };
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/**
 * Whether the offer is running as far as Shopify should know.
 *
 * Paused, expired or never started: the Shopify copy is ENDED. Shopify has no "reactivate" for a
 * deactivated discount, so pausing is expressed as moving its end to now, and resuming as putting
 * the real dates back -- the same update either way, and harmless to repeat.
 */
function windowFor(offer: MirrorableOffer, now: Date): CanonicalDiscount['window'] {
  const status = effectiveStatus(offer as any, now);
  if (status === 'ACTIVE' || status === 'SCHEDULED') {
    return { startsAt: isoSeconds(offer.startsAt), endsAt: offer.endsAt ? isoSeconds(offer.endsAt) : null };
  }
  return 'ENDED';
}

export function translateOffer(offer: MirrorableOffer, ctx: TranslationContext): Translation {
  const reasons: string[] = [];
  const say = (why: string) => reasons.push(why);

  if (offer.status === 'ARCHIVED') say('This offer has been retired.');

  // ── where it applies ──────────────────────────────────────────────────────
  if (offer.channels.length > 0 && !offer.channels.includes('ONLINE')) {
    say('This offer is only for selling at the till, so it does not belong on Shopify.');
  }
  if (offer.locationIds.length > 0 && !offer.locationIds.some(id => ctx.sellingLocationIds.includes(id))) {
    say('This offer is limited to locations that are not paired with your Shopify store.');
  }

  // ── what it takes off ─────────────────────────────────────────────────────
  let value: CanonicalDiscount['value'] | null = null;

  if (offer.valueType === 'FIXED_PRICE') {
    say('Shopify cannot express "this, for a fixed price". Only a percentage or an amount off can be put on Shopify.');
  } else if (offer.valueType === 'PERCENTAGE') {
    if (offer.maxDiscount != null) {
      say(`Shopify cannot cap a percentage, so "up to ${shown(offer.maxDiscount, ctx.shopCurrency)}" would be lost and Shopify would give more away than you do. Remove the cap to put it on Shopify.`);
    } else {
      value = { percentage: pct(Number(offer.value) / 100) };
    }
  } else if (offer.valueType === 'FIXED_AMOUNT') {
    if (offer.level === 'LINE' && !offer.perPiece) {
      say('Shopify takes a fixed amount off each piece, or once from the whole order. This offer takes it once off each line, which Shopify has no way to say. Take it off each piece, or off the whole bill, to put it on Shopify.');
    } else if (ctx.storeCurrency && ctx.storeCurrency !== ctx.shopCurrency) {
      say(`Your Shopify store sells in ${ctx.storeCurrency} and this shop in ${ctx.shopCurrency}. An amount off is never converted; use a percentage instead.`);
    } else {
      // Per piece is exactly Shopify's "applies on each item".
      value = { amount: money(offer.value), eachItem: offer.level === 'LINE' };
    }
  }

  // ── what it applies to ────────────────────────────────────────────────────
  let items: CanonicalDiscount['items'] | null = null;

  if (offer.scope === 'ALL') {
    items = 'ALL';
  } else if (offer.scope === 'CATEGORY' || offer.scope === 'DRESS_TYPE') {
    say(`Shopify has no ${offer.scope === 'CATEGORY' ? 'departments' : 'garment types'} -- it discounts products, variants or collections. Choose the products instead to put this on Shopify.`);
  } else {
    const products = new Set<string>();
    const variants = new Set<string>();
    const unmatched: string[] = [];

    for (const t of offer.targets) {
      if (offer.scope === 'VARIANT') {
        const theirs = ctx.shopifyVariantOf.get(t.refId);
        if (theirs) variants.add(theirs);
        else unmatched.push(ctx.labelOf?.get(t.refId) ?? t.refId);
      } else {
        const theirs = ctx.shopifyProductsOf.get(t.refId) ?? [];
        if (theirs.length) theirs.forEach(p => products.add(p));
        else unmatched.push(ctx.labelOf?.get(t.refId) ?? t.refId);
      }
    }

    if (unmatched.length) {
      // Refused rather than mirrored for the matched ones only: a Shopify copy covering fewer items
      // than the offer would silently charge full price for the rest online.
      const shown = unmatched.slice(0, 3).join(', ') + (unmatched.length > 3 ? ` and ${unmatched.length - 3} more` : '');
      say(`Not everything this offer covers is matched to your Shopify store (${shown}). Match your products by SKU first.`);
    } else if (products.size === 0 && variants.size === 0) {
      say('This offer names nothing to discount.');
    } else {
      items = { products: [...products].sort(), variants: [...variants].sort() };
    }
  }

  // ── limits and conditions ─────────────────────────────────────────────────
  if (offer.usageLimit != null) {
    say(`This offer can be used ${offer.usageLimit} times in total. That allowance is shared with your till and website, and Shopify would count its own separately -- so it cannot be put on Shopify without being given away twice.`);
  }

  let oncePerCustomer = false;
  if (offer.usageLimitPerCustomer != null) {
    if (offer.trigger === 'CODE' && offer.usageLimitPerCustomer === 1) {
      oncePerCustomer = true;
    } else if (offer.trigger === 'CODE') {
      say('Shopify can limit a code to once per customer, but not to any other number.');
    } else {
      say('Shopify cannot limit an automatic discount per customer. Make it a code, limited to once per customer, to put it on Shopify.');
    }
  }

  if (offer.minSubtotal != null && offer.minQuantity != null) {
    say('Shopify allows a minimum spend OR a minimum number of items, not both.');
  }
  if (offer.minSubtotal != null && ctx.storeCurrency && ctx.storeCurrency !== ctx.shopCurrency) {
    say(`A minimum spend in ${ctx.shopCurrency} cannot be applied to a store that sells in ${ctx.storeCurrency}.`);
  }

  // ── rules Shopify has no words for ────────────────────────────────────────
  if ((offer.exclusions ?? []).length > 0) {
    say('Shopify cannot leave items out of a discount. Choose the products it applies to instead, to put it on Shopify.');
  }
  if ((offer.customerTags ?? []).length > 0) {
    say('This offer is only for some customer groups, and Shopify would give it to everyone.');
  }
  if (offer.schedule != null) {
    say('Shopify cannot run a discount only at certain hours, so it would run all day there.');
  }
  if (offer.uniqueCodes) {
    say('Single-use codes stay with your till and website. Use one shared code to put an offer on Shopify.');
  } else if (offer.trigger === 'CODE' && !offer.couponCode) {
    say('This code offer has no code.');
  }

  if (reasons.length > 0 || !value || !items) {
    return { ok: false, reasons: reasons.length ? reasons : ['This offer cannot be expressed in Shopify.'] };
  }

  // ── the Shopify input ─────────────────────────────────────────────────────
  const window = windowFor(offer, ctx.now);
  const kind = offer.trigger;

  const combines = {
    // Non-stackable offers compete and only the best one applies -- Shopify's own default for
    // product discounts, which is why "does not stack" maps to "combines with nothing".
    product: offer.stackable,
    order: offer.stackable,
    shipping: false
  };

  const canonical: CanonicalDiscount = {
    kind,
    title: offer.name,
    code: kind === 'CODE' ? offer.couponCode : null,
    window,
    value,
    items,
    minSubtotal: offer.minSubtotal != null ? money(offer.minSubtotal) : null,
    minQuantity: offer.minSubtotal == null && offer.minQuantity != null ? offer.minQuantity : null,
    combines,
    oncePerCustomer
  };

  const input: Record<string, unknown> = {
    title: offer.name,
    ...(window === 'ENDED'
      ? {
          // Ended now. A start in the future would make the end precede it, which Shopify refuses.
          startsAt: isoSeconds(offer.startsAt < ctx.now ? offer.startsAt : new Date(ctx.now.getTime() - 60_000)),
          endsAt: isoSeconds(ctx.now)
        }
      : { startsAt: window.startsAt, endsAt: window.endsAt }),
    customerGets: {
      value: 'percentage' in value
        ? { percentage: Number(value.percentage) }
        : { discountAmount: { amount: value.amount, appliesOnEachItem: value.eachItem } },
      items: items === 'ALL'
        ? { all: true }
        : {
            products: {
              productsToAdd: items.products.map(id => gid('Product', id)),
              productVariantsToAdd: items.variants.map(id => gid('ProductVariant', id))
            }
          }
    },
    combinesWith: { productDiscounts: combines.product, orderDiscounts: combines.order, shippingDiscounts: combines.shipping },
    ...(canonical.minSubtotal != null
      ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: canonical.minSubtotal } } }
      : canonical.minQuantity != null
        ? { minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: String(canonical.minQuantity) } } }
        : {}),
    tags: [mirrorTag(offer.id)],
    ...(kind === 'CODE' ? { code: offer.couponCode, appliesOncePerCustomer: oncePerCustomer } : {})
  };

  return { ok: true, kind, input, canonical, hash: hashCanonical(canonical) };
}

/**
 * A discount as Shopify reads it back, reduced to the same canonical form.
 *
 * `node` is the `discount` field of a `discountNode` query (see mirror.service for the document).
 * Returns null for a discount type this mirror never creates -- that is not ours to judge.
 */
export function canonicalFromShopify(node: any, now: Date): CanonicalDiscount | null {
  if (!node) return null;
  const type = node.__typename;
  if (type !== 'DiscountAutomaticBasic' && type !== 'DiscountCodeBasic') return null;

  const endsAt = node.endsAt ? new Date(node.endsAt) : null;
  const window: CanonicalDiscount['window'] = endsAt && endsAt <= now
    ? 'ENDED'
    : { startsAt: isoSeconds(node.startsAt), endsAt: endsAt ? isoSeconds(endsAt) : null };

  const v = node.customerGets?.value;
  let value: CanonicalDiscount['value'];
  if (v?.__typename === 'DiscountPercentage' || v?.percentage != null) {
    value = { percentage: pct(v.percentage) };
  } else if (v?.__typename === 'DiscountAmount' || v?.amount != null) {
    value = { amount: money(v.amount?.amount ?? v.amount), eachItem: Boolean(v.appliesOnEachItem) };
  } else {
    value = { percentage: 'UNKNOWN' };
  }

  const it = node.customerGets?.items;
  let items: CanonicalDiscount['items'];
  if (it?.__typename === 'AllDiscountItems' || it?.allItems === true) {
    items = 'ALL';
  } else {
    const ids = (conn: any) => (conn?.nodes ?? []).map((n: any) => String(n.id).match(/(\d+)$/)?.[1]).filter(Boolean);
    items = { products: ids(it?.products).sort(), variants: ids(it?.productVariants).sort() };
  }

  const req = node.minimumRequirement;
  const minSubtotal = req?.greaterThanOrEqualToSubtotal ? money(req.greaterThanOrEqualToSubtotal.amount) : null;
  const minQuantity = req?.greaterThanOrEqualToQuantity != null ? Number(req.greaterThanOrEqualToQuantity) : null;

  return {
    kind: type === 'DiscountCodeBasic' ? 'CODE' : 'AUTOMATIC',
    title: String(node.title ?? ''),
    code: type === 'DiscountCodeBasic' ? (node.codes?.nodes?.[0]?.code ?? null) : null,
    window,
    value,
    items,
    minSubtotal,
    minQuantity,
    combines: {
      product: Boolean(node.combinesWith?.productDiscounts),
      order: Boolean(node.combinesWith?.orderDiscounts),
      shipping: Boolean(node.combinesWith?.shippingDiscounts)
    },
    oncePerCustomer: type === 'DiscountCodeBasic' ? Boolean(node.appliesOncePerCustomer) : false
  };
}

/** What changed, in words, for the "Changed in Shopify" message. */
export function describeDifferences(ours: CanonicalDiscount, theirs: CanonicalDiscount): string[] {
  const out: string[] = [];
  if (ours.title !== theirs.title) out.push('the name');
  if ((ours.code ?? '').toUpperCase() !== (theirs.code ?? '').toUpperCase()) out.push('the code');
  if (JSON.stringify(ours.window) !== JSON.stringify(theirs.window)) out.push('the dates');
  if (JSON.stringify(ours.value) !== JSON.stringify(theirs.value)) out.push('how much comes off');
  if (JSON.stringify(ours.items) !== JSON.stringify(theirs.items)) out.push('what it applies to');
  if (ours.minSubtotal !== theirs.minSubtotal || ours.minQuantity !== theirs.minQuantity) out.push('the minimum to qualify');
  if (JSON.stringify(ours.combines) !== JSON.stringify(theirs.combines)) out.push('whether it combines with other discounts');
  if (ours.oncePerCustomer !== theirs.oncePerCustomer) out.push('the once-per-customer limit');
  if (ours.kind !== theirs.kind) out.push('whether it is automatic or a code');
  return out;
}
