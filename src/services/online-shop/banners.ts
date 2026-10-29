import crypto from 'crypto';
import sharp from 'sharp';
import type { OnlineShopBannerLink } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { supabase } from '../../lib/supabase';
import { prepareImage, MAX_PIXELS } from '../../lib/imagePrep';
import { storefrontCatalogueService } from '../storefront-catalogue.service';
import { OnlineShopRuleError } from './rules';
import { getShopSettings } from '../../lib/clientSettings';
import { windowFrom, daysOf, stateOf, showingNow } from './showing';

/**
 * The banners across the top of a shop's own online shop.
 *
 * A shop wants to say "Festival collection is in" with a photograph, the way every shop they buy
 * from does. So: several banners, swiped, each with its own picture, a few words, and somewhere to
 * go when it is tapped.
 *
 * Where a banner goes is deliberately narrow -- nowhere, a search, or one product. A shop can make
 * "Silk sarees" point at a search for silk without anybody first inventing collections, and a
 * search cannot go stale the way a hand-typed address can: if the shop stops selling silk the
 * banner lands on an empty search that says so, not on a broken page.
 */

const BUCKET = 'inventory-images';
const FOLDER = 'shop-banners';

/**
 * Wider and heavier than a WhatsApp picture, because this one is looked at full-width on a phone
 * and is the first thing a customer sees. Still small enough to arrive quickly on a slow network.
 */
const LIMITS = {
  maxSide: 2000,
  maxBytes: 600 * 1024,
  tooBig: 'That picture could not be made small enough to load quickly. Try a simpler photo.'
};

export const MAX_BANNERS = 6;

/**
 * One shape for every banner (29 Oct): three times as wide as it is tall, give or take a tenth, and
 * at least 1200 pixels across.
 *
 * Shops upload finished designs -- their name, a "Shop now", the words drawn in -- and a banner of
 * any shape had to be cut to fit the strip, which cut exactly those off. With one shape the whole
 * picture shows on a phone and a laptop alike. The tenth either way lets a 2000 × 711 export through;
 * 1200 across is what stays sharp on a laptop. The admin screen checks the same before uploading.
 */
export const SHAPE = { ratio: 3, give: 0.1, minWidth: 1200, example: '1920 × 640' };

async function checkShape(buf: Buffer) {
  let meta: sharp.Metadata;
  // Unreadable: prepareImage says what is wrong with it, in the words it already has.
  try { meta = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata(); } catch { return; }
  if (!meta.width || !meta.height) return;
  // A phone photo stored on its side and marked "turn me" is the shape it is shown at, not stored at.
  const [w, h] = (meta.orientation ?? 1) >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
  const r = w / h;
  if (r < SHAPE.ratio * (1 - SHAPE.give) || r > SHAPE.ratio * (1 + SHAPE.give)) {
    throw new OnlineShopRuleError(
      `A banner must be 3 times as wide as it is tall, for example ${SHAPE.example} pixels. This picture is ${w} × ${h}. Crop it to that shape and choose it again.`);
  }
  if (w < SHAPE.minWidth) {
    throw new OnlineShopRuleError(
      `This picture is ${w} × ${h}, too small to stay sharp on a laptop. Use one at least ${SHAPE.minWidth} pixels wide, for example ${SHAPE.example}.`);
  }
}

/**
 * Where a banner can show (24 Oct). One banner may be in several: the festival picture in the home slider
 * AND under every product. Text values, not an enum, for the shared-database rule.
 *   HOME_TOP     the slider at the top of the home page (every banner made before this was there)
 *   HOME_MIDDLE  a wide strip between the products on the home page
 *   PRODUCT      under the details on every product's page
 */
export const PLACES = ['HOME_TOP', 'HOME_MIDDLE', 'PRODUCT'] as const;

function placesOf(v: unknown): string[] {
  if (!Array.isArray(v)) throw new OnlineShopRuleError('Choose where the banner shows.');
  const set = new Set(v.map(x => String(x).toUpperCase()));
  if ([...set].some(x => !(PLACES as readonly string[]).includes(x))) {
    throw new OnlineShopRuleError('A banner can show on the home slider, between the products, or on the product page.');
  }
  return PLACES.filter(x => set.has(x)); // the screen's order, never the click order
}

type Row = {
  id: string; imageUrl: string; width: number; height: number;
  heading: string | null; subtext: string | null;
  linkKind: string; linkValue: string | null; orderIndex: number; active: boolean;
  placements: string[]; startsAt: Date | null; endsAt: Date | null;
};
const view = (b: Row, timeZone: string) => ({
  id: b.id, imageUrl: b.imageUrl, width: b.width, height: b.height,
  heading: b.heading, subtext: b.subtext,
  linkKind: b.linkKind, linkValue: b.linkValue,
  orderIndex: b.orderIndex, active: b.active,
  placements: b.placements,
  ...daysOf(b.startsAt, b.endsAt, timeZone),
  // What the owner's list says beside it: showing now, starts later, ended, off, or placed nowhere.
  state: stateOf(b)
});

