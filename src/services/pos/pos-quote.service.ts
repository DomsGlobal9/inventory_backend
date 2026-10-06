/**
 * The till's price after offers (contract §9).
 *
 * ONE PRICING ENGINE, Inventory's. The POS never works out an offer: it asks here as lines are
 * scanned, shows what comes back, and uses the line totals VERBATIM on the bill. Everything here is
 * paise, the till's unit, and every line is named by the itemCode the till holds (variantCode or
 * sku) -- never our uuids.
 *
 * ADVISORY. A quote the till never gets, or gets late, costs the customer an offer and nothing
 * else: the till sells at its own price and says so. So nothing here may be slow on purpose, and
 * nothing here refuses a basket it can partly price -- an item Inventory does not know comes back
 * `unpriced` and the other lines keep their offers (§9.3).
 *
 * THE SAME BASKET IS THE SAME QUOTE while it is unused (§9.7): a cashier scanning five items asks
 * five times and gets one row, not five. Once a bill lands carrying the quote it is spent, and the
 * next customer buying the same thing gets a quote of their own -- otherwise their offer would be
 * "already used" and silently not counted.
 */
import { prisma } from '../../lib/prisma';
import { badRequest } from '../../utils/httpError';
import { pricingQuoteService, fingerprint } from '../pricing/quote.service';
import { toMinor } from '../pricing/money';
import { canonicalCode } from '../offers/codes';
import { resolveItems } from './pos-events.service';

const MAX_LINES = 100;

export interface TillQuoteLine { itemCode: string; qty: number }

/**
 * The customer as the SALE will name them, or nobody.
 *
 * A till bill finds or makes its customer by `POS:<phone exactly as sent>` (writeSaleInTransaction).
 * The quote uses the very same key, so quote and sale always agree on who the customer is: a
 * number the sale would not match to an existing customer prices as a guest here too (§9.4).
 */
async function tillCustomer(clientId: string, customerRef: unknown) {
  const ref = typeof customerRef === 'string' ? customerRef.trim() : '';
  if (!ref) return null;
  return prisma.customer.findFirst({ where: { clientId, externalCustomerId: `POS:${ref}` }, select: { id: true } });
}

export async function quoteForTill(clientId: string, locationId: string, body: any) {
  const lines: TillQuoteLine[] = Array.isArray(body?.lines) ? body.lines : [];
  if (!lines.length) throw badRequest('There is nothing in this basket.');
  if (lines.length > MAX_LINES) throw badRequest(`At most ${MAX_LINES} lines in one quote.`);
  for (const l of lines) {
    if (!l || typeof l.itemCode !== 'string' || !l.itemCode.trim()) throw badRequest('Every line needs an itemCode.');
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw badRequest(`Quantity for ${l.itemCode} must be a whole number above zero.`);
  }
  const codes = lines.map(l => l.itemCode.trim());
  if (new Set(codes).size !== codes.length) throw badRequest('Send each item once, with its full quantity.');
  const coupon = typeof body?.couponCode === 'string' && body.couponCode.trim() ? canonicalCode(body.couponCode) : null;

  const [{ byCode }, customer] = await Promise.all([resolveItems(clientId, codes), tillCustomer(clientId, body?.customerRef)]);

  const priceable = lines.filter(l => byCode.has(l.itemCode.trim()));
  const req = {
    locationId, channel: 'POS', customerId: customer?.id ?? null, couponCodes: coupon ? [coupon] : [],
    lines: priceable.map(l => ({ variantId: byCode.get(l.itemCode.trim())!, quantity: l.qty }))
  };

  let result: any;
  if (!priceable.length) {
    result = { quoteId: null, expiresAt: null, lines: [], discounts: [], rejected: [], nearMisses: [] };
  } else {
    const kept = await prisma.pricingQuote.findFirst({
      where: { clientId, locationId, channel: 'POS', customerId: req.customerId, inputHash: fingerprint(req), consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' }
    });
    result = kept
      ? { quoteId: kept.id, expiresAt: kept.expiresAt, ...(kept.result as any) }
      : await pricingQuoteService.quote(clientId, req, { tolerant: true });
  }

  const quoted = new Map<string, any>((result.lines ?? []).map((l: any) => [l.variantId, l]));
  const out = lines.map(l => {
    const variantId = byCode.get(l.itemCode.trim());
    const ql = variantId ? quoted.get(variantId) : null;
    if (!ql) return { itemCode: l.itemCode, qty: l.qty, unpriced: true as const };
    const listUnitPaise = toMinor(ql.listUnitPrice);
    const lineTotalPaise = toMinor(ql.lineTotal);
    return {
      itemCode: l.itemCode, qty: l.qty, listUnitPaise,
      // The discount is whatever makes list x qty meet the line total -- the same rule the sale uses.
      discountPaise: listUnitPaise * l.qty - lineTotalPaise,
      lineTotalPaise,
      offers: (ql.appliedOffers ?? []).map((a: any) => ({ offerId: a.offerId, name: a.title, discountPaise: toMinor(a.amount) }))
    };
  });

  let couponOut: { code: string; accepted: boolean; reason?: string } | undefined;
  if (coupon) {
    const refused = (result.rejected ?? []).find((r: any) => r.code === coupon);
    const took = (result.discounts ?? []).some((d: any) => d.code === coupon);
    couponOut = refused ? { code: coupon, accepted: false, reason: refused.reason }
      : took ? { code: coupon, accepted: true }
      : { code: coupon, accepted: false, reason: 'That code took nothing off this basket.' };
  }

  return {
    quoteId: result.quoteId ?? null,
    validUntil: result.expiresAt ? new Date(result.expiresAt).toISOString() : null,
    lines: out,
    totalPaise: out.reduce((s, l) => s + ((l as any).lineTotalPaise ?? 0), 0),
    ...(couponOut ? { coupon: couponOut } : {}),
    // Near misses, for the cashier to say out loud: "add ₹500 more and the bill gets 10% off".
    notes: (result.nearMisses ?? []).map((n: any) => n.reason).filter(Boolean)
  };
}
