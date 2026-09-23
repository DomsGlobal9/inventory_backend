import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * The banners across the top of a shop, swiped.
 *
 * Swiping rather than arrows because that is what a thumb does, and the browser's own scroll
 * snapping does it better than anything written by hand -- it is smooth on a cheap Android, it
 * respects a flick, and it costs nothing.
 *
 * IT MOVES BY ITSELF, AND IT STOPS WHEN SOMEBODY IS LOOKING. A shop putting three banners up wants
 * all three seen, so it advances every five seconds. But moving the page under somebody who is
 * reading it is rude, so it pauses while the pointer is over it, while a finger is on it, while
 * the tab is in the background, and entirely for anyone who has asked their device for less
 * motion. It resumes when they move away -- the first version stopped for good at the first touch,
 * which meant one stray tap left the other banners unseen for the rest of the visit.
 */

/*
 * How long each banner is held before the next one.
 *
 * Long enough to read a heading and decide, short enough that somebody who glances at the top of a
 * shop sees more than one. Five seconds felt like a page that had stopped; three and a half keeps
 * moving without hurrying anybody. Hovering, touching or a background tab still stops it dead.
 */
const EVERY_MS = 3500;

export default function Banners({ slug, banners }) {
  const nav = useNavigate();
  const strip = useRef(null);
  const [at, setAt] = useState(0);
  /*
   * Which banner the strip is MEANT to be showing.
   *
   * Kept apart from where it actually is, because a smooth scroll is not guaranteed to happen.
   * Working out the next one from `scrollLeft` looked right and was not: anywhere the smooth
   * scroll is ignored -- and it is silently ignored in more places than one would think -- the
   * position never changed, so the next tick computed the same index again and the banners simply
   * never moved. The intent advances; the strip is then made to agree with it.
   */
  const want = useRef(0);
  /* Anything that should hold the banners still, counted rather than flagged: a finger down and a
     pointer over are two separate reasons, and either one ending must not cancel the other. */
  const [holds, setHolds] = useState(0);

  const hold = useCallback(() => setHolds(n => n + 1), []);
  const release = useCallback(() => setHolds(n => Math.max(0, n - 1)), []);

  const count = banners?.length ?? 0;

  useEffect(() => {
    if (count < 2 || holds > 0) return undefined;
    // Somebody who asked their device for less motion gets none of this; they can still swipe.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return undefined;

    const tick = () => {
      const el = strip.current;
      // A page in a background tab should not churn; it picks up again when they come back.
      if (!el || document.hidden) return;
      want.current = (want.current + 1) % count;
      const left = want.current * el.clientWidth;
      el.scrollTo({ left, behavior: 'smooth' });
      // If the smooth scroll did not happen, put it there anyway. A banner that does not move is
      // worse than one that moves without gliding.
      window.setTimeout(() => {
        if (el.isConnected && Math.abs(el.scrollLeft - left) > 4) el.scrollLeft = left;
      }, 500);
    };

    const timer = setInterval(tick, EVERY_MS);
    // Coming back to the tab should not wait out a whole interval that ran while it was hidden.
    const wake = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', wake); };
  }, [count, holds]);

  if (!count) return null;

  const go = (b) => {
    if (!b.link) return;
    if (b.link.kind === 'SEARCH') nav(`/${slug}?q=${encodeURIComponent(b.link.value)}`);
    else if (b.link.kind === 'CATEGORY') nav(`/${slug}?category=${encodeURIComponent(b.link.value)}`);
    else if (b.link.kind === 'PRODUCT') nav(`/${slug}/p/${encodeURIComponent(b.link.value)}`);
  };

  const show = (i) => {
    const el = strip.current;
    if (!el) return;
    want.current = i;
    const left = i * el.clientWidth;
    el.scrollTo({ left, behavior: 'smooth' });
    window.setTimeout(() => {
      if (el.isConnected && Math.abs(el.scrollLeft - left) > 4) el.scrollLeft = left;
    }, 500);
  };

  return (
    <div
      className="banners"
      onMouseEnter={hold}
      onMouseLeave={release}
      onFocusCapture={hold}
      onBlurCapture={release}
    >
      <div
        className="strip"
        ref={strip}
        onPointerDown={hold}
        onPointerUp={release}
        onPointerCancel={release}
        onScroll={e => {
          const i = Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth);
          setAt(i);
          // A shopper who swipes decides where we are; the next tick carries on from there.
          want.current = i;
        }}
      >
        {banners.map((b, i) => {
          const tappable = Boolean(b.link);
          const Inner = (
            <>
              <img
                src={b.imageUrl}
                alt={b.heading || ''}
                /* The first one is what a shopper sees immediately; the rest can wait. */
                loading={i === 0 ? 'eager' : 'lazy'}
                fetchPriority={i === 0 ? 'high' : 'auto'}
                decoding="async"
              />
              {(b.heading || b.subtext) && (
                <div className="over">
                  {b.heading ? <h2>{b.heading}</h2> : null}
                  {b.subtext ? <p>{b.subtext}</p> : null}
                  {tappable ? <span className="cta">Shop now</span> : null}
                </div>
              )}
            </>
          );
          return tappable ? (
            <button key={i} className="slide" type="button" onClick={() => go(b)}
              aria-label={b.heading || 'Open this'}>{Inner}</button>
          ) : (
            <div key={i} className="slide">{Inner}</div>
          );
        })}
      </div>

      {count > 1 && (
        <>
          {/* Tappable, not decoration: on a mouse there is no thumb to swipe with. */}
          <div className="pips">
            {banners.map((_, i) => (
              <button key={i} type="button" data-on={i === at}
                aria-label={`Banner ${i + 1} of ${count}`} onClick={() => show(i)} />
            ))}
          </div>

          <button type="button" className="arrow back" aria-label="Previous banner"
            onClick={() => show((at - 1 + count) % count)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m14.5 5-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="arrow on" aria-label="Next banner"
            onClick={() => show((at + 1) % count)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m9.5 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
