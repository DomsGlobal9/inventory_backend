/**
 * The heart that flies to the Wishlist (13 Nov, owner: "see how Myntra works in the mobile app").
 *
 * Saving a piece used to change a number in the top bar that a shopper on a phone easily misses. Now a small
 * filled heart pops out of the button they tapped and flies, on a curve, into the Wishlist icon; the icon
 * jolts and its count goes up the moment it lands -- so the eye is carried to where the piece went.
 *
 * Built with the Web Animations API on two nested elements: the outer one moves sideways at an even pace, the
 * inner one rises with an easing that starts fast and slows, and together they draw an arc. Only transform and
 * opacity move, so it stays on the compositor on a mid-range Android. Nothing flies for anyone who asked their
 * device for less motion, or when the Wishlist icon is not on screen: the count simply changes.
 */
const HEART = 'M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2Z';
export const FLIGHT_MS = 640;
const POP_MS = 160;

let inAir = 0;
const LANDED = 'shop:heart-landed';

/** How many hearts are on their way right now (the top bar holds its count until they land). */
export const heartsInAir = () => inAir;

/** Call `fn` each time a heart lands. Returns the way to stop. */
export function onHeartLanded(fn) {
  window.addEventListener(LANDED, fn);
  return () => window.removeEventListener(LANDED, fn);
}

const calm = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The Wishlist icon in the top bar, if it is on screen. */
function target() {
  const el = document.querySelector('[data-wish-target]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  return visible ? r : null;
}

/**
 * Fly a heart from `fromEl` to the Wishlist icon. Resolves when it has landed (at once when nothing flies).
 */
export function flyHeart(fromEl) {
  const to = target();
  const from = fromEl?.getBoundingClientRect?.();
  if (!to || !from || calm() || typeof document.body.animate !== 'function') return Promise.resolve(false);

  const size = 22;
  const sx = from.left + from.width / 2 - size / 2;
  const sy = from.top + from.height / 2 - size / 2;
  const dx = to.left + to.width / 2 - size / 2 - sx;
  const dy = to.top + to.height / 2 - size / 2 - sy;

  const outer = document.createElement('div');
  outer.className = 'flyheart';
  outer.setAttribute('aria-hidden', 'true');
  outer.style.cssText = `left:${sx}px;top:${sy}px;width:${size}px;height:${size}px`;
  const inner = document.createElement('div');
  inner.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="${HEART}" fill="currentColor"/></svg>`;
  outer.appendChild(inner);
  document.body.appendChild(outer);
  inAir++;

  // Pop out of the button first, then travel: sideways evenly, upward fast-then-slow (the arc), shrinking in.
  const pop = POP_MS / (POP_MS + FLIGHT_MS);
  const across = outer.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(0)', offset: pop }, { transform: `translateX(${dx}px)` }],
    { duration: POP_MS + FLIGHT_MS, easing: 'linear', fill: 'forwards' }
  );
  inner.animate(
    [
      { transform: 'translateY(0) scale(0.2)', opacity: 0 },
      { transform: 'translateY(-10px) scale(1.5)', opacity: 1, offset: pop * 0.7 },
      { transform: 'translateY(-6px) scale(1.3)', opacity: 1, offset: pop, easing: 'cubic-bezier(.2,.75,.35,1)' },
      { transform: `translateY(${dy}px) scale(0.45)`, opacity: 0.9 }
    ],
    { duration: POP_MS + FLIGHT_MS, fill: 'forwards' }
  );

  return new Promise(resolve => {
    const land = () => {
      outer.remove();
      inAir = Math.max(0, inAir - 1);
      window.dispatchEvent(new Event(LANDED));
      resolve(true);
    };
    across.onfinish = land;
    across.oncancel = land;
  });
}
