import { useEffect, useState } from 'react';
import { lineMax, itemsIn } from './units';

/**
 * The bag, kept in the shopper's own browser.
 *
 * There is no account here and nothing to attach a basket to, so it lives in localStorage under
 * the shop's own address -- two shops open in two tabs have two bags, and neither can see the
 * other. It holds only what a piece IS (its variant code) and how many; every price, every
 * discount and every "is this still in stock" comes from the shop when the bag is priced. A price
 * remembered in a browser is a price that goes stale, and stale prices at a checkout are arguments.
 *
 * Everything here survives a browser that refuses to store anything -- a private window, a phone
 * with site data blocked. The bag then lasts as long as the page does, which is worse than
 * remembering it and far better than a shop that will not work at all.
 */

const KEY = (slug) => `scaleezy.bag.${slug}`;

/** A bag lost to a browser that will not store is still a bag for as long as the tab is open. */
const memory = new Map();

const read = (slug) => {
  try {
    const raw = window.localStorage.getItem(KEY(slug));
    if (raw) return JSON.parse(raw);
  } catch { /* private window, blocked storage: fall through */ }
  return memory.get(slug) ?? [];
};

const write = (slug, lines) => {
  memory.set(slug, lines);
  try { window.localStorage.setItem(KEY(slug), JSON.stringify(lines)); }
  catch { /* nothing to do: the bag lives in memory for this tab */ }
  // Told to every part of the page at once, so the count in the bar and the bag page can never
  // disagree about what is in it.
  window.dispatchEvent(new CustomEvent('bag', { detail: { slug } }));
};

const tidy = (lines) => lines.filter(l => l && l.variantCode && l.quantity > 0).slice(0, 20);

export const getBag = (slug) => tidy(read(slug));

// A length of cloth is one item in the count, never its centimetres (PLAN-fabrics.md).
export const bagCount = (slug) => getBag(slug).reduce((n, l) => n + itemsIn(l), 0);

/**
 * Add a piece, or one more of a piece already in the bag. Ten of anything is the most; cloth by the metre comes as a
 * length in centimetres (extra.soldBy = 'METRE'), up to 100 m on one line.
 */
export function addToBag(slug, variantCode, quantity = 1, extra = {}) {
  const lines = getBag(slug);
  const found = lines.find(l => l.variantCode === variantCode);
  // Never more than the shop can sell (extra.max: one store's stock, from the product page), nor the line's own limit.
  const { max: left, ...rest } = extra;
  const max = Math.min(lineMax(rest.soldBy ?? found?.soldBy), Number.isFinite(left) ? left : Infinity);
  if (max <= 0) return lines;
  if (found) found.quantity = Math.min(found.quantity + quantity, max);
  else lines.push({ variantCode, quantity: Math.min(quantity, max), ...rest });
  write(slug, tidy(lines));
  return lines;
}

export function setQuantity(slug, variantCode, quantity) {
  const lines = getBag(slug)
    .map(l => (l.variantCode === variantCode ? { ...l, quantity: Math.max(0, Math.min(quantity, lineMax(l.soldBy))) } : l));
  write(slug, tidy(lines));
}

export function removeFromBag(slug, variantCode) {
  write(slug, getBag(slug).filter(l => l.variantCode !== variantCode));
}

export function emptyBag(slug) {
  write(slug, []);
}

/**
 * What the browser sent when it placed an order.
 *
 * Made once per bag and kept until that bag is ordered, so a double tap, a retry after a timeout
 * and two requests racing all become the one order rather than three.
 */
export function placementKey(slug) {
  const k = `${KEY(slug)}.placing`;
  try {
    const held = window.localStorage.getItem(k);
    if (held) return held;
  } catch { /* fall through */ }
  const made = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  try { window.localStorage.setItem(k, made); } catch { /* fine */ }
  memory.set(`${slug}.placing`, made);
  return memory.get(`${slug}.placing`) ?? made;
}

export function clearPlacementKey(slug) {
  try { window.localStorage.removeItem(`${KEY(slug)}.placing`); } catch { /* fine */ }
  memory.delete(`${slug}.placing`);
}

/** The bag, as a component sees it: it re-renders whenever the bag changes anywhere on the page. */
export function useBag(slug) {
  const [lines, setLines] = useState(() => getBag(slug));
  useEffect(() => {
    const refresh = () => setLines(getBag(slug));
    refresh();
    window.addEventListener('bag', refresh);
    // Another tab of the same shop: two tabs open should not disagree about the bag.
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('bag', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [slug]);
  return lines;
}

/*
 * The reel link (or a picks link from the shop's CRM) the shopper last opened, kept 7 days in this browser.
 * Sent with an order so the shop knows which link it came from (credit for whoever sent it; never a price).
 */
const LOOK_KEY = (slug) => `se-shop-look:${slug}`;
const LOOK_DAYS = 7;
export function rememberLook(slug, code) {
  try { window.localStorage.setItem(LOOK_KEY(slug), JSON.stringify({ code, at: Date.now() })); } catch { /* private window: no credit, nothing else */ }
}
export function lookCodeFor(slug) {
  try {
    const v = JSON.parse(window.localStorage.getItem(LOOK_KEY(slug)) || 'null');
    return v && typeof v.code === 'string' && Date.now() - Number(v.at) < LOOK_DAYS * 86_400_000 ? v.code : null;
  } catch { return null; }
}

/*
 * A UPI order's bag, kept by its order token (26 Nov 2026). The QR page's "Pay another way" lets the order go and puts
 * these same pieces back, so the shopper returns to checkout with nothing to choose again; the bag and checkout pages
 * use the same record to say "a UPI order is waiting" when the shopper left the QR page by the back button.
 */
const KEPT_PREFIX = (slug) => `scaleezy.upibag.${slug}.`;
const KEPT = (slug, token) => `${KEPT_PREFIX(slug)}${token}`;
const readKept = (slug, token) => {
  let lines = memory.get(KEPT(slug, token)) ?? null;
  try { const raw = window.localStorage.getItem(KEPT(slug, token)); if (raw) lines = JSON.parse(raw); } catch { /* memory only */ }
  return Array.isArray(lines) ? lines : null;
};
export function keepBagFor(slug, token) {
  const lines = getBag(slug);
  memory.set(KEPT(slug, token), lines);
  try { window.localStorage.setItem(KEPT(slug, token), JSON.stringify(lines)); } catch { /* memory only */ }
}
export const hasKeptBag = (slug, token) => !!readKept(slug, token)?.length;
/** The UPI orders this browser left unfinished, newest last (their tokens). */
export function keptBagTokens(slug) {
  const out = new Set([...memory.keys()].filter(k => typeof k === 'string' && k.startsWith(KEPT_PREFIX(slug))).map(k => k.slice(KEPT_PREFIX(slug).length)));
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(KEPT_PREFIX(slug))) out.add(k.slice(KEPT_PREFIX(slug).length));
    }
  } catch { /* memory only */ }
  return [...out];
}
export function forgetKeptBag(slug, token) {
  memory.delete(KEPT(slug, token));
  try { window.localStorage.removeItem(KEPT(slug, token)); } catch { /* nothing */ }
}
export function putKeptBagBack(slug, token) {
  const lines = readKept(slug, token);
  forgetKeptBag(slug, token);
  if (!lines?.length) return false;
  // Added to whatever is in the bag now (they may have browsed on), never doubled for the same piece.
  const now = getBag(slug);
  for (const l of lines) if (!now.some(n => n.variantCode === l.variantCode)) now.push(l);
  write(slug, tidy(now));
  return true;
}
