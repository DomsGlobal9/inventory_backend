import { useEffect, useState } from 'react';

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

export const bagCount = (slug) => getBag(slug).reduce((n, l) => n + l.quantity, 0);

/** Add a piece, or one more of a piece already in the bag. Ten of anything is the most. */
export function addToBag(slug, variantCode, quantity = 1, extra = {}) {
  const lines = getBag(slug);
  const found = lines.find(l => l.variantCode === variantCode);
  if (found) found.quantity = Math.min(found.quantity + quantity, 10);
  else lines.push({ variantCode, quantity: Math.min(quantity, 10), ...extra });
  write(slug, tidy(lines));
  return lines;
}

export function setQuantity(slug, variantCode, quantity) {
  const lines = getBag(slug)
    .map(l => (l.variantCode === variantCode ? { ...l, quantity: Math.max(0, Math.min(quantity, 10)) } : l));
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
