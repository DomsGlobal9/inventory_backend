import React, { useEffect, useRef, useState } from 'react';

/**
 * A Lottie animation for an empty page (30 Oct, owner: the empty-bag animation from lottie.host).
 *
 * Loaded only when it is shown. The player (lottie_light: SVG only, ~45 KB gzipped, and no eval --
 * the shop's CSP has no 'unsafe-eval', and the full build would be refused) and the animation itself
 * come in their own chunk, so every page that is not empty costs exactly what it did. The file is
 * served from the shop itself: `default-src 'self'` would block one fetched from lottie.host.
 *
 * Until it is ready -- or if it never is (offline, an old browser) -- the hand-drawn picture it
 * replaces stands in its place, so the page never has a hole in it.
 *
 * Still for anyone who has asked their device for less motion: the last frame, not playing.
 */
export default function LottieArt({ load, fallback = null, size = 180 }) {
  const box = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let anim = null;
    let gone = false;
    const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    Promise.all([import('lottie-web/build/player/lottie_light'), load()])
      .then(([player, data]) => {
        if (gone || !box.current) return;
        const lottie = player.default ?? player;
        anim = lottie.loadAnimation({
          container: box.current,
          renderer: 'svg',
          loop: !still,
          autoplay: !still,
          // A copy: the player writes into the data it is given, and a second visit would get the
          // already-rewritten one.
          animationData: structuredClone(data.default ?? data),
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet' }
        });
        anim.addEventListener('DOMLoaded', () => {
          if (still) anim.goToAndStop(anim.totalFrames - 1, true);
          if (!gone) setReady(true);
        });
      })
      .catch(() => { /* the drawing stays; nothing to tell a shopper */ });

    return () => { gone = true; anim?.destroy(); };
  }, [load]);

  return (
    <div className="lottieart" style={{ width: size, height: size }} aria-hidden="true">
      {!ready ? <div className="lottiewait">{fallback}</div> : null}
      <div ref={box} className="lottiebox" data-ready={ready} />
    </div>
  );
}
