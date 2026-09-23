import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { salesOrderService } from '../sales-order.service';
import { storefrontCatalogueService } from '../storefront-catalogue.service';
import { pricingQuoteService, fingerprint, toMinor, fromMinor } from '../pricing';
import { phoneForOutsideCustomer } from '../customer.service';
import { generateSequentialCode } from '../../utils/codeGenerator';
import { normalisePhone } from '../../lib/phone';
import { afterCommit } from '../../lib/afterCommit';
import { OnlineShopRuleError } from './rules';
import { sendOrderPlacedNotice } from './notices';

/**
 * A customer buying from a shop's own online shop.
 *
 * EVERYTHING HERE IS THE SHOP'S OWN. The prices are the shop's prices, resolved for the store the
 * order will be sent from. The discounts are the offers the shop authored, applied by the same
 * pricing engine the till uses -- so a "Festival 10%" the shop set up for ONLINE takes effect here
 * without anybody writing a line of shop-page code. The stock held is the shop's stock at a store
 * the shop chose to sell online from. And the order that comes out is an ordinary SalesOrder on the
 * ONLINE channel: the same row a counter sale or a Shopify order becomes, appearing in the same
 * Orders screen, dispatched by the same dispatch, returned by the same returns.
 *
 * Nothing about an online order is special except where it came from and how it was paid.
 */

/** Where an order from this shop says it came from, beside the key the browser made up. */
export const SHOP_SOURCE = 'SCALEEZY_SHOP';

/*
 * A basket a real person could be carrying. Twenty lines and ten of any one piece is far beyond
 * what a saree shop sells in one go, and well short of what makes the pricing engine work hard --
 * which matters because this is reachable by anybody on the internet with no account at all.
 */
const MAX_LINES = 20;
const MAX_PER_LINE = 10;

export type BasketLine = { variantCode: string; quantity: number };

/** What the shop settled on for taking orders, read as one thing. */
export async function orderingFor(clientId: string) {
  const shop = await prisma.onlineShop.findUnique({
    where: { clientId },
    select: {
      isLive: true, locationIds: true,
      acceptsOrders: true, payOnDelivery: true, payOnline: true,
      deliveryFee: true, freeDeliveryAbove: true, minOrderValue: true
    }
  });
  if (!shop) return null;
  const ways: ('ON_DELIVERY' | 'ONLINE')[] = [];
  if (shop.payOnDelivery) ways.push('ON_DELIVERY');
  if (shop.payOnline) ways.push('ONLINE');
  return {
    ...shop,
    payWays: ways,
    /* A shop that takes orders but offers no way to pay is not taking orders. */
    open: shop.isLive && shop.acceptsOrders && ways.length > 0
  };
}

/** The basket as the shopper sent it, tidied and refused early if it is nonsense. */
function tidy(raw: unknown): BasketLine[] {
  const rows = Array.isArray(raw) ? raw : [];
  if (rows.length === 0) throw new OnlineShopRuleError('There is nothing in your bag.');
  if (rows.length > MAX_LINES) throw new OnlineShopRuleError(`A bag can hold ${MAX_LINES} different pieces.`);

  // Merged rather than refused: a shopper who adds the same piece twice means two of it, and the
  // pricing engine needs each piece once with its full quantity.
  const byCode = new Map<string, number>();
  for (const row of rows) {
    const code = typeof row?.variantCode === 'string' ? row.variantCode.trim() : '';
    const qty = Number(row?.quantity);
    if (!code) throw new OnlineShopRuleError('Something in your bag could not be read. Empty it and try again.');
    if (!Number.isInteger(qty) || qty <= 0) throw new OnlineShopRuleError('How many of each piece has to be a whole number.');
    byCode.set(code, Math.min((byCode.get(code) ?? 0) + qty, MAX_PER_LINE));
  }
  return [...byCode].map(([variantCode, quantity]) => ({ variantCode, quantity }));
}

type Resolved = {
  variantId: string; variantCode: string; quantity: number;
  title: string; productCode: string; size: string | null; colour: string | null; colourHex: string | null;
  imageUrl: string | null;
  stocks: { locationId: string; quantity: number; reservedQty: number }[];
  profiles: { locationId: string; isAvailable: boolean }[];
};

