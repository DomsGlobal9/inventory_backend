/**
 * Talking to ScaleEzy from a shopper's phone.
 *
 * Read-only, and it carries no credentials of any kind: `credentials: 'omit'` is deliberate and
 * load-bearing. A shopper is nobody -- there is no account, no session, nothing to attach -- and
 * the public routes are open to any origin precisely because nothing can be sent with them.
 *
 * Every failure is turned into something the page can say out loud. A shopper on a patchy phone
 * connection sees "we could not reach the shop" and a Try again button, never a blank screen or a
 * message about status codes.
 */

/**
 * The catalogue is served on the shop's own address, so there is no other host to reach and
 * nothing to ask permission for. VITE_API_URL only exists for running the app on its own in
 * development, against a backend somewhere else.
 */
const BASE = (import.meta.env.VITE_API_URL || '/_api').replace(/\/+$/, '');

/** What went wrong, in a form a page can render without knowing about HTTP. */
export class ShopError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'UNKNOWN_SHOP' | 'CLOSED' | 'GONE' | 'OFFLINE' | 'BROKEN' | 'RULE'
  }
}

async function get(path, { signal, send, method } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'omit',
      signal,
      method: method ?? (send ? 'POST' : 'GET'),
      ...(send ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(send) } : {})
    });
  } catch (e) {
    // A cancelled request is the page moving on, not a problem to report.
    if (e?.name === 'AbortError') throw e;
    throw new ShopError('OFFLINE', 'We could not reach the shop. Check your connection and try again.');
  }

  if (res.ok) {
    const body = await res.json().catch(() => null);
    if (!body?.success) throw new ShopError('BROKEN', 'The shop sent something we could not read.');
    return body.data;
  }

  const body = await res.json().catch(() => ({}));
  /*
   * A rule the shopper can do something about -- "Add a little more to your bag", "That phone
   * number does not look right" -- comes back as 400 with the sentence to show. It is not a
   * failure of the shop, so it is not dressed up as one.
   */
  if (res.status === 400 && body?.message) throw new ShopError('RULE', body.message);
  if (res.status === 404 && body?.state === 'UNKNOWN') throw new ShopError('UNKNOWN_SHOP', 'There is no shop at this address.');
  if (res.status === 503 && body?.state === 'CLOSED') throw new ShopError('CLOSED', body.message || 'This shop is not open just now.');
  if (res.status === 404) throw new ShopError('GONE', body?.message || 'That is no longer in this shop.');
  if (res.status === 429) throw new ShopError('OFFLINE', 'That was a lot of requests at once. Wait a moment and try again.');
  throw new ShopError('BROKEN', body?.message || 'Something went wrong at the shop. Please try again.');
}

export const getShop = (slug, opts) => get(`/shop/${encodeURIComponent(slug)}`, opts);

export const getProducts = (slug, query, opts) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && String(v).trim() !== '') q.set(k, String(v));
  }
  const qs = q.toString();
  return get(`/shop/${encodeURIComponent(slug)}/products${qs ? `?${qs}` : ''}`, opts);
};

export const getProduct = (slug, code, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/products/${encodeURIComponent(code)}`, opts);

/*
 * ── Buying ────────────────────────────────────────────────────────────────────────────────
 *
 * The bag is priced by the shop, never in here. The shop's own prices, the shop's own offers and
 * the shop's own delivery terms are all decided in one place, and a page that worked out its own
 * totals would sooner or later show a figure the checkout disagreed with.
 */

export const priceBag = (slug, lines, couponCodes, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/bag`, { ...opts, send: { lines, couponCodes } });

export const placeOrder = (slug, order, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/orders`, { ...opts, send: order });

export const getOrder = (slug, token, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/orders/${encodeURIComponent(token)}`, opts);

export const cancelOrder = (slug, token, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/orders/${encodeURIComponent(token)}/cancel`, { ...opts, send: {} });

/*
 * Proving the number typed at the checkout belongs to whoever typed it.
 *
 * The page never decides this. It asks for a code and sends back what was typed; whether the
 * number counts as proved is the server's answer, read again when the order is placed -- a page
 * that could claim "verified" would make the whole thing decorative.
 */
/**
 * "See it on you": the shop puts this piece on a photograph of the shopper.
 *
 * The photograph is sent once and deleted by the shop as soon as the picture is made. It is never
 * kept here either -- it lives in this page's memory until the sheet is closed.
 */
export const tryOn = (slug, productCode, photo, variantCode, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/products/${encodeURIComponent(productCode)}/tryon`,
    // variantCode says which COLOUR is on screen, so the shop sends the front view of that one.
    // Without it a shopper looking at the blue saree was tried on in whichever colour happened to
    // lead the product.
    { ...opts, send: { photo, variantCode } });

export const sendCode = (slug, phone, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/verify/send`, { ...opts, send: { phone } });

export const checkCode = (slug, phone, code, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/verify/check`, { ...opts, send: { phone, code } });

/*
 * Addresses a shopper has saved.
 *
 * Every one of these is a POST, including the listing, because the token that says who this is
 * would otherwise sit in a URL -- in history, in server logs, in a Referer header on the way to
 * somebody else's site -- and it is the key to a person's home address.
 */
export const myAddresses = (slug, token, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/addresses`, { ...opts, send: { token } });

export const saveAddress = (slug, token, address, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/addresses/save`, { ...opts, send: { token, address } });

export const removeAddress = (slug, token, id, opts) =>
  get(`/shop/${encodeURIComponent(slug)}/addresses/remove`, { ...opts, send: { token, id } });

/*
 * The secret the browser earned by proving its number, kept on the device that earned it.
 *
 * Per shop, because a proof given to one shop means nothing at another -- the server checks that
 * too, but a browser has no business holding one shop's key under another's name.
 */
const KEY = (slug) => `scaleezy.proof.${slug}`;
export const heldProof = (slug) => {
  try { return window.localStorage.getItem(KEY(slug)) || null; } catch { return null; }
};
export const holdProof = (slug, token) => {
  try { if (token) window.localStorage.setItem(KEY(slug), token); } catch { /* private window: they type it again */ }
};
export const dropProof = (slug) => {
  try { window.localStorage.removeItem(KEY(slug)); } catch { /* nothing to do */ }
};

/** Money as an Indian shopper reads it: ₹8,500, and ₹8,500.50 only when there are paise. */
export const money = (amount, currency = 'INR') => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(n);
};

/**
 * A chat with the shop about one piece, with the first line already typed.
 *
 * This is how Phase 1 sells: there is no basket and no payment yet, so "Ask on WhatsApp" is the
 * order. Naming the piece and its code means the shopkeeper knows what is being asked about
 * without a second message.
 */
export const askOnWhatsApp = (phone, shopName, product) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const text = product
    ? `Hi ${shopName}, I saw ${product.title} (${product.productCode}) on your shop. Is it available?`
    : `Hi ${shopName}, I saw your shop online.`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
};
