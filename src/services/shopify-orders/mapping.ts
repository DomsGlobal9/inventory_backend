/**
 * A Shopify order, turned into ours. Nothing else.
 *
 * Pure on purpose: no database, no network, no clock. Everything this needs is handed to it, and
 * everything it decides comes back as a value. That is what makes the whole of Phase 1 testable
 * today -- the mapping rules, the refusals and the money can all be checked against a real
 * Shopify payload without a webhook, a tenant, or Shopify's protected-customer-data approval,
 * which is a human review we cannot shorten.
 *
 * The rule throughout: **record what Shopify says happened.** Do not re-price it, do not
 * re-decide it, and do not quietly correct it. Shopify ran the checkout and took the money; we
 * are writing down the result.
 */

import { toMinor, netUnitPrice, allocate } from '../pricing';

/** Why an order could not be placed. Each one is a decision a person has to make. */
export type ParkReason =
  | 'UNMAPPED_LOCATION'
  | 'UNMAPPED_VARIANT'
  | 'CURRENCY_MISMATCH'
  | 'NOT_SYNCED'
  | 'UNCLAIMED_INSTALL'
  | 'RECONCILE_MISMATCH'
  /** A shipment or refund for an order that is itself still waiting to be placed. */
  | 'AWAITING_ORDER'
  | 'FAILED';

export interface MappingContext {
  /** Ours, already resolved from ShopifyLocationMap. */
  locationId: string;
  /** The shop's currency, from ClientSettings. */
  currency: string;
  /** Shopify variant id (as a string) -> our variant. */
  variants: Map<string, { variantId: string; averageCostMinor: number; sku: string }>;
}

export interface MappedLine {
  variantId: string;
  quantity: number;
  listUnitPriceMinor: number;
  lineDiscountMinor: number;
  allocatedDiscountMinor: number;
  totalPriceMinor: number;
  unitPriceMinor: number;
  unitCostMinor: number;
  /** Which Shopify discount_applications indexes touched this line, and for how much. */
  allocations: { applicationIndex: number; amountMinor: number }[];
}

export interface MappedDiscount {
  title: string;
  externalId: string | null;
  amountMinor: number;
}