/**
 * The pieces in the bag, as this shop's own rows.
 *
 * A shopper's bag lives in their browser and may be days old. A piece taken off sale, or moved to
 * the bin, is named in the refusal -- "Kanchipuram Silk Saree is no longer sold" -- because a bag
 * that simply refuses gives a customer nothing to act on.
 */
async function resolve(clientId: string, lines: BasketLine[]): Promise<Resolved[]> {
  const rows = await prisma.productVariant.findMany({
    where: { clientId, variantCode: { in: lines.map(l => l.variantCode) } },
    select: {
      id: true, variantCode: true, size: true, colorName: true, hexCode: true,
      product: {
        select: {
          title: true, productCode: true, status: true, trashedAt: true,
          images: {
            where: { imageType: { in: ['COVER', 'GALLERY'] } },
            select: { url: true, isPrimary: true, variantId: true },
            orderBy: { orderIndex: 'asc' }
          }
        }
      },
      stocks: { select: { locationId: true, quantity: true, reservedQty: true } },
      locationProfiles: { select: { locationId: true, isAvailable: true } }
    }
  });
  const byCode = new Map(rows.map(r => [r.variantCode, r]));

  return lines.map(line => {
    const v = byCode.get(line.variantCode);
    if (!v) throw new OnlineShopRuleError('Something in your bag is no longer in this shop. Take it out and try again.');
    if (v.product.trashedAt || v.product.status !== 'ACTIVE') {
      throw new OnlineShopRuleError(`${v.product.title} is no longer sold. Take it out of your bag.`);
    }
    const mine = v.product.images.filter(i => i.variantId === v.id);
    const photo = (mine.find(i => i.isPrimary) ?? mine[0]
      ?? v.product.images.find(i => i.isPrimary) ?? v.product.images[0])?.url ?? null;
    return {
      variantId: v.id, variantCode: v.variantCode, quantity: line.quantity,
      title: v.product.title, productCode: v.product.productCode,
      size: v.size ?? null, colour: v.colorName ?? null,
      colourHex: hex(v.hexCode), imageUrl: photo,
      stocks: v.stocks, profiles: v.locationProfiles
    };
  });
}

/** Only a real colour reaches a page; see the note in storefront-catalogue.service.ts. */
function hex(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : '';
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(v)) return null;
  return `#${(v.length === 3 ? v.split('').map(c => c + c).join('') : v).toLowerCase()}`;
}

/**
 * Which of the shop's stores this order is sent from.
 *
 * An order belongs to one store -- that is what holds the stock, what the pricing is resolved for,
 * and what packs the box. So: the first of the shop's chosen stores that can supply the WHOLE bag.
 * Taking the first store blindly would hold stock it does not have when the piece is in the godown;
 * splitting a bag across stores is a different thing entirely and this does not pretend to do it.
 *
 * When no single store can supply everything, the piece standing in the way is named, because
 * "sorry" on a checkout page loses the sale and tells the customer nothing.
 */
function chooseStore(locationIds: string[], items: Resolved[]): string {
  for (const locationId of locationIds) {
    const short = items.find(i => !canSupply(i, locationId));
    if (!short) return locationId;
  }
  // Nowhere can do all of it. Say which piece is the problem, using the store that comes closest.
  const short = items.find(i => !locationIds.some(id => canSupply(i, id)));
  if (short) {
    throw new OnlineShopRuleError(
      `${short.title}${short.size ? ` (${short.size})` : ''} is not available in the quantity you asked for. ` +
      'Change the number, or take it out of your bag.'
    );
  }
  throw new OnlineShopRuleError(
    'These pieces are in different stores, so they cannot be sent together. Order them separately, ' +
    'or ask the shop on WhatsApp.'
  );
}

function canSupply(item: Resolved, locationId: string): boolean {
  const profile = item.profiles.find(p => p.locationId === locationId);
  // No profile row means nothing has ever blocked it there -- the same reading the catalogue uses.
  if (profile && !profile.isAvailable) return false;
  const stock = item.stocks.find(s => s.locationId === locationId);
  return (stock ? stock.quantity - stock.reservedQty : 0) >= item.quantity;
}

