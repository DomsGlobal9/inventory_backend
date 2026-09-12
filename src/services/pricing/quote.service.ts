/**
 * "What does this basket cost?", asked by a till or a website, answered once and held to.
 *
 * The engine does the arithmetic and knows nothing about the world. This loads the world -- the
 * shop's live offers, the variants, the prices at this location -- hands it over, and then
 * FREEZES the answer.
 *
 * Freezing is the point. Without it an offer that ends at midnight prices a basket at 23:59:58
 * and charges a different amount when the customer presses pay at 00:00:03. The customer saw a
 * number. Charging more than the number they saw is not acceptable, and re-pricing at order time
 * is exactly how that happens.
 */

import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { badRequest, notFound } from '../../utils/httpError';
import { resolveVariantForLocation } from '../../utils/variant-location';
import { toMinor, fromMinor, minorToNumber } from './money';
import { priceBasket, BasketLine, CandidateOffer, PricedBasket } from './engine';

/** How long a quoted price is honoured. Decision D7. */
export const QUOTE_TTL_MS = 15 * 60 * 1000;

export interface QuoteRequest {
  locationId: string;
  channel?: string;
  customerId?: string | null;
  couponCodes?: string[];
  lines: { variantId: string; quantity: number }[];
}

/**
 * A fingerprint of what was asked.
 *
 * Sorted, so the same basket in a different order is the same fingerprint -- a till that lets a
 * cashier reorder lines must not lose its quote. An order arriving with a DIFFERENT basket than
 * the one quoted is what this exists to catch.
 */
