import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getReels, money } from '../api';
import Shot from '../components/Shot';
import { Problem, Say } from '../components/States';

/**
 * shop.scaleezy.com/<shop>/reels -- the link in the shop's Instagram bio (PLAN-reel-links.md).
 *
 * Instagram does not let a caption link be tapped, so a caption says "link in bio, reel 12" and this page lists every
 * reel link the shop has switched on, newest first.
 *
 * 17 Nov 2026, the owner's choice "2. Filmstrips" (PLAN-reel-shop-redesign-mockups.html): each reel is a row that
 * already shows its pieces and prices, swiped sideways. One reel or twenty, the page never looks empty, and a reel that
 * opens with an unphotographed piece is no longer an empty grey box (that was the whole page for a shop with one
 * reel). A piece opens the reel AT that piece. Classes are "bio-" only: the shop's stylesheet is one global sheet.
 */

/** One reel: its name, how many pieces, and the strip. */
function Film({ slug, reel, eager }) {
  const to = `/${slug}/look/${encodeURIComponent(reel.code)}`;
  const strip = useRef(null);
  // With a mouse there is nothing to swipe with, so the strip gets two arrows -- only while there is more that way.
  const [more, setMore] = useState({ back: false, on: false });

  useEffect(() => {
    const el = strip.current;
    if (!el) return undefined;
    const read = () => setMore(was => {
      const back = el.scrollLeft > 4, on = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      return was.back === back && was.on === on ? was : { back, on };
    });
    read();
    el.addEventListener('scroll', read, { passive: true });
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null;
    watch?.observe(el);
    return () => { el.removeEventListener('scroll', read); watch?.disconnect(); };
  }, [reel.pieces.length]);

  const slide = (way) => {
    const el = strip.current;
    if (!el) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: way * Math.max(160, el.clientWidth * 0.8), behavior: calm ? 'auto' : 'smooth' });
  };

  const rest = reel.count - reel.pieces.length;
  return (
    <section className="bio-film" aria-label={reel.title}>
      <div className="bio-filmhead">
        <h2 className="bio-filmtitle">
          <Link to={to}>{reel.title}</Link>
          {reel.count > 0 ? <small>{reel.count} {reel.count === 1 ? 'piece' : 'pieces'}</small> : null}
        </h2>
        <Link className="bio-shop" to={to} aria-label={`Shop the reel: ${reel.title}`}>Shop the reel</Link>
      </div>
      {reel.pieces.length ? (
        <div className="bio-stripwrap">
          <ul className="bio-strip" ref={strip}>
            {reel.pieces.map((p, i) => (
              <li key={p.productCode}>
                <Link className={`bio-piece${p.soldOut ? ' gone' : ''}`} to={`${to}?piece=${encodeURIComponent(p.productCode)}`}>
                  <Shot src={p.photo} alt="" ratio="4 / 5" className="bio-shot" eager={eager && i < 3} sizes="(min-width: 940px) 196px, (min-width: 620px) 156px, 136px">
                    {p.photo ? null : <span className="bio-nophoto">Photo coming soon</span>}
                    {p.soldOut ? <span className="bio-out">Sold out</span> : null}
                  </Shot>
                  <span className="bio-name">{p.title}</span>
                  {p.price != null
                    ? <span className="bio-price">{p.from ? 'From ' : ''}{money(p.price, p.currency)}{p.unit ? ` / ${p.unit}` : ''}</span>
                    : null}
                </Link>
              </li>
            ))}
            {rest > 0 ? (
              <li>
                <Link className="bio-piece bio-rest" to={to} aria-label={`${rest} more in ${reel.title}`}>
                  <span className="bio-restbox"><b>+{rest}</b>more in this reel</span>
                </Link>
              </li>
            ) : null}
          </ul>
          {more.back ? (
            <button type="button" className="bio-arrow back" onClick={() => slide(-1)} aria-label={`Earlier pieces in ${reel.title}`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
            </button>
          ) : null}
          {more.on ? (
            <button type="button" className="bio-arrow on" onClick={() => slide(1)} aria-label={`More pieces in ${reel.title}`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The shape of the page while it is on its way: a title and two strips, so nothing jumps when they land. */
const Waiting = () => (
  <section className="bio" aria-hidden="true">
    <div className="bio-head">
      <div className="bone" style={{ height: 34, width: 230, borderRadius: 6 }} />
      <div className="bone" style={{ height: 13, width: 280, maxWidth: '80%', borderRadius: 4, marginTop: 10 }} />
    </div>
    {[0, 1].map(n => (
      <div key={n} className="bio-film">
        <div className="bio-filmhead"><div className="bone" style={{ height: 22, width: 150, borderRadius: 5 }} /></div>
        <div className="bio-strip">
          {[0, 1, 2, 3].map(i => <div key={i} className="bio-piece"><div className="shot bone bio-shot" style={{ aspectRatio: '4 / 5' }} /></div>)}
        </div>
      </div>
    ))}
  </section>
);

export default function ReelsPage({ slug, shop }) {
  const [state, setState] = useState({ loading: true, error: null, reels: [] });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setState({ loading: true, error: null, reels: [] });
    getReels(slug, { signal: ac.signal })
      .then(d => setState({ loading: false, error: null, reels: d.reels ?? [] }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, reels: [] }); });
    return () => ac.abort();
  }, [slug, nonce]);

  useEffect(() => { document.title = `Shop our reels · ${shop.name}`; }, [shop.name]);

  if (state.loading) return <Waiting />;
  if (state.error) return <Problem error={state.error} onRetry={() => setNonce(n => n + 1)} shopName={shop.name} />;
  if (!state.reels.length) {
    return <Say title="No reels to shop yet" action={<Link className="go quiet" to={`/${slug}`}>See the whole shop</Link>}>When we post a reel, its pieces appear here.</Say>;
  }

  const buying = shop?.buying?.open === true;
  return (
    <section className="bio">
      <header className="bio-head">
        <h1 className="bio-title">Shop our reels</h1>
        <p className="bio-sub">{buying ? 'Every piece from our Instagram reels, ready to buy.' : 'Every piece from our Instagram reels. Message us to order.'}</p>
      </header>
      {/* A list from before the pieces were sent (an old copy of this page still open) has no strip: its name and link still work. */}
      {state.reels.map((r, n) => <Film key={r.code} slug={slug} reel={{ ...r, pieces: r.pieces ?? [], count: r.count ?? r.pieces?.length ?? 0 }} eager={n === 0} />)}
      <div className="bio-more"><Link className="go quiet" to={`/${slug}`}>See the whole shop</Link></div>
    </section>
  );
}