/** What delivery costs on a bill of this size, in whole paise. */
function deliveryMinor(shop: { deliveryFee: any; freeDeliveryAbove: any }, goodsMinor: number): number {
  const fee = toMinor(shop.deliveryFee ?? 0);
  if (fee <= 0) return 0;
  const free = shop.freeDeliveryAbove === null || shop.freeDeliveryAbove === undefined
    ? null : toMinor(shop.freeDeliveryAbove);
  if (free !== null && goodsMinor >= free) return 0;
  return fee;
}

/**
 * The bag, priced.
 *
 * Priced but NOT kept, because this runs again on every "+" and every piece taken out, from the
 * open internet. The price that an order is written against is made once, at the moment of
 * ordering, by `place` below.
 */
export async function priceBag(clientId: string, rawLines: unknown) {
  const shop = await orderingFor(clientId);
  if (!shop) throw new OnlineShopRuleError('This shop is not taking orders.');
  /*
   * The same gate the order itself passes through.
   *
   * Without this a shop that has not switched ordering on would still price a bag perfectly well,
   * so its page would show a working bag, a working total and a Place order button -- and only the
   * last tap would refuse. A shop that does not take orders should not have a bag that works.
   */
  if (!shop.open) {
    throw new OnlineShopRuleError('This shop is not taking orders online just now. Ask them on WhatsApp.');
  }

  const lines = tidy(rawLines);
  const items = await resolve(clientId, lines);
  const locationId = chooseStore(shop.locationIds, items);

  const quote = await pricingQuoteService.quote(clientId, {
    locationId,
    channel: 'ONLINE',
    lines: items.map(i => ({ variantId: i.variantId, quantity: i.quantity }))
  }, { persist: false });

  return view(shop, items, quote, locationId);
}

/** One shape for the bag, whether it was priced for looking at or for ordering. */
function view(
  shop: NonNullable<Awaited<ReturnType<typeof orderingFor>>>,
  items: Resolved[],
  quote: any,
  locationId: string
) {
  const byVariant = new Map<string, any>((quote.lines ?? []).map((l: any) => [l.variantId, l]));
  // The quote answers in whole rupees and paise. Delivery is worked out in paise and brought back,
  // so "79 + 2,440.50" is added exactly rather than to within a rounding error.
  const goodsMinor = toMinor(quote.total ?? 0);
  const delivery = deliveryMinor(shop, goodsMinor);

  return {
    locationId,
    lines: items.map(i => {
      const priced = byVariant.get(i.variantId);
      return {
        variantCode: i.variantCode, productCode: i.productCode, title: i.title,
        size: i.size, colour: i.colour, colourHex: i.colourHex, imageUrl: i.imageUrl,
        quantity: i.quantity,
        /** What one costs before anything comes off, and what the line comes to after. */
        unitPrice: Number(priced?.listUnitPrice ?? 0),
        lineTotal: Number(priced?.lineTotal ?? 0),
        saved: Number(priced?.discount ?? 0)
      };
    }),
    /** Named the way a customer reads a bill, not the way a database stores one. */
    goods: Number(quote.subtotal ?? 0),
    saved: Number(quote.discountTotal ?? 0),
    delivery: Number(fromMinor(delivery)),
    total: Number(fromMinor(goodsMinor + delivery)),
    currency: quote.currency ?? 'INR',
    /** Why a discount came off, in the shop's own words, so the page can show it. */
    offers: (quote.discounts ?? []).map((d: any) => ({ name: d.title ?? 'Offer', saved: Number(d.amount ?? 0) })),
    minOrderValue: shop.minOrderValue === null ? null : Number(shop.minOrderValue),
    freeDeliveryAbove: shop.freeDeliveryAbove === null ? null : Number(shop.freeDeliveryAbove),
    payWays: shop.payWays
  };
}

export type PlaceInput = {
  placementKey?: unknown;
  lines?: unknown;
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  address?: unknown;
  payWay?: unknown;
  /** Set only when the number was proved to be theirs; see otp.ts. */
  phoneVerified?: boolean;
};

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Place the order.
 *
 * ONE TRANSACTION, the same shape the counter sale uses: the customer, the price, and the order
 * with its stock held are all of them or none. A dropped connection halfway through must not leave
 * a shop holding stock for an order nobody has, or a customer who was charged for nothing.
 *
 * The goods are HELD, not sent: status CONFIRMED reserves the stock and the shop dispatches it from
 * the Orders screen when the box actually goes. An online order that marked itself dispatched would
 * take the stock off the shelf before anyone had packed it.
 */
