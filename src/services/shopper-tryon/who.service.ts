import { canVerify, whoIs } from '../online-shop/otp';
import { OnlineShopRuleError } from '../online-shop/rules';

/**
 * Who is trying this on (owner, 28 Oct): a shopper gives their WhatsApp number, proved with a code,
 * BEFORE a try-on -- on the tag's QR page and in the online shop -- so the shop knows who tried what
 * (it shows on their Customer card and reaches CRM).
 *
 * The fallback, also the owner's: a shop whose own WhatsApp is not linked cannot send a code, so its
 * try-ons carry on as before, anonymous, counted only in the garment totals. Refusing them would take
 * try-on away from every shop that has not linked a phone yet.
 *
 * The number comes from the token the browser earned by typing the code back (services/online-shop/
 * otp), never from anything the page says -- otherwise anybody could put pieces on someone else's card.
 */

/** Refused because a proved number is needed first. The page shows the number step on `needsNumber`. */
export class NumberNeededError extends OnlineShopRuleError {
  readonly needsNumber = true;
}

/**
 * The proved number for this try-on, or null when this shop cannot prove numbers (anonymous, as
 * before). Throws NumberNeededError when the shop can and this browser has not (or its proof ran out).
 */
export async function shopperFor(clientId: string, token: unknown): Promise<string | null> {
  if (!(await canVerify(clientId))) return null;
  const phone = await whoIs(clientId, token);
  if (!phone) throw new NumberNeededError('Confirm your WhatsApp number to try this on.');
  return phone;
}

/** Whether this shop asks for a number before a try-on (its WhatsApp is linked). */
export const asksForNumber = (clientId: string) => canVerify(clientId).catch(() => false);
