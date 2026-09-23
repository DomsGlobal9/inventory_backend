/**
 * A shop's own online shop: its settings, and the public answers a shopper's browser gets.
 *
 * Two audiences, deliberately kept apart in this file:
 *
 *   - the OWNER, signed in, setting the shop up (`settingsFor`, `save`, `goLive`);
 *   - the SHOPPER, nobody, opening `shop.scaleezy.com/<slug>` (`publicShop`, `publicProducts`).
 *
 * The public half never reads a row the owner half wrote without filtering it. Rule O6: nothing
 * about the shop leaks beyond what it chose to publish -- no cost price, no supplier, no stock of a
 * location that does not sell online, and never another shop. The catalogue itself comes from the
 * storefront catalogue service, which already answers scoped by client and locations and already
 * leaves cost prices out; this module does not read products directly.
 */
import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { env } from '../../config/env';
import { storefrontCatalogueService, type CatalogueScope } from '../storefront-catalogue.service';
import { checkSlug, readyToGoLive, shopUrl, OnlineShopRuleError } from './rules';
import * as banners from './banners';

export { OnlineShopRuleError };

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Where shops live. Unset in development, which simply means no address is shown yet. */
export const shopBaseUrl = (): string | null => env.SHOP_BASE_URL ?? null;

/**
 * The host shops are served on (shop.scaleezy.com), or null.
 *
 * Null when SHOP_BASE_URL is unset, and also when it points at a path rather than a whole host --
 * the gate that uses this must never half-apply, the same care taken for the short-link host.
 */
export function shopHost(): string | null {
  if (!env.SHOP_BASE_URL) return null;
  try {
    const u = new URL(env.SHOP_BASE_URL);
    if (u.pathname !== '/' && u.pathname !== '') return null;
    const host = u.hostname.toLowerCase();

    // Pointed at this service's own public name by mistake, the gate would answer every API call
    // with a shop page and take the whole backend down -- the app, the till, every shop at once.
    // Render tells each service its own name, so that mistake can be caught rather than suffered.
    const ours = (process.env.RENDER_EXTERNAL_HOSTNAME ?? '').toLowerCase();
    if (ours && host === ours) {
      console.error(
        `[online-shop] SHOP_BASE_URL points at this service's own address (${host}), which would ` +
        'hide the API behind shop pages. Shops are switched off until it points at its own host.'
      );
      return null;
    }
    return host;
  } catch { return null; }
}

/**
 * The shop's own details for the public page: logo, address, GSTIN.
 *
 * Read straight from the settings row rather than widening `getShopSettings`, which is cached and
 * sits on the till's hot path -- a shopper opening a catalogue is not a reason to make every sale
 * carry three more columns.
 */
async function sellerDetails(clientId: string) {
  return prisma.clientSettings.findUnique({
    where: { clientId },
    select: { logoUrl: true, businessAddress: true, gstNumber: true, businessPhone: true }
  }).catch(() => null);
}

// ── The owner's side ──────────────────────────────────────────────────────────────────────

/**
 * The shop's settings, making the row on first look so the screen has something to edit. Nothing
 * is live until the owner says so, so creating a row here cannot put a shop online by accident.
 */
export async function settingsFor(clientId: string) {
  const [row, settings, seller] = await Promise.all([
    prisma.onlineShop.findUnique({ where: { clientId } }),
    getShopSettings(clientId).catch(() => null),
    sellerDetails(clientId)
  ]);
  const shop = row ?? null;
  const fallbackName = settings?.businessName ?? null;
  return {
    slug: shop?.slug ?? null,
    url: shop ? shopUrl(shopBaseUrl(), shop.slug) : null,
    isLive: shop?.isLive ?? false,
    displayName: shop?.displayName ?? fallbackName,
    logoUrl: shop?.logoUrl ?? seller?.logoUrl ?? null,
    bannerUrl: shop?.bannerUrl ?? null,
    accent: shop?.accent ?? null,
    locationIds: shop?.locationIds ?? [],
    hideOutOfStock: shop?.hideOutOfStock ?? false,
    returnPolicy: shop?.returnPolicy ?? null,
    grievanceName: shop?.grievanceName ?? null,
    grievancePhone: shop?.grievancePhone ?? null,
    grievanceEmail: shop?.grievanceEmail ?? null,
    /** What is still missing before it can be opened, in the owner's words. */
    missingBeforeLive: readyToGoLive(shop ?? {}, fallbackName)
  };
}

/**
 * Claim an address, or change one that has never been live.
 *
 * A slug is taken for good once a shop has been live on it, because by then it is on QR codes and
 * in messages nobody can edit. Before that it is just a choice, and changing your mind should be
 * allowed -- so the history row is written when the shop goes LIVE, not when the slug is picked.
 */