export async function place(clientId: string, input: PlaceInput) {
  const shop = await orderingFor(clientId);
  if (!shop) throw new OnlineShopRuleError('This shop is not taking orders.');
  if (!shop.isLive) throw new OnlineShopRuleError('This shop is closed just now.');
  if (!shop.open) throw new OnlineShopRuleError('This shop is not taking orders online just now. Ask them on WhatsApp.');

  const placementKey = text(input.placementKey, 64);
  if (placementKey.length < 16) throw new OnlineShopRuleError('That order could not be sent. Refresh the page and try again.');

  // Already placed: the answer to "place this order" when it is already placed is the order.
  const already = await prisma.onlineShopOrder.findUnique({
    where: { clientId_placementKey: { clientId, placementKey } }
  });
  if (already) return summary(clientId, already.token);

  const payWay = String(input.payWay ?? '').toUpperCase();
  if (!shop.payWays.includes(payWay as any)) {
    throw new OnlineShopRuleError('Choose how you would like to pay.');
  }

  const name = text(input.name, 80);
  if (name.length < 2) throw new OnlineShopRuleError('Tell the shop your name.');

  const phoneRaw = text(input.phone, 20);
  const phone = normalisePhone(phoneRaw);
  if (!phone.ok) throw new OnlineShopRuleError('That phone number does not look right. The shop needs it to reach you.');

  const address = text(input.address, 500);
  if (address.length < 10) {
    throw new OnlineShopRuleError('Write out the full address, with the area and the PIN code.');
  }
  const email = text(input.email, 120) || null;

  const lines = tidy(input.lines);
  const items = await resolve(clientId, lines);
  const locationId = chooseStore(shop.locationIds, items);

  /*
   * The price the order is written against, made now and kept.
   *
   * `consume` inside the order's transaction is what makes it good exactly once: the same price
   * cannot be replayed onto a second order, and a basket edited between pricing and ordering is
   * refused rather than charged at the old figure.
   */
  const quoteReq = {
    locationId, channel: 'ONLINE',
    lines: items.map(i => ({ variantId: i.variantId, quantity: i.quantity }))
  };
  const quote = await pricingQuoteService.quote(clientId, quoteReq);
  const bag = view(shop, items, quote, locationId);

  // Against the goods, not the goods plus delivery: a shop's minimum is about what is being
  // bought, and counting the delivery charge towards it would let a ₹450 bag through on carriage.
  if (shop.minOrderValue !== null && toMinor(bag.goods) - toMinor(bag.saved) < toMinor(shop.minOrderValue)) {
    throw new OnlineShopRuleError(
      `This shop sends orders of ${bag.currency === 'INR' ? '₹' : ''}${Number(shop.minOrderValue)} and above. Add a little more to your bag.`
    );
  }

  const token = crypto.randomBytes(24).toString('base64url');

  const salesOrderId = await prisma.$transaction(async (tx) => {
    /*
     * The customer, by the shop's own rule for somebody arriving from outside: the number is kept
     * on the customer only when it belongs to nobody else. A number typed at a checkout is not
     * proof of who they are, and matching on it would put a stranger's order on a regular's page.
     * Once the number has been proved (an OTP over WhatsApp), that changes -- see otp.ts.
     */
    const resolvedPhone = await phoneForOutsideCustomer(tx as any, clientId, phone.value);
    const existing = input.phoneVerified
      ? await tx.customer.findFirst({ where: { clientId, phone: phone.value, deletedAt: null }, select: { id: true } })
      : null;

    const customerId = existing?.id ?? (await tx.customer.create({
      data: {
        clientId,
        customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any),
        name,
        email,
        phone: resolvedPhone.onCustomer,
        shippingAddress: address,
        // The shop has their name, number and address: a person it can find again, not a walk-in.
        customerType: 'REGISTERED',
        status: 'ACTIVE'
      },
      select: { id: true }
    })).id;

    const order: any = await salesOrderService.writeFullOrderInTransaction(
      tx, clientId, locationId,
      {
        customer: { id: customerId, name, phone: resolvedPhone.onOrder ?? phone.value, shippingAddress: address },
        externalOrderId: placementKey,
        sourceSystem: SHOP_SOURCE,
        status: 'CONFIRMED',
        quoteId: quote.quoteId,
        quoteHash: fingerprint(quoteReq as any),
        shippingAmount: bag.delivery,
        items: items.map(i => ({ variantId: i.variantId, quantity: i.quantity }))
      },
      'ONLINE',
      null,
      // No person rang this up, so no till limit applies and no price may be overridden: everything
      // came from the shop's own prices and its own offers.
      { userId: null, manualLimitPercent: null, mayOverridePrices: false, lean: true }
    );

    await tx.onlineShopOrder.create({
      data: {
        clientId,
        salesOrderId: order.id,
        placementKey,
        token,
        customerPhone: phone.value,
        phoneVerified: input.phoneVerified === true,
        payWay: payWay as any,
        // Nothing is paid yet either way: on delivery the money comes later, and online it comes
        // when the gateway says so and not a moment before.
        paid: false
      }
    });

    return order.id as string;
  }, { timeout: 30000, maxWait: 15000 });

  void salesOrderId;

  // Only once the order is really there. Inside the transaction this could message a customer
  // about an order that then failed to save.
  afterCommit(() => { void sendOrderPlacedNotice(clientId, token); });

  return summary(clientId, token);
}