export function fingerprint(req: QuoteRequest): string {
  const canonical = JSON.stringify({
    locationId: req.locationId,
    channel: req.channel ?? 'POS',
    lines: [...req.lines]
      .map(l => ({ v: l.variantId, q: Number(l.quantity) }))
      .sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : a.q - b.q)),
    coupons: [...(req.couponCodes ?? [])].map(c => c.trim().toUpperCase()).filter(Boolean).sort()
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export class PricingQuoteService {
  /**
   * Price a basket and keep the answer.
   *
   * Every refusal here is about the basket rather than the offers: a variant that is not this
   * shop's, or one that is not for sale at this location. Those are errors in the request and are
   * said plainly, because the caller is a till or a website and needs to know which line is wrong.
   */
  async quote(clientId: string, req: QuoteRequest): Promise<any> {
    if (!req.locationId) throw badRequest('Say which location this is selling from.');
    if (!Array.isArray(req.lines) || req.lines.length === 0) {
      throw badRequest('There is nothing in this basket.');
    }

    const channel = (req.channel ?? 'POS').toUpperCase();
    const variantIds = [...new Set(req.lines.map(l => l.variantId))];

    /*
     * The same item twice.
     *
     * Refused rather than merged, because a quote is matched back to an order line by line, and
     * two lines carrying the same variant have no way of saying which quoted price belongs to
     * which. Merging them silently would also change the basket a till thinks it sent. Asking
     * for one line with a quantity of two is unambiguous in both directions.
     */
    if (variantIds.length !== req.lines.length) {
      throw badRequest('Send each item once, with its full quantity.');
    }

    const variants = await prisma.productVariant.findMany({
      where: { id: { in: variantIds }, clientId },
      include: {
        locationProfiles: true,
        product: { select: { id: true, title: true, category: true, basePrice: true } }
      }
    });

    const byId = new Map(variants.map(v => [v.id, v]));

    const basket: BasketLine[] = [];
    for (const line of req.lines) {
      const variant = byId.get(line.variantId);
      if (!variant) throw notFound(`No item here matches ${line.variantId}.`);

      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw badRequest(`Quantity for ${variant.sku} must be a whole number above zero.`);
      }

      // The same resolution an order uses, called rather than repeated. A quote that prices from
      // a different chain than the order that follows it is worse than no quote at all.
      const resolved = resolveVariantForLocation(
        variant, req.locationId, Number(variant.product.basePrice)
      );
      if (!resolved.isAvailable) {
        throw badRequest(`${variant.sku} is not for sale at this location.`);
      }

      basket.push({
        variantId: variant.id,
        productId: variant.product.id,
        category: variant.product.category ?? null,
        quantity,
        listUnitPriceMinor: toMinor(resolved.price ?? 0),
        sku: variant.sku,
        title: variant.product.title
      });
    }

    const offers = await this.liveOffers(clientId, channel, req.locationId, req.customerId ?? null);
    const priced = priceBasket(basket, offers, req.couponCodes ?? []);

    const { currency } = await getShopSettings(clientId);
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MS);

    const saved = await prisma.pricingQuote.create({
      data: {
        clientId,
        locationId: req.locationId,
        channel: channel as any,
        customerId: req.customerId ?? null,
        inputHash: fingerprint({ ...req, channel }),
        result: this.asJson(priced, currency) as any,
        subtotal: fromMinor(priced.subtotalMinor),
        discount: fromMinor(priced.discountTotalMinor),
        total: fromMinor(priced.totalMinor),
        expiresAt
      }
    });

    return { quoteId: saved.id, expiresAt, ...this.asJson(priced, currency) };
  }

  /**
   * A quote, if it is still good.
   *
   * Three ways it is not: it never existed, its fifteen minutes are up, or an order was already
   * written against it. The third matters most -- a quote is good ONCE, or one checkout's price
   * could be replayed onto ten orders.
   */
  async consume(
    clientId: string, quoteId: string, salesOrderId: string, expectedHash?: string,
    /*
     * The transaction that is writing the order, when there is one.
     *
     * A quote has to be claimed in the SAME transaction that writes the order it prices.
     * Claimed outside it, an order that then fails to reserve stock leaves a quote spent on an
     * order that does not exist, and the customer cannot re-checkout at the price they were
     * shown. Defaults to the global client so the standalone path still works.
     */
    client: any = prisma
  ) {
    const quote = await client.pricingQuote.findFirst({ where: { id: quoteId, clientId } });
    if (!quote) throw notFound('That price is no longer available. Ask for it again.');

    if (quote.consumedAt) {
      throw badRequest('That price has already been used on another order.');
    }
    if (quote.expiresAt <= new Date()) {
      throw badRequest('That price has expired. Ask for it again.');
    }
    if (expectedHash && expectedHash !== quote.inputHash) {
      throw badRequest('The basket has changed since that price was quoted. Ask for it again.');
    }

    // Claimed, not written: two orders racing for the same quote must not both get it. The same
    // compare-and-set that stops a double-clicked Confirm reserving stock twice.
    const claimed = await client.pricingQuote.updateMany({
      where: { id: quoteId, clientId, consumedAt: null },
      data: { consumedAt: new Date(), salesOrderId }
    });
    if (claimed.count === 0) {
      throw badRequest('That price has already been used on another order.');
    }

    return quote;
  }

  /**
   * Every offer that could apply to this basket, right now.
   *
   * Filtered here rather than in the engine because deciding it needs a clock, a database and a
   * customer -- and the engine is pure on purpose. `usageCount` is compared in the query so an
   * offer at its limit never even reaches the arithmetic.
   */
  async liveOffers(
    clientId: string, channel: string, locationId: string, customerId: string | null
  ): Promise<CandidateOffer[]> {
    const now = new Date();

    const rows = await prisma.offer.findMany({
      where: {
        clientId,
        status: 'ACTIVE',
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }]
      },
      include: { targets: true }
    });

    const eligible = rows.filter(o => {
      // Empty means everywhere -- the same convention StorefrontConnection uses for locationIds,
      // so a merchant meets one idea rather than two.
      if (o.channels.length > 0 && !o.channels.includes(channel as any)) return false;
      if (o.locationIds.length > 0 && !o.locationIds.includes(locationId)) return false;
      if (o.usageLimit != null && o.usageCount >= o.usageLimit) return false;
      return true;
    });

    /*
     * Per-customer limits.
     *
     * Counted from OfferRedemption rather than a column, because it is a count per person and
     * there is nowhere on the offer to keep one. Only asked when some offer actually carries such
     * a limit, and only for the offers that do -- a guest basket does not pay for this at all.
     */
    const limited = eligible.filter(o => o.usageLimitPerCustomer != null);
    let spentByThisCustomer = new Map<string, number>();

    if (customerId && limited.length > 0) {
      const counts = await prisma.offerRedemption.groupBy({
        by: ['offerId'],
        where: { clientId, customerId, status: 'COUNTED', offerId: { in: limited.map(o => o.id) } },
        _count: { _all: true }
      });
      spentByThisCustomer = new Map(counts.map(c => [c.offerId, c._count._all]));
    }

    return eligible
      .filter(o => {
        if (o.usageLimitPerCustomer == null) return true;
        // No customer means we cannot tell who this is, so a per-person limit cannot be honoured.
        // Refusing it is the safe side: the alternative is an unlimited discount for anyone who
        // checks out as a guest.
        if (!customerId) return false;
        return (spentByThisCustomer.get(o.id) ?? 0) < o.usageLimitPerCustomer;
      })
      .map(o => ({
        id: o.id,
        versionId: o.currentVersionId,
        name: o.name,
        trigger: o.trigger as any,
        couponCode: o.couponCode,
        level: o.level as any,
        valueType: o.valueType as any,
        value: o.value,
        maxDiscount: o.maxDiscount,
        scope: o.scope as any,
        targets: o.targets.map(t => ({ scope: t.scope as string, refId: t.refId })),
        minSubtotalMinor: o.minSubtotal == null ? null : toMinor(o.minSubtotal),
        minQuantity: o.minQuantity,
        priority: o.priority,
        stackable: o.stackable,
        createdAt: o.createdAt
      }));
  }

  /** Paise out, rupees in -- the API speaks the currency the merchant does. */
  private asJson(priced: PricedBasket, currency: string) {
    return {
      currency,
      lines: priced.lines.map(l => ({
        variantId: l.variantId,
        sku: l.sku,
        title: l.title,
        quantity: l.quantity,
        listUnitPrice: minorToNumber(l.listUnitPriceMinor),
        discount: minorToNumber(l.discountMinor),
        netUnitPrice: minorToNumber(l.netUnitPriceMinor),
        lineTotal: minorToNumber(l.lineTotalMinor),
        appliedOffers: l.appliedOffers.map(a => ({
          offerId: a.offerId, offerVersionId: a.offerVersionId,
          title: a.title, amount: minorToNumber(a.amountMinor), level: a.level
        }))
      })),
      discounts: priced.discounts.map(d => ({
        offerId: d.offerId, offerVersionId: d.offerVersionId,
        title: d.title, amount: minorToNumber(d.amountMinor), level: d.level
      })),
      subtotal: minorToNumber(priced.subtotalMinor),
      discountTotal: minorToNumber(priced.discountTotalMinor),
      total: minorToNumber(priced.totalMinor),
      // Said out loud, both of them. "Invalid code" at a till with a customer waiting is useless;
      // "spend ₹80 more" is something either of them can act on.
      rejected: priced.rejected,
      nearMisses: priced.nearMisses
    };
  }

  /**
   * The offers a shopper could see advertised, without pricing anything.
   *
   * A merchant's website needs this for the badge on a listing page -- "20% off" under a saree,
   * before anybody has a basket. Calling the quote endpoint once per tile to find that out would
   * be absurd, and would write a quote row per tile.
   *
   * COUPON OFFERS ARE NOT LISTED. A code is worth something because not everybody has it; an
   * endpoint that hands out every live code turns a targeted campaign into a public sale. A
   * storefront that legitimately knows a code sends it to the quote endpoint and gets the price.
   *
   * Targets come back as the codes a storefront already knows -- productCode, variantCode -- not
   * our internal ids, which it has never seen and could not match to anything it holds.
   */
  async publicOffers(clientId: string, channel: string, locationId: string) {
    const live = (await this.liveOffers(clientId, channel, locationId, null))
      .filter(o => o.trigger === 'AUTOMATIC');

    const productIds = live.flatMap(o => o.scope === 'PRODUCT' ? o.targets.map(t => t.refId) : []);
    const variantIds = live.flatMap(o => o.scope === 'VARIANT' ? o.targets.map(t => t.refId) : []);

    const [products, variants] = await Promise.all([
      productIds.length
        ? prisma.product.findMany({
            where: { id: { in: [...new Set(productIds)] }, clientId },
            select: { id: true, productCode: true }
          })
        : Promise.resolve([] as any[]),
      variantIds.length
        ? prisma.productVariant.findMany({
            where: { id: { in: [...new Set(variantIds)] }, clientId },
            select: { id: true, variantCode: true }
          })
        : Promise.resolve([] as any[])
    ]);

    const productCode = new Map(products.map((p: any) => [p.id, p.productCode]));
    const variantCode = new Map(variants.map((v: any) => [v.id, v.variantCode]));

    // Only the offer's own rule is exposed -- not its priority, not whether it stacks, not how
    // many times it has been used. Those are the shop's business, and a website cannot act on
    // any of them.
    return live.map(o => ({
      name: o.name,
      valueType: o.valueType,
      value: Number(o.value),
      maxDiscount: o.maxDiscount == null ? null : Number(o.maxDiscount),
      scope: o.scope,
      appliesTo:
        o.scope === 'ALL' ? null
        : o.scope === 'CATEGORY' ? { categories: o.targets.map(t => t.refId) }
        : o.scope === 'PRODUCT' ? { productCodes: o.targets.map(t => productCode.get(t.refId)).filter(Boolean) }
        : { variantCodes: o.targets.map(t => variantCode.get(t.refId)).filter(Boolean) },
      minSubtotal: o.minSubtotalMinor == null ? null : minorToNumber(o.minSubtotalMinor),
      minQuantity: o.minQuantity
    }));
  }
}

