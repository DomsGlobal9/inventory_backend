import React from 'react';

/**
 * The little animations: an empty bag that sways, a tick that draws itself, a search that sweeps.
 *
 * WHY THESE ARE DRAWN HERE RATHER THAN LOADED AS LOTTIE FILES. Two reasons, and both are about
 * this shop's customers rather than about taste.
 *
 * The first is the page's own rules. A shop page is served with `default-src 'self'` and
 * `connect-src 'self'`, so a Lottie fetched from lottiefiles.com -- or anywhere else -- is blocked
 * before it starts. Bundling the player instead costs about 70 KB gzipped on a page that is
 * currently 98 KB in total, and nearly every shopper arrives on a mid-range Android over an Indian
 * mobile network, having tapped a link inside WhatsApp. Doubling the page so an empty bag can
 * wobble is not a trade worth making for them.
 *
 * The second is that these are small enough to draw. They are a few hundred bytes of SVG each,
 * they animate in CSS on the compositor, and they cost nothing to start. Anyone who has asked
 * their device for less motion gets the same drawing, still.
 *
 * If a real Lottie is ever wanted, the file would have to be bundled rather than fetched, and
 * these are the four places to put one.
 */

/** An empty bag, swaying as though just put down. */
export const EmptyBag = () => (
  <svg className="motion sway" width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden="true">
    <path d="M26 32h44l-4 44H30L26 32Z" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
    <path className="handle" d="M38 32a10 10 0 0 1 20 0" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    <circle className="spark" cx="48" cy="54" r="3" fill="currentColor" opacity=".35" />
  </svg>
);

/** A tick that draws itself once, inside a ring that settles. */
export const Landed = () => (
  <svg className="motion" width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <circle className="ring" cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="2.5" opacity=".28" />
    <path className="draw" d="m19 33 9 9 17-19" stroke="currentColor" strokeWidth="4"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A magnifier sweeping, for a search that found nothing. */
export const NoMatch = () => (
  <svg className="motion sweep" width="88" height="88" viewBox="0 0 88 88" fill="none" aria-hidden="true">
    <circle cx="38" cy="38" r="20" stroke="currentColor" strokeWidth="2.5" />
    <path d="m53 53 14 14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    <path className="glint" d="M30 32a10 10 0 0 1 8-6" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" opacity=".5" />
  </svg>
);

/** A tick small enough to live inside a button, drawn once. */
export const Ticked = () => (
  <svg className="motion tick" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path className="draw" d="m3 8.5 3.2 3.2L13 4.6" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** How close a bag is to the shop's free-delivery figure. */
export const Toward = ({ done }) => (
  <span className="toward" aria-hidden="true">
    <i style={{ width: `${Math.max(4, Math.min(100, Math.round(done * 100)))}%` }} />
  </span>
);

/** Three dots, for the seconds a try-on takes. */
export const Working = () => (
  <span className="motion dots" aria-hidden="true"><i /><i /><i /></span>
);