/**
 * One order, for the customer holding its link.
 *
 * Found by the token alone and then checked against the shop, so a token from one shop cannot read
 * an order in another. It carries what the customer needs to recognise their own order and nothing
 * about the shop's stock or its costs.
 */
export async function summary(clientId: string, token: unknown) {
  const key = typeof token === 'string' ? token.trim() : '';
  if (!key) throw new OnlineShopRuleError('That order could not be found.');

  const row: any = await prisma.onlineShopOrder.findUnique({
    where: { token: key },
    include: {
      salesOrder: {
        select: {
          orderNumber: true, status: true, createdAt: true,
          customerName: true, customerPhone: true, shippingAddress: true,
          subtotal: true, discountAmount: true, shippingAmount: true, total: true,
          items: {
            select: {
              // listUnitPrice is what one costs before anything came off; totalPrice is what the
              // line actually came to. Both, so a customer can see the saving on their own order.
              quantity: true, listUnitPrice: true, totalPrice: true,
              variant: {
                select: {
                  variantCode: true, size: true, colorName: true, hexCode: true,
                  product: {
                    select: {
                      title: true, productCode: true,
                      images: {
                        where: { imageType: { in: ['COVER', 'GALLERY'] } },
                        select: { url: true }, orderBy: { orderIndex: 'asc' }, take: 1
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
  if (!row || row.clientId !== clientId) throw new OnlineShopRuleError('That order could not be found.');

  const o = row.salesOrder;
  return {
    token: row.token,
    orderNumber: o.orderNumber,
    placedAt: o.createdAt.toISOString(),
    /** What the customer is waiting for, in their words rather than the warehouse's. */
    state: o.status === 'CANCELLED' ? 'CANCELLED'
      : o.status === 'DISPATCHED' ? 'SENT'
      : o.status === 'PARTIALLY_DISPATCHED' ? 'PART_SENT'
      : 'PLACED',
    payWay: row.payWay,
    paid: row.paid,
    name: o.customerName,
    phone: o.customerPhone,
    address: o.shippingAddress,
    goods: Number(o.subtotal),
    saved: Number(o.discountAmount),
    delivery: Number(o.shippingAmount),
    total: Number(o.total),
    items: o.items.map((i: any) => ({
      title: i.variant?.product.title ?? 'Item',
      productCode: i.variant?.product.productCode ?? null,
      variantCode: i.variant?.variantCode ?? null,
      size: i.variant?.size ?? null,
      colour: i.variant?.colorName ?? null,
      colourHex: hex(i.variant?.hexCode),
      imageUrl: i.variant?.product.images[0]?.url ?? null,
      quantity: i.quantity,
      unitPrice: Number(i.listUnitPrice),
      lineTotal: Number(i.totalPrice)
    }))
  };
}