export async function chooseSlug(clientId: string, raw: unknown) {
  const slug = checkSlug(raw);

  const taken = await prisma.onlineShopSlugHistory.findUnique({ where: { slug } });
  if (taken && taken.clientId !== clientId) {
    throw new OnlineShopRuleError('Another shop has used that web address. Choose a different one.');
  }
  const inUse = await prisma.onlineShop.findUnique({ where: { slug }, select: { clientId: true } });
  if (inUse && inUse.clientId !== clientId) {
    throw new OnlineShopRuleError('Another shop already has that web address. Choose a different one.');
  }

  const existing = await prisma.onlineShop.findUnique({ where: { clientId }, select: { slug: true, isLive: true } });
  if (existing?.isLive && existing.slug !== slug) {
    throw new OnlineShopRuleError(
      'Your shop is already open at its current address, which customers may have saved or scanned. ' +
      'Close the shop first if you really want to change it.'
    );
  }

  await prisma.onlineShop.upsert({
    where: { clientId },
    create: { clientId, slug, locationIds: [] },
    update: { slug }
  });
  return settingsFor(clientId);
}

/** Everything except the address, which has its own rules. */
export async function save(clientId: string, input: {
  displayName?: unknown; accent?: unknown; locationIds?: unknown; hideOutOfStock?: unknown;
  returnPolicy?: unknown; grievanceName?: unknown; grievancePhone?: unknown; grievanceEmail?: unknown;
}) {
  const shop = await prisma.onlineShop.findUnique({ where: { clientId } });
  if (!shop) throw new OnlineShopRuleError('Choose a web address for your shop first.');

  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : undefined);

  // Only locations this shop actually has, and only ones that can sell: a godown quietly added by
  // hand must not put its stock in front of customers.
  let locationIds: string[] | undefined;
  if (input.locationIds !== undefined) {
    const asked = Array.isArray(input.locationIds) ? input.locationIds.filter((x): x is string => typeof x === 'string') : [];
    const real = await prisma.stockLocation.findMany({
      where: { clientId, id: { in: asked }, active: true },
      select: { id: true }
    });
    if (asked.length && real.length !== asked.length) {
      throw new OnlineShopRuleError('One of those stores is not yours, or is switched off.');
    }
    locationIds = real.map(l => l.id);
  }

  await prisma.onlineShop.update({
    where: { clientId },
    data: {
      displayName: text(input.displayName, 60),
      accent: typeof input.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.accent.trim()) ? input.accent.trim() : undefined,
      ...(locationIds !== undefined ? { locationIds } : {}),
      ...(input.hideOutOfStock !== undefined ? { hideOutOfStock: input.hideOutOfStock === true } : {}),
      returnPolicy: text(input.returnPolicy, 4000),
      grievanceName: text(input.grievanceName, 80),
      grievancePhone: text(input.grievancePhone, 20),
      grievanceEmail: text(input.grievanceEmail, 120)
    }
  });
  return settingsFor(clientId);
}

/**
 * Open or close the shop.
 *
 * Opening writes the slug into the history in the same transaction, which is the moment it stops
 * being a choice and becomes an address somebody may scan off a poster. Closing leaves the history
 * behind on purpose.
 */
export async function setLive(clientId: string, live: boolean) {
  const shop = await prisma.onlineShop.findUnique({ where: { clientId } });
  if (!shop) throw new OnlineShopRuleError('Choose a web address for your shop first.');

  if (live) {
    const settings = await getShopSettings(clientId).catch(() => null);
    const missing = readyToGoLive(shop, settings?.businessName);
    if (missing.length) {
      throw new OnlineShopRuleError(`Before your shop can open, it needs ${missing.join(', and ')}.`);
    }
    await prisma.$transaction([
      prisma.onlineShopSlugHistory.upsert({
        where: { slug: shop.slug },
        create: { slug: shop.slug, clientId },
        update: { releasedAt: null }
      }),
      prisma.onlineShop.update({ where: { clientId }, data: { isLive: true } })
    ]);
  } else {
    await prisma.onlineShop.update({ where: { clientId }, data: { isLive: false } });
  }
  return settingsFor(clientId);
}

// ── The shopper's side: public, nobody signed in ───────────────────────────────────────────

export type PublicShopState = 'OPEN' | 'CLOSED' | 'UNKNOWN';

/**
 * Who this address belongs to, and whether it is open.
 *
 * A closed shop answers CLOSED, not "no such shop": somebody who saved the link deserves to be
 * told the shop is not open rather than left thinking they mistyped. An address nobody has ever
 * used answers UNKNOWN, and says nothing about whether it once existed.
 */
export async function publicShop(slugRaw: unknown): Promise<
  | { state: 'UNKNOWN' }
  | { state: 'CLOSED'; name: string }
  | { state: 'OPEN'; clientId: string; name: string; logoUrl: string | null; bannerUrl: string | null;
      accent: string | null; currency: string; hideOutOfStock: boolean; locationIds: string[];
      seller: { name: string | null; address: string | null; gstNumber: string | null };
      /** The shop's own number, for "Ask on WhatsApp". Phase 1 has no basket: this IS the order. */
      whatsapp: string | null;
      banners: Awaited<ReturnType<typeof banners.publicFor>>;
      grievance: { name: string | null; phone: string | null; email: string | null };
      returnPolicy: string | null }
