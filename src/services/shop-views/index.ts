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
 * which is also all the card ever reads.
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
  await prisma.shopProductView.upsert({
    where: key,
    create: { clientId, phone, productId: product.id, views: kind === 'VIEW' ? 1 : 0, tryOns: kind === 'TRYON' ? 1 : 0, variantId: variant?.id ?? null, firstAt: now, lastAt: now },
    update: {
      ...(kind === 'VIEW' && !sameLook ? { views: { increment: 1 } } : {}),
      ...(kind === 'TRYON' ? { tryOns: { increment: 1 } } : {}),
      ...(variant ? { variantId: variant.id } : {}),
      lastAt: now
    }
  });
  return kind === 'TRYON' || !sameLook;
}

/** What this number looked at in the last KEEP_DAYS, most recent first. `phone` as normalisePhone gives it. */
export async function lookedAt(clientId: string, phone: string, now = new Date()) {
  return prisma.shopProductView.findMany({
    where: { clientId, phone, lastAt: { gte: new Date(now.getTime() - KEEP_MS) } },
    orderBy: { lastAt: 'desc' },
    take: 50,
    select: { productId: true, variantId: true, views: true, tryOns: true, lastAt: true }
  });
}

/** Looks nobody will read again. Called by housekeeping. */
export async function forgetOldViews(now = new Date()) {
  const { count } = await prisma.shopProductView.deleteMany({ where: { lastAt: { lt: new Date(now.getTime() - KEEP_MS) } } });
  return count;
}