export async function listFor(clientId: string) {
  const [rows, { timezone }] = await Promise.all([
    prisma.onlineShopBanner.findMany({ where: { clientId }, orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }] }),
    getShopSettings(clientId)
  ]);
  return rows.map(b => view(b, timezone));
}

/**
 * Only the ones a shopper should see right now -- switched on, inside their dates, placed somewhere --
 * in the order the shop put them, each saying where it goes. The page picks its own by place.
 */
export async function publicFor(clientId: string) {
  const rows = await prisma.onlineShopBanner.findMany({
    where: { clientId, active: true, NOT: { placements: { isEmpty: true } }, ...showingNow() },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    select: { imageUrl: true, width: true, height: true, heading: true, subtext: true, linkKind: true, linkValue: true, placements: true }
  });
  return rows.map(b => ({
    imageUrl: b.imageUrl, width: b.width, height: b.height,
    heading: b.heading, subtext: b.subtext,
    placements: b.placements,
    // Only what the page needs to make a link; the shop's own ids are nobody's business.
    link: b.linkKind === 'NONE' ? null : { kind: b.linkKind, value: b.linkValue }
  }));
}

const words = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};

/**
 * A banner pointing at a product code nobody has is a dead tap for every customer who tries it,
 * and the owner would only find out from a customer. So the code is looked up here, in the shop's
 * own catalogue and through the same service the shopper's page reads, which means a product in
 * a location the shop does not sell online is refused too -- exactly as the shopper would find it.
 */
export async function checkProduct(clientId: string, code: string) {
  const shop = await prisma.onlineShop.findUnique({ where: { clientId }, select: { locationIds: true } });
  const found = await storefrontCatalogueService
    .getProduct({ clientId, locationIds: shop?.locationIds ?? [] }, code)
    .catch(() => null);
  if (!found) {
    throw new OnlineShopRuleError(
      `No product with the code ${code} is in your online shop. Check the code, or tick the store it is in.`
    );
  }
}

/**
 * A department the shop actually sells, checked the same way a product code is.
 *
 * The nav is built from what the catalogue really holds, so a banner pointing at a department the
 * shop has nothing in would land on an empty page -- a dead tap by another name.
 */
export async function checkCategory(clientId: string, value: string) {
  const { facetsFor } = await import('./facets');
  const shop = await prisma.onlineShop.findUnique({
    where: { clientId }, select: { locationIds: true, hideOutOfStock: true }
  });
  const facets = await facetsFor(clientId, {
    locationIds: shop?.locationIds ?? [], hideOutOfStock: shop?.hideOutOfStock ?? false
  });
  if (!facets.categories.some(c => c.value === value.toUpperCase())) {
    throw new OnlineShopRuleError(
      `You do not have anything in ${value} online yet, so a banner pointing there would open an empty page.`
    );
  }
}

/** Where tapping it goes, checked so a banner can never be a dead tap. */
export function link(kind: unknown, value: unknown): { linkKind: OnlineShopBannerLink; linkValue: string | null } {
  const k = String(kind ?? 'NONE').toUpperCase();
  if (k === 'NONE' || !k) return { linkKind: 'NONE', linkValue: null };
  if (k !== 'SEARCH' && k !== 'PRODUCT' && k !== 'CATEGORY') {
    throw new OnlineShopRuleError('A banner can go to a search, to a department, or to one product.');
  }
  const v = words(value, 120);
  if (!v) {
    throw new OnlineShopRuleError(
      k === 'SEARCH' ? 'Say what this banner should search for, for example "silk".'
      : k === 'CATEGORY' ? 'Choose which department this banner opens.'
      : 'Choose which product this banner opens.');
  }
  return { linkKind: k as OnlineShopBannerLink, linkValue: v };
}

