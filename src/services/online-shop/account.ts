import { prisma } from '../../lib/prisma';
import { OnlineShopRuleError } from './rules';
import { whoIs, canVerify } from './otp';
import { summary } from './checkout';
import { mine as savedAddresses } from './addresses';
import * as sessions from './sessions';
import * as shopViews from '../shop-views';
import { publicProduct } from './shop.service';

/**
 * A shopper's account at one shop's online store (29 Oct): "Sign in with WhatsApp", no password.
 *
 * There is no account row. An account is a number this shop proved with its own WhatsApp code; what
 * it shows is what already belongs to that number here:
 *   - orders placed with this number AND proved at the checkout (an order somebody placed by typing
 *     this number, never proving it, is not this person's to read -- it carries a stranger's address);
 *   - the addresses saved for this number's customer, the pieces hearted, and
 *   - the customer's points (only while the shop runs loyalty) and store credit (only when some is held).
 *
 * Signing in: prove the number with the code (otp.ts), then start() turns that browser's pass into a
 * 90-day sign-in (sessions.ts). A guest who proves the number at the checkout is signed in the same way
 * by the order page, so nobody has to sign in twice.
 */

type Shop = { clientId: string; locationIds: string[]; showFewLeft?: boolean };
/** Orders listed on the account page, newest first. */
const MAX_ORDERS = 30;

/** Turn this browser's proof (a code check's pass, or a sign-in already) into a sign-in. */
export async function start(clientId: string, token: unknown, userAgent: unknown) {
  const phone = await whoIs(clientId, token);
  if (!phone) throw new OnlineShopRuleError('Confirm your number with the WhatsApp code first.');
  // Already a sign-in: the same one, not another device.
  if (sessions.isSignIn(token) && await sessions.phoneFor(clientId, String(token)) === phone) {
    return { token: String(token), phone };
  }
  return { token: await sessions.create(clientId, phone, sessions.deviceOf(userAgent)), phone };
}

/** Sign this device out, or every device this number is signed in on at this shop. */
export async function signOut(clientId: string, token: unknown, everywhere: unknown) {
  const phone = await whoIs(clientId, token);
  if (!phone) return { signedOut: true, devices: 0 };   // already out: the same answer, nothing to say
  if (everywhere === true) return { signedOut: true, devices: await sessions.revokeAll(clientId, phone) };
  if (sessions.isSignIn(token)) await sessions.revoke(clientId, String(token));
  else await prisma.onlineShopPhoneCode.updateMany({ where: { clientId, sessionToken: String(token) }, data: { sessionToken: null, sessionExpiresAt: null } });
  return { signedOut: true, devices: 1 };
}

/** Everything the account page shows, or { signedIn: false } (with whether signing in is possible now). */
export async function me(shop: Shop, token: unknown) {
  const { clientId } = shop;
  const phone = await whoIs(clientId, token);
  if (!phone) return { signedIn: false as const, canSignIn: await canVerify(clientId) };

  const [customer, loyalty, orderRows, hearts, devices] = await Promise.all([
    prisma.customer.findFirst({ where: { clientId, phone, deletedAt: null }, select: { name: true, loyaltyPoints: true, storeCreditPaise: true } }),
    prisma.loyaltySettings.findUnique({ where: { clientId }, select: { enabled: true } }).catch(() => null),
    prisma.onlineShopOrder.findMany({
      where: { clientId, customerPhone: phone, phoneVerified: true },
      orderBy: { createdAt: 'desc' }, take: MAX_ORDERS, select: { token: true }
    }),
    shopViews.liked(clientId, phone),
    sessions.devices(clientId, phone)
  ]);

  const orders = (await Promise.all(orderRows.map(r => summary(clientId, r.token).catch(() => null))))
    .filter(Boolean)
    .map((o: any) => ({
      token: o.token, orderNumber: o.orderNumber, placedAt: o.placedAt, state: o.state, total: o.total,
      pieces: o.items.reduce((t: number, i: any) => t + i.quantity, 0),
      firstTitle: o.items[0]?.title ?? null, firstImage: o.items[0]?.imageUrl ?? null
    }));

  // Each hearted piece through the shop's own catalogue: its price, its photos, whether it can be bought now.
  const pieces = (await Promise.all(hearts.map(async h => {
    const p: any = await publicProduct(shop, h.productCode).catch(() => null);
    if (!p) return null;
    const colourOf = (code: string | null) => p.variants.find((v: any) => v.variantCode === code)?.colour ?? null;
    const colour = colourOf(h.variantCode);
    const ofColour = colour ? p.variants.filter((v: any) => v.colour === colour) : p.variants;
    const prices = ofColour.map((v: any) => Number(v.price)).filter((n: number) => Number.isFinite(n));
    const images = Array.isArray(p.images) ? p.images : [];
    // Photographs belong to a colour's variant: the hearted one's first, then any of that colour, then the product's.
    const codesOfColour = new Set(ofColour.map((v: any) => v.variantCode));
    const picture = images.find((i: any) => i.variantCode && i.variantCode === h.variantCode)?.url
      || images.find((i: any) => i.variantCode && codesOfColour.has(i.variantCode))?.url
      || images.find((i: any) => i.isPrimary)?.url || images[0]?.url || null;
    return {
      productCode: h.productCode, variantCode: h.variantCode, title: p.title, colour,
      price: prices.length ? Math.min(...prices) : null,
      imageUrl: picture,
      available: ofColour.some((v: any) => v.sellable),
      likedAt: h.likedAt.toISOString()
    };
  }))).filter(Boolean);

  const lastName = (await prisma.onlineShopOrder.findFirst({
    where: { clientId, customerPhone: phone, phoneVerified: true }, orderBy: { createdAt: 'desc' },
    select: { salesOrder: { select: { customerName: true } } }
  }))?.salesOrder?.customerName ?? null;

  const addresses = (await savedAddresses(clientId, token).catch(() => ({ addresses: [] }))).addresses;

  return {
    signedIn: true as const,
    phone,
    name: customer?.name ?? lastName,
    devices,
    // Shown only where the shop runs them: points while loyalty is on, credit only when some is held.
    points: loyalty?.enabled && customer ? customer.loyaltyPoints : null,
    storeCredit: customer && customer.storeCreditPaise > 0 ? customer.storeCreditPaise / 100 : null,
    orders,
    hearts: pieces,
    addresses
  };
}
