import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * The banners across the top of a shop, swiped.
 *
 * Swiping rather than arrows because that is what a thumb does, and the browser's own scroll
 * snapping does it better than anything written by hand -- it is smooth on a cheap Android, it
 * respects a flick, and it costs nothing.
 *
 * It advances by itself every six seconds, because a shop putting three banners up wants all three
 * seen. It stops the moment a shopper touches it, and never starts again: once somebody is looking
 * deliberately, moving the page under them is rude.
 */
export default function Banners({ slug, banners }) {
  const nav = useNavigate();
  const strip = useRef(null);
  const [at, setAt] = useState(0);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched || banners.length < 2) return;
    const t = setInterval(() => {
      const el = strip.current;
      if (!el) return;
      // Paused when the shop is not on screen: a page in a background tab should not churn.
      if (document.hidden) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % banners.length;
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    }, 6000);
    return () => clearInterval(t);
  }, [touched, banners.length]);

  if (!banners?.length) return null;

  const go = (b) => {
    if (!b.link) return;
    if (b.link.kind === 'SEARCH') nav(`/${slug}?q=${encodeURIComponent(b.link.value)}`);
    else if (b.link.kind === 'CATEGORY') nav(`/${slug}?category=${encodeURIComponent(b.link.value)}`);
    else if (b.link.kind === 'PRODUCT') nav(`/${slug}/p/${encodeURIComponent(b.link.value)}`);
  };

  return (
    <div className="banners">
      <div
        className="strip"
        ref={strip}
        onPointerDown={() => setTouched(true)}
        onScroll={e => setAt(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
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

      {banners.length > 1 && (
        <div className="pips" aria-hidden="true">
          {banners.map((_, i) => <i key={i} data-on={i === at} />)}
        </div>
      )}
    </div>
  );
}