export async function add(clientId: string, userId: string | null, input: {
  base64?: unknown; heading?: unknown; subtext?: unknown; linkKind?: unknown; linkValue?: unknown;
  placements?: unknown; showFrom?: unknown; showUntil?: unknown;
}) {
  const count = await prisma.onlineShopBanner.count({ where: { clientId } });
  if (count >= MAX_BANNERS) {
    throw new OnlineShopRuleError(`A shop can have ${MAX_BANNERS} banners. Remove one to add another.`);
  }

  const raw = typeof input.base64 === 'string' ? input.base64.replace(/^data:image\/[a-z+]+;base64,/i, '') : '';
  if (!raw) throw new OnlineShopRuleError('Choose a picture for the banner.');
  let buf: Buffer;
  try { buf = Buffer.from(raw, 'base64'); }
  catch { throw new OnlineShopRuleError('That picture did not arrive intact. Please choose it again.'); }

  // Checked before the picture is touched: shrinking a large photograph takes real work, and an
  // upload that is going to be refused anyway should be refused before any of it is done.
  const where = link(input.linkKind, input.linkValue);
  if (where.linkKind === 'PRODUCT') await checkProduct(clientId, where.linkValue!);
  if (where.linkKind === 'CATEGORY') await checkCategory(clientId, where.linkValue!);
  // Not sent (an older screen): the home slider, where every banner went before there was a choice.
  const placements = input.placements === undefined ? ['HOME_TOP'] : placesOf(input.placements);
  const { timezone } = await getShopSettings(clientId);
  const window = windowFrom(input.showFrom, input.showUntil, timezone);

  await checkShape(buf);
  const prepared = await prepareImage(buf, LIMITS);

  // A name nobody can guess, so the address of a shop's banner says nothing about the shop.
  const imagePath = `${FOLDER}/${crypto.randomBytes(16).toString('hex')}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(imagePath, prepared.jpeg, {
    contentType: 'image/jpeg',
    cacheControl: '3600',
    upsert: false
  });
  if (error) throw new OnlineShopRuleError('The picture could not be saved just now. Please try again.');

  const imageUrl = supabase.storage.from(BUCKET).getPublicUrl(imagePath).data.publicUrl;

  try {
    await prisma.onlineShopBanner.create({
      data: {
        clientId, imageUrl, imagePath,
        width: prepared.width, height: prepared.height,
        heading: words(input.heading, 60),
        subtext: words(input.subtext, 120),
        ...where,
        placements, ...window,
        orderIndex: count,
        createdById: userId
      }
    });
    // The whole list, as every other banner call answers, so the screen never has to work out
    // where a new one belongs among the ones already there.
    return listFor(clientId);
  } catch (e) {
    // Nothing points at the file: take it away rather than leave it in the bucket for ever.
    await supabase.storage.from(BUCKET).remove([imagePath]).catch(() => undefined);
    throw e;
  }
}

/** The words, where it goes, and whether it is shown. Not the picture: that is a new banner. */
export async function edit(clientId: string, id: string, input: {
  heading?: unknown; subtext?: unknown; linkKind?: unknown; linkValue?: unknown; active?: unknown;
  placements?: unknown; showFrom?: unknown; showUntil?: unknown;
}) {
  const row = await prisma.onlineShopBanner.findFirst({ where: { id, clientId } });
  if (!row) throw new OnlineShopRuleError('That banner is not there any more.');

  // Left alone entirely when the screen did not send one, so editing only the words cannot
  // silently unset where the banner goes.
  let where: { linkKind: OnlineShopBannerLink; linkValue: string | null } | null = null;
  if (input.linkKind !== undefined) {
    where = link(input.linkKind, input.linkValue);
    if (where.linkKind === 'PRODUCT') await checkProduct(clientId, where.linkValue!);
    if (where.linkKind === 'CATEGORY') await checkCategory(clientId, where.linkValue!);
  }
  // The dates travel together: both sent (either may be empty for "no limit"), or neither changes.
  const dated = input.showFrom !== undefined || input.showUntil !== undefined;
  const window = dated ? windowFrom(input.showFrom, input.showUntil, (await getShopSettings(clientId)).timezone) : null;
  await prisma.onlineShopBanner.update({
    where: { id },
    data: {
      ...(input.placements !== undefined ? { placements: placesOf(input.placements) } : {}),
      ...(window ?? {}),
      ...(input.heading !== undefined ? { heading: words(input.heading, 60) } : {}),
      ...(input.subtext !== undefined ? { subtext: words(input.subtext, 120) } : {}),
      ...(where ?? {}),
      ...(input.active !== undefined ? { active: input.active === true } : {})
    }
  });
  return listFor(clientId);
}

/** The order the shop wants them in, given as the ids from first to last. */
export async function reorder(clientId: string, ids: unknown) {
  const wanted = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  const mine = await prisma.onlineShopBanner.findMany({ where: { clientId }, select: { id: true } });
  const mineIds = new Set(mine.map(b => b.id));
  if (wanted.length !== mine.length || wanted.some(id => !mineIds.has(id))) {
    throw new OnlineShopRuleError('That is not the list of this shop\'s banners.');
  }
  await prisma.$transaction(
    wanted.map((id, i) => prisma.onlineShopBanner.update({ where: { id }, data: { orderIndex: i } }))
  );
  return listFor(clientId);
}

export async function remove(clientId: string, id: string) {
  const row = await prisma.onlineShopBanner.findFirst({ where: { id, clientId } });
  if (!row) throw new OnlineShopRuleError('That banner is not there any more.');
  // The row first: a banner still on the page whose picture has gone is worse than a file left
  // behind, and the file is cleaned up either way.
  await prisma.onlineShopBanner.delete({ where: { id } });
  if (row.imagePath) await supabase.storage.from(BUCKET).remove([row.imagePath]).catch(() => undefined);
  return listFor(clientId);
}