> {
  const slug = typeof slugRaw === 'string' ? slugRaw.trim().toLowerCase() : '';
  if (!slug || slug.length > 40) return { state: 'UNKNOWN' };

  const shop = await prisma.onlineShop.findUnique({ where: { slug } });
  if (!shop) return { state: 'UNKNOWN' };

  const [settings, seller, shown] = await Promise.all([
    getShopSettings(shop.clientId).catch(() => null),
    sellerDetails(shop.clientId),
    banners.publicFor(shop.clientId).catch(() => [])
  ]);
  const name = shop.displayName?.trim() || settings?.businessName?.trim() || 'This shop';
  if (!shop.isLive) return { state: 'CLOSED', name };

  return {
    state: 'OPEN',
    clientId: shop.clientId,
    name,
    logoUrl: shop.logoUrl ?? seller?.logoUrl ?? null,
    bannerUrl: shop.bannerUrl ?? null,
    accent: shop.accent ?? null,
    currency: settings?.currency ?? 'INR',
    hideOutOfStock: shop.hideOutOfStock,
    locationIds: shop.locationIds,
    // The Consumer Protection (E-Commerce) Rules 2020 require the seller's own details on the
    // page: the shop is the seller, not ScaleEzy.
    seller: {
      name: settings?.businessName ?? null,
      address: seller?.businessAddress ?? null,
      gstNumber: seller?.gstNumber ?? null
    },
    // The shop's own number, which it already has to show as a contact under the Consumer
    // Protection Rules. Nothing of a customer's is ever published here.
    whatsapp: seller?.businessPhone ?? shop.grievancePhone ?? null,
    banners: shown,
    grievance: { name: shop.grievanceName, phone: shop.grievancePhone, email: shop.grievanceEmail },
    returnPolicy: shop.returnPolicy
  };
}

/**
 * The shop's catalogue as a shopper sees it.
 *
 * Built on the storefront catalogue service rather than reading products here, so the online shop
 * and a merchant's own website answer from one place and cannot drift apart. What this adds is the
 * shop's own choices: only its online locations, and whether a sold-out piece is hidden.
 */
/**
 * The shop's catalogue as a shopper browses it: search, filters, sorting, page by page.
 *
 * Built on the catalogue service's browse query rather than reading products here, so the online
 * shop and a merchant's own website answer from one place. What this adds is the shop's own
 * choices -- only its online locations, and whether a sold-out piece is hidden.
 */
export async function publicProducts(
  shop: { clientId: string; locationIds: string[]; hideOutOfStock: boolean },
  opts: {
    q?: string; category?: string; fabric?: string; dressType?: string;
    minPrice?: number; maxPrice?: number; sort?: string; page?: number; limit?: number;
  } = {}
) {
  const scope: CatalogueScope = { clientId: shop.clientId, locationIds: shop.locationIds };
  const sort = ['NEW', 'PRICE_LOW', 'PRICE_HIGH', 'NAME'].includes(String(opts.sort))
    ? (opts.sort as 'NEW' | 'PRICE_LOW' | 'PRICE_HIGH' | 'NAME')
    : 'NEW';

  const page = await storefrontCatalogueService.browseProducts(scope, { ...opts, sort });

  const products = page.products.map(forShopper)
    .filter(p => (shop.hideOutOfStock ? p.variants.some(v => v.sellable) : true));

  return { products, page: page.page, limit: page.limit, total: page.total, hasMore: page.hasMore };
}

/**
 * What a shopper is allowed to see of a product.
 *
 * A shopper is told whether they can buy a piece, never how many are left: a stock count is the
 * shop's business, and "only 2 left" is a decision for the shop to make, not a leak.
 */
function forShopper(p: Awaited<ReturnType<typeof storefrontCatalogueService.getProduct>> & object) {
  return {
    ...p,
    variants: p.variants.map(v => ({
      sku: v.sku, variantCode: v.variantCode, size: v.size, colour: v.colour,
      price: v.price, compareAtPrice: v.compareAtPrice, currency: v.currency,
      sellable: v.stock.sellable
    }))
  };
}

/** One product, by the code its page is addressed with. */
export async function publicProduct(
  shop: { clientId: string; locationIds: string[] },
  productCode: unknown
) {
  const code = typeof productCode === 'string' ? productCode.trim() : '';
  if (!code) throw fail(400, 'Which product is missing.');
  const scope: CatalogueScope = { clientId: shop.clientId, locationIds: shop.locationIds };
  const p = await storefrontCatalogueService.getProduct(scope, code);
  return p ? forShopper(p) : null;
}
