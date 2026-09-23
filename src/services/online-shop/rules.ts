/**
 * The rules of a shop's own online shop, kept apart from anything that touches the database so
 * they can be read and tested on their own.
 *
 * The slug is the part to be careful with. It is not a display name that can be tidied up later:
 * it is printed on QR codes, pasted into WhatsApp messages that live 90 days and cannot be edited,
 * and saved as a bookmark by customers. Whatever a shop picks on the first day is the address it
 * keeps, so the rules here are deliberately strict and the refusals say what to do instead.
 */

export class OnlineShopRuleError extends Error {}

const refuse = (message: string): never => {
  throw new OnlineShopRuleError(message);
};

/** lower-case letters, digits, single hyphens between them; 3-40 characters. */
export const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/**
 * Addresses we keep for ourselves, so a shop cannot take one that would collide with a page of
 * ours or read as something official. Checked against the whole slug, not a prefix: "shopping" is
 * a perfectly good shop name and only the exact word "shop" is ours.
 */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'assets', 'account', 'billing', 'cart', 'checkout', 'console', 'dashboard',
  'go', 'help', 'inventory', 'login', 'logout', 'order', 'orders', 'pay', 'payment', 'privacy',
  's', 'scaleezy', 'settings', 'shop', 'shops', 'signin', 'signup', 'static', 'status', 'support',
  'terms', 'tryon', 'www'
]);

/**
 * A shop's chosen address, checked and normalised.
 *
 * Normalising rather than refusing where the intent is obvious: an owner who types "Lakshmi Silks"
 * means `lakshmi-silks`, and refusing that teaches them nothing. An owner who types something we
 * cannot make an address out of gets a sentence saying so.
 */
export function checkSlug(raw: unknown): string {
  const typed = typeof raw === 'string' ? raw.trim() : '';
  if (!typed) refuse('Choose a web address for your shop, for example lakshmi-silks.');

  const slug = typed
    .toLowerCase()
    .replace(/['’`]/g, '')        // O'Brien -> obrien, not o-brien
    .replace(/[^a-z0-9]+/g, '-')  // spaces, dots, anything else becomes a hyphen
    .replace(/^-+|-+$/g, '')      // never starts or ends with one
    .replace(/-{2,}/g, '-');      // never two in a row

  if (slug.length < SLUG_MIN) refuse(`A web address needs at least ${SLUG_MIN} letters or numbers.`);
  if (slug.length > SLUG_MAX) refuse(`A web address can be at most ${SLUG_MAX} letters long. Try a shorter one.`);
  if (!SLUG_SHAPE.test(slug)) refuse('A web address can use only letters, numbers and hyphens.');
  if (RESERVED_SLUGS.has(slug)) refuse(`"${slug}" is kept by ScaleEzy. Choose another, for example your shop's name.`);
  // A slug that is only digits would be unreadable in a message and easy to mistype from a poster.
  if (/^\d+$/.test(slug)) refuse('A web address needs some letters in it, not only numbers.');

  return slug;
}

/** What a shop can be reached at. Kept in one place so nothing builds this address by hand. */
export function shopUrl(base: string | null | undefined, slug: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${slug}`;
}

/**
 * Is this shop ready to be opened to customers?
 *
 * Deliberately not "is the row complete": a shop with no location chosen would go live selling
 * nothing, and a shop with no name would show a customer a blank heading. Each refusal names the
 * one thing to fix, because an owner reading "not ready" learns nothing.
 */
export function readyToGoLive(shop: {
  displayName?: string | null;
  locationIds?: string[] | null;
}, fallbackName?: string | null): string[] {
  const missing: string[] = [];
  if (!(shop.displayName?.trim() || fallbackName?.trim())) missing.push('a name for the shop');
  if (!shop.locationIds?.length) missing.push('at least one store whose stock you sell online');
  return missing;
}
