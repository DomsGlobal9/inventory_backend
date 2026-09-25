import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { OnlineShopRuleError } from './rules';

/**
 * "Tell the shop I want this."
 *
 * A sold-out colour is the one moment a shop learns about demand it has no other way to see:
 * somebody came, wanted it, and left. The page already offers "Ask if it is coming back", which
 * hands them to WhatsApp and leaves no record -- so a shop with twenty such messages over three
 * weeks cannot tell that eleven of them were for the same saree.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is promise to message them when it returns. Nothing here
 * watches stock, and a button that says "we'll tell you" while nothing is listening is worse
 * than no button: somebody hands over their number, waits, and hears nothing. The shop is shown
 * who is waiting and rings them -- which for a saree shop, where one piece is often literally
 * one piece, is the better call anyway.
 */

const MOST_PER_PHONE = 30;

/** Somebody wants this piece. Idempotent: asking twice is still one person waiting. */
export async function wantThis(
  clientId: string,
  input: { productCode?: unknown; variantCode?: unknown; phone?: unknown; name?: unknown }
) {
  const phone = normalisePhone(input.phone);
  if (!phone.ok) throw new OnlineShopRuleError('That phone number does not look right. The shop needs it to reach you.');

  const variantCode = typeof input.variantCode === 'string' ? input.variantCode.trim() : '';
  if (!variantCode) throw new OnlineShopRuleError('We could not tell which piece that was. Open it again and try.');

  const variant = await prisma.productVariant.findFirst({
    where: { clientId, variantCode },
    select: { id: true, productId: true, colorName: true, size: true, product: { select: { title: true, status: true, trashedAt: true } } }
  });
  // A piece that is no longer sold gets no waiting list. Nobody should be rung about it later.
  if (!variant || variant.product.trashedAt || variant.product.status !== 'ACTIVE') {
    throw new OnlineShopRuleError('That piece is no longer in this shop.');
  }

  /*
   * A ceiling per phone number. This is reachable by anybody on the internet with no account,
   * and without it one script could write a row for every variant in every shop. Thirty is far
   * more than a real shopper waiting on pieces and far less than a useful attack.
   */
  const already = await prisma.shopInterest.count({ where: { clientId, phone: phone.value, handledAt: null } });
  if (already >= MOST_PER_PHONE) {
    throw new OnlineShopRuleError('You are already on the list for several pieces. The shop will be in touch.');
  }

  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ').slice(0, 80) : null;

  // upsert, not create: pressing the button twice must not make two people waiting.
  await prisma.shopInterest.upsert({
    where: { variantId_phone: { variantId: variant.id, phone: phone.value } },
    create: { clientId, productId: variant.productId, variantId: variant.id, phone: phone.value, name: name || null },
    // Their name may have been filled in since, and asking again means they still want it.
    update: { ...(name ? { name } : {}), handledAt: null }
  });

  return {
    waiting: true,
    piece: [variant.product.title, variant.colorName, variant.size].filter(Boolean).join(' · ')
  };
}

/** Who is waiting, for the shop. Newest first, still-outstanding only unless asked otherwise. */
export async function whoIsWaiting(clientId: string, opts: { productId?: string; includeHandled?: boolean } = {}) {
  const rows = await prisma.shopInterest.findMany({
    where: {
      clientId,
      ...(opts.productId ? { productId: opts.productId } : {}),
      ...(opts.includeHandled ? {} : { handledAt: null })
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, phone: true, name: true, createdAt: true, handledAt: true, productId: true,
      product: { select: { title: true, productCode: true } },
      variant: { select: { variantCode: true, colorName: true, size: true } }
    }
  });

  return rows.map(r => ({
    id: r.id,
    phone: r.phone,
    name: r.name,
    askedAt: r.createdAt.toISOString(),
    handled: r.handledAt != null,
    productId: r.productId,
    productCode: r.product.productCode,
    title: r.product.title,
    variantCode: r.variant.variantCode,
    piece: [r.variant.colorName, r.variant.size].filter(Boolean).join(' · ')
  }));
}

/** The shop has dealt with one. Kept rather than deleted, so the demand is still countable. */
export async function markHandled(clientId: string, id: string) {
  const { count } = await prisma.shopInterest.updateMany({
    where: { id, clientId },
    data: { handledAt: new Date() }
  });
  if (count === 0) throw new OnlineShopRuleError('That one is no longer on the list.');
  return { handled: true };
}
