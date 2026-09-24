import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { salesOrderService } from '../sales-order.service';
import { pricingQuoteService, fingerprint, toMinor, fromMinor } from '../pricing';
import { phoneForOutsideCustomer } from '../customer.service';
import { generateSequentialCode } from '../../utils/codeGenerator';
import { normalisePhone } from '../../lib/phone';
import { afterCommit } from '../../lib/afterCommit';
import { OnlineShopRuleError } from './rules';
import { sendOrderPlacedNotice, emailOrderPlaced, tellTheShop, orderCancelled } from './notices';
import { rememberFromOrder as rememberAddress } from './addresses';
import { isVerified } from './otp';

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
      deliveryFee: true, freeDeliveryAbove: true, minOrderValue: true,
      deliverPincodes: true
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

  /*
   * Counted AFTER merging, because the limit is on different pieces and that is what merging
   * produces. Counted before, twenty-one rows of the same saree -- which is one piece -- was
   * refused as "a bag can hold 20 different pieces": untrue, and nothing the shopper could act on.
   * The body itself is capped at 32kb by the router, so this is not what keeps the payload small.
   */
  if (byCode.size > MAX_LINES) throw new OnlineShopRuleError(`A bag can hold ${MAX_LINES} different pieces.`);
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
/**
 * Codes the shopper typed, tidied.
 *
 * The pricing engine has always taken these -- a shop that prints "DIWALI20" on a card was
 * authoring a code its own online shop had no way to accept. At most a handful: a checkout is not
 * a place to try three hundred codes.
 */
function codes(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return [...new Set(list
    .filter((c): c is string => typeof c === 'string')
    .map(c => c.trim().toUpperCase())
    .filter(c => c && c.length <= 64))].slice(0, 5);
}