export interface MappedOrder {
  externalOrderId: string;
  externalUpdatedAt: Date | null;
  status: 'DRAFT' | 'CONFIRMED' | 'PARTIALLY_DISPATCHED' | 'DISPATCHED' | 'CANCELLED';
  locationId: string;
  customer: {
    shopifyCustomerId: string | null;
    email: string | null;
    name: string | null;
    phone: string | null;
    shippingAddress: string | null;
    billingAddress: string | null;
    /** True when there is nothing to identify a person by, so the tenant's guest is used. */
    isGuest: boolean;
  };
  lines: MappedLine[];
  discounts: MappedDiscount[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  /** Shopify's own total, kept only to compare against ours. */
  shopifyTotalMinor: number;
  /** Set when our arithmetic and Shopify's disagree. The order is still ingested. */
  reconcileWarning: string | null;
}

export type MappingResult =
  | { ok: true; order: MappedOrder }
  | { ok: false; reason: ParkReason; detail: string };

/**
 * Shopify has two statuses and we have one.
 *
 * `restocked` is checked before anything else: Shopify uses it for an order whose goods have
 * been put back, which is a cancellation whatever the money says.
 */
export function statusFor(financial: string | null, fulfilment: string | null): MappedOrder['status'] {
  const f = (financial ?? '').toLowerCase();
  const l = (fulfilment ?? '').toLowerCase();

  if (l === 'restocked') return 'CANCELLED';
  if (f === 'refunded' || f === 'voided') return 'CANCELLED';

  if (f === 'paid' || f === 'partially_paid') {
    if (l === 'fulfilled') return 'DISPATCHED';
    if (l === 'partial') return 'PARTIALLY_DISPATCHED';
    return 'CONFIRMED';
  }

  // pending, authorized, partially_refunded on an unpaid order, or anything we do not know.
  // DRAFT reserves nothing, which is the safe side to be wrong on: an order that turns out to be
  // real can still be confirmed, while stock reserved for an order that never completes is stock
  // nobody can sell.
  return 'DRAFT';
}

/** Shopify addresses come as an object; an order needs one line of text. */
function flattenAddress(a: any): string | null {
  if (!a) return null;
  const parts = [
    [a.first_name, a.last_name].filter(Boolean).join(' '),
    a.company, a.address1, a.address2, a.city, a.province, a.zip, a.country
  ].map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * One Shopify order.
 *
 * Refuses rather than guesses, and says which decision is missing. Every refusal here is
 * recoverable: the order is parked with its payload and replayed once a person has mapped the
 * location or the product.
 */
export function mapShopifyOrder(payload: any, ctx: MappingContext): MappingResult {
  if (!payload || payload.id === undefined || payload.id === null) {
    return { ok: false, reason: 'FAILED', detail: 'The payload has no order id.' };
  }

  const externalOrderId = String(payload.id);

  // Never converted. A shop whose ScaleEzy is in rupees and whose Shopify charged dollars has a
  // configuration problem, and inventing an exchange rate would bury it in the books.
  const orderCurrency = String(payload.currency ?? '').toUpperCase();
  if (orderCurrency && orderCurrency !== ctx.currency.toUpperCase()) {
    return {
      ok: false,
      reason: 'CURRENCY_MISMATCH',
      detail: `The order is in ${orderCurrency} and this shop is set to ${ctx.currency}.`
    };
  }

  const rawLines: any[] = Array.isArray(payload.line_items) ? payload.line_items : [];
  if (rawLines.length === 0) {
    return { ok: false, reason: 'FAILED', detail: 'The order has no line items.' };
  }

  // Every discount on the order, in Shopify's own order, so an allocation's index points at one.
  const applications: any[] = Array.isArray(payload.discount_applications)
    ? payload.discount_applications
    : [];

  const discounts: MappedDiscount[] = applications.map((d, i) => ({
    title: String(d?.title ?? d?.code ?? `Discount ${i + 1}`),
    externalId: d?.code ? String(d.code) : null,
    amountMinor: 0 // filled from the allocations below, which are what was actually taken off
  }));

  const lines: MappedLine[] = [];

  for (const raw of rawLines) {
    const shopifyVariantId = raw?.variant_id === undefined || raw?.variant_id === null
      ? null
      : String(raw.variant_id);

    const known = shopifyVariantId ? ctx.variants.get(shopifyVariantId) : undefined;
    if (!known) {
      // Never create a product from an order. A SKU we have never seen is a catalogue that was
      // not synced, and inventing a product here would put a phantom item in the merchant's
      // list with no cost, no images and no category.
      return {
        ok: false,
        reason: 'UNMAPPED_VARIANT',
        detail: `No product here matches Shopify variant ${shopifyVariantId ?? '(none)'}` +
          `${raw?.sku ? ` (SKU ${raw.sku})` : ''}.`
      };
    }

    const quantity = Number(raw.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, reason: 'FAILED', detail: `Line for ${known.sku} has quantity ${raw.quantity}.` };
    }

    // Shopify's `price` is the unit price BEFORE discounts; the allocations carry what came off.
    const listUnitPriceMinor = toMinor(raw.price);

    const allocations: MappedLine['allocations'] = [];
    let lineDiscountMinor = 0;
    for (const alloc of (Array.isArray(raw.discount_allocations) ? raw.discount_allocations : [])) {
      const amountMinor = toMinor(alloc?.amount);
      if (amountMinor <= 0) continue;
      const idx = Number(alloc?.discount_application_index ?? -1);
      lineDiscountMinor += amountMinor;
      allocations.push({ applicationIndex: idx, amountMinor });
      if (idx >= 0 && idx < discounts.length) discounts[idx].amountMinor += amountMinor;
    }

    const grossMinor = listUnitPriceMinor * quantity;
    // Clamped rather than refused. Shopify has already charged the customer; an allocation that
    // exceeds the line is their arithmetic, not ours, and refusing the order would lose a real
    // sale over a rounding difference.
    if (lineDiscountMinor > grossMinor) lineDiscountMinor = grossMinor;

    const totalPriceMinor = grossMinor - lineDiscountMinor;

    lines.push({
      variantId: known.variantId,
      quantity,
      listUnitPriceMinor,
      lineDiscountMinor,
      allocatedDiscountMinor: 0,
      totalPriceMinor,
      unitPriceMinor: netUnitPrice(totalPriceMinor, quantity),
      unitCostMinor: known.averageCostMinor,
      allocations
    });
  }

  /*
   * Shopify says more came off than its own allocations account for.
   *
   * It does happen -- an order-level adjustment Shopify does not express per line. The remainder
   * is spread the same way ours are, so the order still balances, and it is reported rather than
   * absorbed silently: it means Shopify did something this mapping does not model yet.
   */
  const allocatedMinor = lines.reduce((s, l) => s + l.lineDiscountMinor, 0);
  const statedDiscountMinor = toMinor(payload.total_discounts);
  let reconcileWarning: string | null = null;

  if (statedDiscountMinor > allocatedMinor) {
    const remainder = statedDiscountMinor - allocatedMinor;
    const weights = lines.map(l => l.totalPriceMinor);
    const shares = allocate(Math.min(remainder, weights.reduce((a, b) => a + b, 0)), weights);
    lines.forEach((line, i) => {
      line.allocatedDiscountMinor = shares[i];
      line.totalPriceMinor -= shares[i];
      line.unitPriceMinor = netUnitPrice(line.totalPriceMinor, line.quantity);
    });
    reconcileWarning =
      `Shopify reported ${statedDiscountMinor / 100} off but allocated ${allocatedMinor / 100} ` +
      `to lines. The difference was spread across the order.`;
  }

  const subtotalMinor = lines.reduce((s, l) => s + l.listUnitPriceMinor * l.quantity, 0);
  const discountMinor = lines.reduce((s, l) => s + l.lineDiscountMinor + l.allocatedDiscountMinor, 0);
  const taxMinor = toMinor(payload.total_tax);
  const shippingMinor = shippingOf(payload);
  const totalMinor = subtotalMinor - discountMinor + taxMinor + shippingMinor;
  const shopifyTotalMinor = toMinor(payload.total_price);

  /*
   * Our arithmetic against theirs.
   *
   * A mismatch does NOT reject the order. It was paid; it belongs in the books. It is flagged so
   * somebody can look, because the alternative -- refusing real sales when our sums disagree --
   * loses money to protect a number.
   */
  if (shopifyTotalMinor > 0 && shopifyTotalMinor !== totalMinor) {
    const note =
      `Our total is ${totalMinor / 100} and Shopify's is ${shopifyTotalMinor / 100}.`;
    reconcileWarning = reconcileWarning ? `${reconcileWarning} ${note}` : note;
  }

  const customerBlock = payload.customer ?? null;
  const email: string | null = payload.email ?? customerBlock?.email ?? null;
  const shopifyCustomerId = customerBlock?.id !== undefined && customerBlock?.id !== null
    ? String(customerBlock.id)
    : null;

  const name = customerBlock
    ? [customerBlock.first_name, customerBlock.last_name].filter(Boolean).join(' ').trim() || null
    : null;

  return {
    ok: true,
    order: {
      externalOrderId,
      externalUpdatedAt: payload.updated_at ? new Date(payload.updated_at) : null,
      status: statusFor(payload.financial_status ?? null, payload.fulfillment_status ?? null),
      locationId: ctx.locationId,
      customer: {
        shopifyCustomerId,
        email: email || null,
        name,
        phone: customerBlock?.phone ?? payload.shipping_address?.phone ?? payload.phone ?? null,
        shippingAddress: flattenAddress(payload.shipping_address),
        billingAddress: flattenAddress(payload.billing_address),
        isGuest: !shopifyCustomerId && !email
      },
      lines,
      discounts: discounts.filter(d => d.amountMinor > 0),
      subtotalMinor,
      discountMinor,
      taxMinor,
      shippingMinor,
      totalMinor,
      shopifyTotalMinor,
      reconcileWarning
    }
  };
}

/**
 * Shipping, from whichever shape this payload uses.
 *
 * Shopify moved shipping into `total_shipping_price_set` and older payloads (and several of the
 * examples still in circulation) carry `shipping_lines[]`. Reading only one of them silently
 * loses the shipping on half the orders.
 */
function shippingOf(payload: any): number {
  const set = payload?.total_shipping_price_set?.shop_money?.amount;
  if (set !== undefined && set !== null) return toMinor(set);

  const lines: any[] = Array.isArray(payload?.shipping_lines) ? payload.shipping_lines : [];
  return lines.reduce((s, l) => s + toMinor(l?.price), 0);
}
