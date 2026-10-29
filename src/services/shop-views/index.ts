import { prisma } from '../../lib/prisma';
import { whoIs } from '../online-shop/otp';

/**
 * WHAT A KNOWN SHOPPER LOOKED AT ONLINE -- for the Customer card ("she looked at this three times").
 *
 * Only a browser that proved its number with the WhatsApp code is ever recorded: the page sends the
 * secret it earned, and the number comes from that, never from anything the page claims. Nobody
 * anonymous is tracked, and no address, name or photo is kept -- a product, two counts and dates.
 *
 * One row per person per product. A row is forgotten KEEP_DAYS after they last looked (housekeeping),
 * which is also all the card ever reads -- unless it carries a heart: a piece somebody saved stays on
 * their wishlist until they take the heart off (29 Oct). The card still reads only the last KEEP_DAYS.
 */
export const KEEP_DAYS = 30;
const KEEP_MS = KEEP_DAYS * 86_400_000;
/** Opening the same page again within this long is the same look, not another (a refresh, a back button). */
const SAME_LOOK_MS = 10 * 60 * 1000;

export type SeenKind = 'VIEW' | 'TRYON';

/**
 * A shopper opened a product's page, or tried it on. Never fails the page: anything odd is simply
 * not recorded. Returns whether it counted, for tests.
 */
export async function seen(clientId: string, token: unknown, productCode: unknown, kind: SeenKind, variantCode?: unknown, now = new Date()): Promise<boolean> {
  const phone = await whoIs(clientId, token);
  if (!phone) return false;
  const code = typeof productCode === 'string' ? productCode.trim() : '';
  if (!code) return false;
  const product = await prisma.product.findFirst({ where: { clientId, productCode: code, status: 'ACTIVE', trashedAt: null }, select: { id: true } });
  if (!product) return false;
  const vCode = typeof variantCode === 'string' ? variantCode.trim() : '';
  const variant = vCode
    ? await prisma.productVariant.findFirst({ where: { clientId, productId: product.id, variantCode: vCode }, select: { id: true } })
    : null;

  const key = { clientId_phone_productId: { clientId, phone, productId: product.id } };
  const held = await prisma.shopProductView.findUnique({ where: key, select: { lastAt: true, views: true } });
  const sameLook = kind === 'VIEW' && !!held && held.views > 0 && now.getTime() - held.lastAt.getTime() < SAME_LOOK_MS;
  const update = {
    ...(kind === 'VIEW' && !sameLook ? { views: { increment: 1 } } : {}),
    ...(kind === 'TRYON' ? { tryOns: { increment: 1 } } : {}),
    ...(variant ? { variantId: variant.id } : {}),
    lastAt: now
  };
  try {
    await prisma.shopProductView.upsert({
      where: key,
      create: { clientId, phone, productId: product.id, views: kind === 'VIEW' ? 1 : 0, tryOns: kind === 'TRYON' ? 1 : 0, variantId: variant?.id ?? null, firstAt: now, lastAt: now },
      update
    });
  } catch (e) {
    // Two tabs opening the same piece at once both try to create its first row; one wins, the other
    // finds it there. Two views in the same instant are one look; a try-on still counts.
    if ((e as { code?: string })?.code !== 'P2002') throw e;
    const { views: _sameLook, ...rest } = update as typeof update & { views?: unknown };
    await prisma.shopProductView.update({ where: key, data: kind === 'VIEW' ? rest : update });
  }
  return kind === 'TRYON' || !sameLook;
}

/**
 * A heart on a try-on (TryOn2Buy's list, 28 Oct): this number likes this piece, or no longer does.
 * The same rule as `seen`: only a proved number (the token), never what the page claims. Returns
 * whether it was saved -- false for an unproved browser or a piece that is not on sale.
 */
export async function like(clientId: string, token: unknown, productCode: unknown, liked: unknown, variantCode?: unknown, now = new Date()): Promise<boolean> {
  const phone = await whoIs(clientId, token);
  if (!phone) return false;
  const code = typeof productCode === 'string' ? productCode.trim() : '';
  if (!code) return false;
  const product = await prisma.product.findFirst({ where: { clientId, productCode: code, status: 'ACTIVE', trashedAt: null }, select: { id: true } });
  if (!product) return false;
  const vCode = typeof variantCode === 'string' ? variantCode.trim() : '';
  const variant = vCode
    ? await prisma.productVariant.findFirst({ where: { clientId, productId: product.id, variantCode: vCode }, select: { id: true } })
    : null;
  const likedAt = liked === false ? null : now;
  await prisma.shopProductView.upsert({
    where: { clientId_phone_productId: { clientId, phone, productId: product.id } },
    create: { clientId, phone, productId: product.id, views: 0, tryOns: 0, likedAt, variantId: variant?.id ?? null, firstAt: now, lastAt: now },
    update: { likedAt, lastAt: now, ...(variant ? { variantId: variant.id } : {}) }
  }).catch(async (e) => {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
    await prisma.shopProductView.update({ where: { clientId_phone_productId: { clientId, phone, productId: product.id } }, data: { likedAt, lastAt: now } });
  });
  return true;
}

/** What this number looked at in the last KEEP_DAYS, most recent first. `phone` as normalisePhone gives it. */
export async function lookedAt(clientId: string, phone: string, now = new Date()) {
  return prisma.shopProductView.findMany({
    where: { clientId, phone, lastAt: { gte: new Date(now.getTime() - KEEP_MS) } },
    orderBy: { lastAt: 'desc' },
    take: 50,
    select: { productId: true, variantId: true, views: true, tryOns: true, lastAt: true, likedAt: true }
  });
}

/**
 * What this number has hearted, newest first: the shopper's wishlist (online shop account, 29 Oct).
 * Product and colour by their codes, for the storefront catalogue to show. Pieces taken off sale are
 * left out; the heart stays, and the piece comes back if the shop puts it on sale again.
 */
export async function liked(clientId: string, phone: string, max = 60) {
  const rows = await prisma.shopProductView.findMany({
    where: { clientId, phone, likedAt: { not: null }, product: { status: 'ACTIVE', trashedAt: null } },
    orderBy: { likedAt: 'desc' }, take: max,
    select: { likedAt: true, variantId: true, product: { select: { productCode: true } } }
  });
  const variantIds = rows.map(r => r.variantId).filter((v): v is string => !!v);
  const variants = variantIds.length
    ? await prisma.productVariant.findMany({ where: { clientId, id: { in: variantIds } }, select: { id: true, variantCode: true } })
    : [];
  const codeOf = new Map(variants.map(v => [v.id, v.variantCode]));
  return rows.map(r => ({ productCode: r.product.productCode, variantCode: r.variantId ? codeOf.get(r.variantId) ?? null : null, likedAt: r.likedAt as Date }));
}

/** Looks nobody will read again. Called by housekeeping. A hearted piece is kept: it is on a wishlist. */
export async function forgetOldViews(now = new Date()) {
  const { count } = await prisma.shopProductView.deleteMany({ where: { lastAt: { lt: new Date(now.getTime() - KEEP_MS) }, likedAt: null } });
  return count;
}