export async function priceBag(clientId: string, rawLines: unknown, rawCodes?: unknown) {
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

  const couponCodes = codes(rawCodes);
  const quote = await pricingQuoteService.quote(clientId, {
    locationId,
    channel: 'ONLINE',
    lines: items.map(i => ({ variantId: i.variantId, quantity: i.quantity })),
    couponCodes
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
    /*
     * A code that did not work, said as what it is. "There is no offer with that code" to somebody
     * holding a card the shop printed starts an argument at the counter; the engine already tells
     * the difference between a code that is unknown, one already spent and one that is real but
     * does not apply here, and all three are worth passing on.
     */
    codesRefused: (quote.rejected ?? []).map((r: any) => ({ code: r.code, why: r.reason })),
    codesAccepted: (quote.discounts ?? []).filter((d: any) => d.code).map((d: any) => String(d.code)),
    minOrderValue: shop.minOrderValue === null ? null : Number(shop.minOrderValue),
    freeDeliveryAbove: shop.freeDeliveryAbove === null ? null : Number(shop.freeDeliveryAbove),
    /** Empty means everywhere. A shop that lists some is refusing the rest, and says so early. */
    deliversEverywhere: shop.deliverPincodes.length === 0,
    payWays: shop.payWays
  };
}

export type PlaceInput = {
  placementKey?: unknown;
  lines?: unknown;
  couponCodes?: unknown;
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  address?: unknown;
  pincode?: unknown;
  payWay?: unknown;
};

/** A PIN code as India writes them: six digits, and never starting at zero. */
const PINCODE = /^[1-9][0-9]{5}$/;

/**
 * How long an unproved order may hold the shop's stock.
 *
 * A day: long enough that a real customer whose WhatsApp was off still gets their order, short
 * enough that a prankster cannot keep a shop's window empty over a weekend. A PROVED order has no
 * expiry at all -- that is a real person, and only the shop decides when to let it go.
 */
const UNPROVED_HOLD_MS = 24 * 60 * 60 * 1000;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const digitsOnly = (v: unknown) => String(v ?? '').replace(/\D/g, '');

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
    throw new OnlineShopRuleError('Write out the full address, with the house, the street and the area.');
  }

  /*
   * The PIN code, asked for on its own rather than hoped for inside the address.
   *
   * It is the one part of an address a shop can actually check, and the only way to say "we do not
   * deliver there" before a customer has finished typing. Buried in a paragraph it can be checked
   * by nobody.
   */
  const pincode = digitsOnly(input.pincode);
  if (!PINCODE.test(pincode)) throw new OnlineShopRuleError('That PIN code does not look right. It is six digits.');
  if (shop.deliverPincodes.length && !shop.deliverPincodes.includes(pincode)) {
    throw new OnlineShopRuleError(
      `This shop does not deliver to ${pincode} just now. Ask them on WhatsApp -- they may still be able to help.`
    );
  }

  const email = text(input.email, 120) || null;

  const lines = tidy(input.lines);
  const items = await resolve(clientId, lines);
  const locationId = chooseStore(shop.locationIds, items);
  const couponCodes = codes(input.couponCodes);

  /*
   * The price the order is written against, made now and kept.
   *
   * `consume` inside the order's transaction is what makes it good exactly once: the same price
   * cannot be replayed onto a second order, and a basket edited between pricing and ordering is
   * refused rather than charged at the old figure.
   */
  const quoteReq = {
    locationId, channel: 'ONLINE',
    lines: items.map(i => ({ variantId: i.variantId, quantity: i.quantity })),
    couponCodes
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

  /*
   * Whether this number was PROVED, read from what this shop actually sent and what was actually
   * typed back -- never from a flag the browser sends. A page claiming "verified: true" would
   * otherwise undo the whole point of asking.
   */
  const proved = await isVerified(clientId, phone.value);
  /*
   * The PIN code goes on the address only when the customer has not already written it there.
   * Asking for it separately is right -- it is the one part of an address a shop can check -- but
   * appending it blindly printed "Telangana - 500029" and then "500029" again on the packing slip.
   */
  const fullAddress = address.includes(pincode) ? address : `${address}\n${pincode}`;
  const token = crypto.randomBytes(24).toString('base64url');

  let salesOrderId: string;
  // Carried out of the transaction so the address book can be filled once the order is really there.
  let placedCustomerId: string | null = null;
  try {
  salesOrderId = await prisma.$transaction(async (tx) => {
    let customerId: string;
    let phoneOnOrder = phone.value;

    if (proved) {
      /*
       * The number was proved, so this IS that customer: the same row the till knows, with their
       * history and their points. This is the whole reason for asking for a code -- without proof
       * the rule below has to make a new customer for every online order, and a regular buying
       * online would be a stranger to their own shop.
       */
      const mine = await tx.customer.findFirst({
        where: { clientId, phone: phone.value, deletedAt: null }, select: { id: true }
      });
      if (mine) {
        customerId = mine.id;
        /*
         * `shippingAddress` is ONE field, and this wrote over it on every order -- so a regular
         * sending one saree to her sister replaced her own address with her sister's, and the
         * next thing the till prefilled was wrong. It is now the address of the last order only
         * where the customer has no book of their own yet; once they have saved addresses, that
         * book is the record and this single field stops being rewritten behind them.
         */
        const hasBook = await tx.customerAddress.count({
          where: { clientId, customerId: mine.id, deletedAt: null }
        });
        if (hasBook === 0) {
          await tx.customer.update({ where: { id: mine.id }, data: { shippingAddress: fullAddress } });
        }
      } else {
        customerId = (await tx.customer.create({
          data: {
            clientId,
            customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any),
            name, email, phone: phone.value, shippingAddress: fullAddress,
            // The shop has their name, number and address: a person it can find again.
            customerType: 'REGISTERED', status: 'ACTIVE'
          },
          select: { id: true }
        })).id;
      }
    } else {
      /*
       * Unproved, so the shop's own rule for somebody arriving from outside: the number is kept on
       * the customer only when it belongs to nobody else. A number typed at a checkout is not proof
       * of who they are, and matching on it would put a stranger's order on a regular's page.
       */
      const resolvedPhone = await phoneForOutsideCustomer(tx as any, clientId, phone.value);
      phoneOnOrder = resolvedPhone.onOrder ?? phone.value;
      customerId = (await tx.customer.create({
        data: {
          clientId,
          customerCode: await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any),
          name, email, phone: resolvedPhone.onCustomer, shippingAddress: fullAddress,
          customerType: 'REGISTERED', status: 'ACTIVE'
        },
        select: { id: true }
      })).id;
    }

    const order: any = await salesOrderService.writeFullOrderInTransaction(
      tx, clientId, locationId,
      {
        customer: { id: customerId, name, phone: phoneOnOrder, shippingAddress: fullAddress },
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
        phoneVerified: proved,
        // An unproved order lets go of the shop's stock after a day; a proved one never does.
        holdExpiresAt: proved ? null : new Date(Date.now() + UNPROVED_HOLD_MS),
        payWay: payWay as any,
        // Nothing is paid yet either way: on delivery the money comes later, and online it comes
        // when the gateway says so and not a moment before.
        paid: false
      }
    });

    placedCustomerId = customerId;
    return order.id as string;
  }, { timeout: 30000, maxWait: 15000 });
  } catch (e: any) {
    /*
     * TWO THINGS THAT HAPPEN TO REAL SHOPPERS AND ARE NOT CRASHES.
     *
     * Everything thrown out of here that is not an OnlineShopRuleError becomes
     * "Something went wrong at the shop. Please try again." Both of the following threw exactly
     * that, and both are ordinary: the first tells a customer to retry an order that actually
     * succeeded, and the second tells them to retry for a piece that will never come back.
     */

    /*
     * (a) THE SAME ORDER, TWICE, AT THE SAME MOMENT -- a double tap, or a slow line and an
     * impatient thumb. The check at the top of `place` catches a second press that arrives after
     * the first finished; two presses IN FLIGHT together both pass it, and the loser dies on the
     * unique key. The order is on the shop's screen either way, so the answer to "place this
     * order" is the same as it is anywhere else here: the order.
     *
     * Read by the key rather than by the error code on purpose -- whatever went wrong locally, a
     * row under this key means the order is written, and that is what the customer needs to see.
     */
    const placed = await prisma.onlineShopOrder.findUnique({
      where: { clientId_placementKey: { clientId, placementKey } },
      select: { token: true }
    }).catch(() => null);
    if (placed) return summary(clientId, placed.token);

    /*
     * (b) SOMEBODY ELSE TOOK IT WHILE THIS ONE WAS BEING WRITTEN. The bag was priced against stock
     * read before the transaction; the hold is taken inside it, under a row lock. Between the two,
     * the last piece can go -- which is not a fault, it is a shop with one of something and two
     * people who want it. `reserveStock` says so in the shop's own words ("Insufficient stock:
     * only 0 of ... free at ..."), which is written for a cashier standing at a till, not for a
     * stranger on a phone who has just typed out their address.
     */
    const outOfStock = e?.details?.code === 'OUT_OF_STOCK'
      || (e?.statusCode === 409 && /insufficient stock/i.test(String(e?.message ?? '')));
    if (outOfStock) {
      const gone = items.find(i => i.variantId === e?.details?.variantId);
      throw new OnlineShopRuleError(
        gone
          ? `${gone.title}${gone.size ? ` (${gone.size})` : ''} has just been bought by someone else. ` +
            'Take it out of your bag, or ask for fewer.'
          : 'Something in your bag has just been bought by someone else. Refresh the page and try again.'
      );
    }

    throw e;
  }


  // Only once the order is really there. Inside the transaction these could tell a customer and a
  // shop about an order that then failed to save.
  afterCommit(() => {
    // Three separate promises on purpose: WhatsApp being refused to somebody who said STOP must
    // not stop their email, and neither must stop the shop being told.
    void sendOrderPlacedNotice(clientId, token);
    void emailOrderPlaced(clientId, token);
    void tellTheShop(clientId, salesOrderId);
    /*
     * The address book fills itself, for a proved customer only.
     *
     * This is what makes it worth having: order twice and you never type your address again, and
     * nobody had to notice a "save this address" tick box. Unproved, there is no one to save it
     * against -- an unproved order makes its own customer row precisely because the number is not
     * proof of who they are, and building a book on that would put one person's address in
     * another person's account.
     */
    if (proved && placedCustomerId) {
      void rememberAddress(clientId, placedCustomerId, {
        name, phone: phone.value, line: address, pincode
      });
    }
  });

  return summary(clientId, token);
}