/**
 * A saved quote, turned back into something an order can be written from.
 *
 * The stored result is in rupees, because that is what was SHOWN to somebody -- it is a record
 * of a conversation, not an internal calculation. Coming back the other way it has to become
 * paise again before any arithmetic touches it, or the order's totals and the quote's totals
 * drift by a rounding at the third decimal place.
 *
 * Keyed by variant, which is safe because `quote()` refuses a basket containing the same variant
 * twice.
 */
export function pricedLinesFromQuote(result: any) {
  const lines = Array.isArray(result?.lines) ? result.lines : [];

  const byVariant = new Map<string, {
    quantity: number;
    listUnitPriceMinor: number;
    discountMinor: number;
    lineTotalMinor: number;
    appliedOffers: { offerId: string; offerVersionId: string | null; title: string; amountMinor: number; level: string }[];
  }>();

  for (const l of lines) {
    byVariant.set(l.variantId, {
      quantity: Number(l.quantity),
      listUnitPriceMinor: toMinor(l.listUnitPrice),
      discountMinor: toMinor(l.discount),
      lineTotalMinor: toMinor(l.lineTotal),
      appliedOffers: (l.appliedOffers ?? []).map((a: any) => ({
        offerId: a.offerId,
        offerVersionId: a.offerVersionId ?? null,
        title: a.title,
        amountMinor: toMinor(a.amount),
        level: a.level
      }))
    });
  }

  return {
    byVariant,
    /** One entry per offer, whatever it touched -- this is what becomes SalesOrderDiscount. */
    discounts: ((result?.discounts ?? []) as any[]).map((d: any) => ({
      offerId: String(d.offerId),
      offerVersionId: (d.offerVersionId ?? null) as string | null,
      title: String(d.title),
      amountMinor: toMinor(d.amount),
      level: String(d.level)
    })),
    totalMinor: toMinor(result?.total ?? 0),
    discountTotalMinor: toMinor(result?.discountTotal ?? 0)
  };
}

export const pricingQuoteService = new PricingQuoteService();
