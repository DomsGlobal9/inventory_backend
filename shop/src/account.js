import { heldProof, holdProof, dropProof, startAccount, getAccount } from './api';

/**
 * Who is signed in to this shop on this phone (29 Oct, "Sign in with WhatsApp").
 *
 * The secret itself is the shop's proof key (api.js heldProof): a sign-in replaces the 1-hour pass a
 * code check gives, so everything that already reads the proof -- addresses, try-ons, hearts -- works
 * signed in. Kept here beside it: the number and name, for the top bar and the checkout to read
 * without asking the shop, and the codes of hearted pieces, so a heart shows filled at once. The shop
 * decides everything again on every request; none of this is trusted there.
 */
const KEY = (slug) => `scaleezy.account.${slug}`;
const EVENT = 'scaleezy:account';

const read = (slug) => { try { return JSON.parse(window.localStorage.getItem(KEY(slug)) ?? 'null'); } catch { return null; } };
const write = (slug, v) => {
  try { v ? window.localStorage.setItem(KEY(slug), JSON.stringify(v)) : window.localStorage.removeItem(KEY(slug)); } catch { /* a private window */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { slug } }));
};

/** { phone, name, hearts: [productCode] } or null. */
export const signedIn = (slug) => {
  const v = read(slug);
  return v && String(heldProof(slug) ?? '').startsWith('ss_') ? v : null;
};

export const onAccountChange = (fn) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/** Remember what the shop said about this account (after a sign-in, or reading the account page). */
export const remember = (slug, me) => {
  if (!me?.signedIn) { write(slug, null); return; }
  write(slug, { phone: me.phone, name: me.name ?? null, hearts: (me.hearts ?? []).map(h => h.productCode) });
};

export const forget = (slug) => { dropProof(slug); write(slug, null); };

/** A heart put on or taken off here, so the next page shows it without asking. */
export const noteHeart = (slug, productCode, liked) => {
  const v = read(slug);
  if (!v) return;
  const hearts = new Set(v.hearts ?? []);
  if (liked) hearts.add(productCode); else hearts.delete(productCode);
  write(slug, { ...v, hearts: [...hearts] });
};

/**
 * Turn the pass this browser holds into a sign-in, if it holds one that is not already a sign-in --
 * the guest who just proved their number at the checkout, landing on their order. Quiet: any failure
 * leaves them as they were. Returns the account, or null.
 */
export async function becomeSignedIn(slug) {
  const token = heldProof(slug);
  if (!token) return null;
  try {
    const started = token.startsWith('ss_') ? { token } : await startAccount(slug, token);
    holdProof(slug, started.token);
    const me = await getAccount(slug, started.token);
    if (!me?.signedIn) { forget(slug); return null; }
    remember(slug, me);
    return me;
  } catch {
    return null;
  }
}

/** The last 10 digits, so "+91 98480 11122", "09848011122" and "9848011122" are one number. */
export const sameNumber = (a, b) => {
  const d = (x) => String(x ?? '').replace(/\D/g, '').slice(-10);
  return d(a).length === 10 && d(a) === d(b);
};