/**
 * The customer calling their own order off.
 *
 * Only while it is still sitting at the shop. Once any of it has been sent, cancelling is a return
 * and a return is a conversation -- so this says so and points at the shop rather than pretending.
 * The cancelling itself is `salesOrderService.cancelOrder`, the same one the shop's own screen
 * uses, which is what puts the stock back on the shelf.
 */
export async function cancel(clientId: string, token: unknown) {
  const key = typeof token === 'string' ? token.trim() : '';
  const row = key ? await prisma.onlineShopOrder.findUnique({
    where: { token: key },
    select: { clientId: true, salesOrderId: true, salesOrder: { select: { status: true } } }
  }) : null;
  if (!row || row.clientId !== clientId) throw new OnlineShopRuleError('That order could not be found.');

  const status = (row as any).salesOrder.status as string;
  if (status === 'CANCELLED') return summary(clientId, key);
  if (status !== 'CONFIRMED' && status !== 'DRAFT') {
    throw new OnlineShopRuleError('This order has already been sent, so it cannot be cancelled here. Message the shop and they will help.');
  }

  await salesOrderService.cancelOrder(clientId, row.salesOrderId);
  // The shop may be half way through wrapping it, and its Alert Centre is still asking somebody
  // to. Not awaited: the customer's own page must not wait on a message to somebody else.
  void orderCancelled(clientId, row.salesOrderId, 'CUSTOMER');
  return summary(clientId, key);
}

/**
 * Orders whose hold has run out, let go.
 *
 * Unproved orders only, and only while nothing has been sent. Run from housekeeping; see the note
 * on `holdExpiresAt` for why a shop open to the internet needs this at all.
 */
export async function releaseExpiredHolds(now = new Date()) {
  const due = await prisma.onlineShopOrder.findMany({
    where: { holdExpiresAt: { not: null, lte: now }, salesOrder: { status: 'CONFIRMED' } },
    select: { clientId: true, salesOrderId: true },
    take: 200
  });

  let released = 0;
  for (const row of due) {
    try {
      await salesOrderService.cancelOrder(row.clientId, row.salesOrderId);
      // Cleared so a cancel that half-worked is not tried for ever.
      await prisma.onlineShopOrder.update({ where: { salesOrderId: row.salesOrderId }, data: { holdExpiresAt: null } });
      /*
       * The customer placed this in good faith and is about to find their order gone. Awaited,
       * unlike the other two callers: this runs in a background job with nobody waiting, and an
       * unawaited promise here would be left dangling when the loop and the process move on.
       */
      await orderCancelled(row.clientId, row.salesOrderId, 'HOLD_EXPIRED');
      released++;
    } catch (e) {
      console.warn('[online-shop] could not let go of a stale hold:', (e as Error)?.message);
    }
  }
  return released;
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
    /** Whether the customer can still call it off themselves. */
    mayCancel: o.status === 'CONFIRMED' || o.status === 'DRAFT',
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
