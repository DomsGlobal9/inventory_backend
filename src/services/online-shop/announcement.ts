import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { OnlineShopRuleError } from './rules';
import { link, checkProduct, checkCategory } from './banners';
import { windowFrom, daysOf, stateOf } from './showing';

/**
 * THE ANNOUNCEMENT BAR: one short line of words across the top of every page of the shop
 * ("Diwali sale: 10% off everything till 5 Nov"). No picture, so it costs nothing to load and reads on
 * the smallest phone. It can open a search, a department or a product when tapped -- checked the same way
 * a banner's tap is, so it is never a dead tap -- and can show only between two days.
 *
 * Kept on the shop's own row: there is exactly one per shop.
 */

/** Short enough to sit on one line of a phone. */
export const MAX_WORDS = 90;

export async function get(clientId: string) {
  const [shop, { timezone }] = await Promise.all([
    prisma.onlineShop.findUnique({
      where: { clientId },
      select: { announcementText: true, announcementLinkKind: true, announcementLinkValue: true, announcementActive: true, announcementStartsAt: true, announcementEndsAt: true }
    }),
    getShopSettings(clientId)
  ]);
  if (!shop) throw new OnlineShopRuleError('Set up your online shop first.');
  return {
    text: shop.announcementText,
    linkKind: shop.announcementLinkKind,
    linkValue: shop.announcementLinkValue,
    active: shop.announcementActive,
    ...daysOf(shop.announcementStartsAt, shop.announcementEndsAt, timezone),
    state: shop.announcementText ? stateOf({ active: shop.announcementActive, startsAt: shop.announcementStartsAt, endsAt: shop.announcementEndsAt }) : 'OFF'
  };
}

export async function save(clientId: string, input: {
  text?: unknown; linkKind?: unknown; linkValue?: unknown; active?: unknown; showFrom?: unknown; showUntil?: unknown;
}) {
  const exists = await prisma.onlineShop.findUnique({ where: { clientId }, select: { id: true } });
  if (!exists) throw new OnlineShopRuleError('Set up your online shop first.');
  const text = typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim() : '';
  const active = input.active === true;
  if (text.length > MAX_WORDS) throw new OnlineShopRuleError(`Keep it to ${MAX_WORDS} letters, so it fits on one line of a phone.`);
  if (active && !text) throw new OnlineShopRuleError('Write the words for the bar before switching it on.');
  const where = link(input.linkKind, input.linkValue);
  if (where.linkKind === 'PRODUCT') await checkProduct(clientId, where.linkValue!);
  if (where.linkKind === 'CATEGORY') await checkCategory(clientId, where.linkValue!);
  const { timezone } = await getShopSettings(clientId);
  const window = windowFrom(input.showFrom, input.showUntil, timezone);
  await prisma.onlineShop.update({
    where: { clientId },
    data: {
      announcementText: text || null,
      announcementLinkKind: where.linkKind,
      announcementLinkValue: where.linkValue,
      announcementActive: active,
      announcementStartsAt: window.startsAt,
      announcementEndsAt: window.endsAt
    }
  });
  return get(clientId);
}

/** What the shop page shows: the words and their tap, only while switched on and inside its days. */
export function publicOf(shop: {
  announcementText: string | null; announcementLinkKind: string; announcementLinkValue: string | null;
  announcementActive: boolean; announcementStartsAt: Date | null; announcementEndsAt: Date | null;
}, now = new Date()) {
  if (!shop.announcementText) return null;
  if (stateOf({ active: shop.announcementActive, startsAt: shop.announcementStartsAt, endsAt: shop.announcementEndsAt }, now) !== 'LIVE') return null;
  return {
    text: shop.announcementText,
    link: shop.announcementLinkKind === 'NONE' ? null : { kind: shop.announcementLinkKind, value: shop.announcementLinkValue }
  };
}
