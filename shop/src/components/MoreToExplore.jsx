import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getProducts, money } from '../api';
import AlsoIn from './AlsoIn';
import AlsoBought from './AlsoBought';
import Tile from './Tile';
import Shot from './Shot';
import { sized, widths, orWhole, BANNER } from '../photo';

/**
 * Everything under a product, so the page carries on being a shop.
 *
 * It used to end at one row of "More sarees" and the footer: a shopper who did not want THIS saree
 * had nowhere to go but Back. The big shops all do the same thing here, in roughly this order, and
 * for the same reason -- each section is a different answer to "not this one, then what?":
 *
 *   1. the shop's own offer, the banner it already made for its home page
 *   2. more of the same kind (AlsoIn, as before)
 *   (a "Shop by fabric and price" section stood here; removed, owner, 29 Oct)
 *   4. the ones they were already looking at
 *   5. and then simply more of the shop, loading as they scroll
 *
 * Nothing here needs the shop to set anything up. Banners are already
 * in the shop's own data; "recently viewed" lives on the shopper's phone and nowhere else.
 */

/** Where a banner goes, as a path -- the same three kinds the home page's banners understand. */
export function bannerTo(slug, b) {
  if (!b?.link?.value) return null;
  const v = encodeURIComponent(b.link.value);
  if (b.link.kind === 'SEARCH') return `/${slug}?q=${v}`;
  if (b.link.kind === 'CATEGORY') return `/${slug}?category=${v}`;
  if (b.link.kind === 'PRODUCT') return `/${slug}/p/${v}`;
  return null;
}

/* A steady pick from the product code, so each piece shows "its" banner rather than the same one on
   every page, and the same one again when the shopper comes back. */
const pick = (code, n) => {
  let h = 0;
  for (const ch of String(code)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return n ? h % n : 0;
};

/**
 * Whether a section is within about a screen of being seen.
 *
 * What sits far down a product page is not fetched until somebody scrolls towards it: most
 * shoppers look at the piece and decide, and the phone should spend its first seconds on THAT
 * photograph, not on fabric thumbnails and a grid three screens below. The margin is generous so
 * that by the time a thumb gets there the answer has usually already arrived.
 */
function useNear(margin = '700px') {
  const ref = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return undefined;
    const node = ref.current;
    if (!node || typeof IntersectionObserver !== 'function') { setNear(true); return undefined; }
    const eye = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setNear(true); eye.disconnect(); }
    }, { rootMargin: `${margin} 0px` });
    eye.observe(node);
    return () => eye.disconnect();
  }, [near, margin]);
  return [ref, near];
}

/** The outline of a section, breathing, where one is on its way. */
const Waiting = ({ tall = 180 }) => (
  <div aria-hidden="true">
    <div className="head"><span className="bone line" /></div>
    <div className="bone" style={{ height: tall }} />
  </div>
);

function Promo({ slug, banner, inline = false }) {
  /* Grey and breathing until the picture is in, so a slow banner is a shape, not a gap. */
  const [ready, setReady] = useState(false);
  if (!banner?.imageUrl) return null;
  const to = bannerTo(slug, banner);
  const inner = (
    <>
      <img src={sized(banner.imageUrl, 1080)} srcSet={widths(banner.imageUrl, BANNER, 85)} sizes="(min-width: 1200px) 1152px, 100vw" onError={orWhole(banner.imageUrl)} alt={banner.heading || ''} loading="lazy" decoding="async"
        onLoad={() => setReady(true)} onError={() => setReady(true)} />
      {banner.heading || banner.subtext ? (
        <span className="over">
          {banner.heading ? <strong>{banner.heading}</strong> : null}
          {banner.subtext ? <span>{banner.subtext}</span> : null}
          {to ? <em>Shop now</em> : null}
        </span>
      ) : null}
    </>
  );
  const cls = `promo${inline ? ' inline' : ''}${ready ? '' : ' waiting'}`;
  return to ? <Link className={cls} to={to}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

/* ── 4. Recently viewed, on this phone only ───────────────────────────────────────────── */

const SEEN_MAX = 12;
const seenKey = (slug) => `seen:${slug}`;

function readSeen(slug) {
  try {
    const v = JSON.parse(localStorage.getItem(seenKey(slug)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/** Put this piece at the front of the list. Storage can be off (private mode); then it is skipped. */
function rememberSeen(slug, p) {
  if (!p?.productCode) return;
  const photo = p.images?.find(i => i.isPrimary) ?? p.images?.[0] ?? null;
  const prices = (p.variants ?? []).map(v => Number(v.price)).filter(Number.isFinite);
  const entry = {
    code: p.productCode, title: p.title, photo: photo?.url ?? null,
    price: prices.length ? Math.min(...prices) : null, currency: p.variants?.[0]?.currency ?? 'INR'
  };
  try {
    const next = [entry, ...readSeen(slug).filter(e => e.code !== entry.code)].slice(0, SEEN_MAX);
    localStorage.setItem(seenKey(slug), JSON.stringify(next));
  } catch { /* storage off: nothing to remember with, nothing broken */ }
}

function Recent({ slug, product }) {
  /* Read BEFORE this piece is remembered, then without it: "recently viewed" that opens with the
     page you are on is a mirror, not a memory. */
  const [seen, setSeen] = useState([]);
  useEffect(() => {
    setSeen(readSeen(slug).filter(e => e.code !== product.productCode));
    rememberSeen(slug, product);
  }, [slug, product]);

  if (seen.length === 0) return null;
  return (
    <section className="alsoin recent">
      <div className="head"><h2>Recently viewed</h2></div>
      <div className="reel">
        {seen.map(e => (
          <Link key={e.code} className="small mini" to={`/${slug}/p/${encodeURIComponent(e.code)}`}>
            <Shot src={e.photo} alt={e.title} />
            <h3>{e.title}</h3>
            {e.price != null ? <p className="now">{money(e.price, e.currency)}</p> : null}
          </Link>
        ))}
      </div>
    </section>
  );
}

/* ── 5. You may also like: the shop, carrying on ─────────────────────────────────────── */

const PAGE = 12;
/* After this many pages it stops loading on its own and offers a button, so the footer -- the
   shop's phone number, its returns policy -- can still be reached by somebody who looks for it. */
const AUTO_PAGES = 3;

function Endless({ slug, product, skip, banner }) {
  const [shown, setShown] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  /* The last page that actually arrived. */
  const [landed, setLanded] = useState(0);
  const edge = useRef(null);
  const [spot, near] = useNear();
  /*
   * A page that failed to arrive is asked for again, twice, a little later each time -- a phone
   * on a train loses a request far more often than a shop's server fails. Only after that is the
   * shopper shown a button. The first version gave up on the first error and never loaded another
   * page, silently: a grid that simply stopped.
   */
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const tries = useRef(0);
  /*
   * Busy is WORKED OUT, not kept. As a separate flag it was set inside the fetch's own effect, one
   * render late: in the render where the page became 2, every other effect still read busy=false and
   * asked for page 3 -- which cancelled page 2 while it was in the air. "The page asked for is newer
   * than the page that arrived" is true from the very render the page number moves.
   */
  const busy = !failed && landed < page;

  const hidden = useMemo(() => new Set([product.productCode, ...skip]), [product.productCode, skip]);

  useEffect(() => { setShown([]); setPage(1); setLanded(0); setFailed(false); tries.current = 0; }, [slug, product.productCode]);

  useEffect(() => {
    if (!near) return undefined;
    const ac = new AbortController();
    let later = null;
    getProducts(slug, { sort: 'NEW', page, limit: PAGE }, { signal: ac.signal })
      .then(data => {
        tries.current = 0;
        setFailed(false);
        setShown(was => {
          const have = new Set(was.map(p => p.productCode));
          return [...was, ...(data.products ?? []).filter(p => !have.has(p.productCode))];
        });
        setHasMore(Boolean(data.hasMore));
        setLanded(page);
      })
      .catch(e => {
        if (e?.name === 'AbortError') return;
        if (tries.current < 2) {
          tries.current += 1;
          later = setTimeout(() => setNonce(n => n + 1), 1500 * tries.current);
        } else {
          setFailed(true);
        }
      });
    return () => { ac.abort(); if (later) clearTimeout(later); };
  }, [slug, page, near, nonce]);

  const again = () => { tries.current = 0; setFailed(false); setNonce(n => n + 1); };

  /*
   * The page AFTER this one -- never simply one more than whatever it is by now.
   *
   * Three things can ask for the next page (the edge coming into view, a page landing with the edge
   * already in sight, a page that turned out to hold nothing new), and two of them can ask in the
   * same instant. With n + 1 each, they went 2 -> 4: page 3 was never fetched, a dozen pieces never
   * appeared, and the cancelled request for page 2 looked like a failure. Naming the page they are
   * moving ON FROM makes a second ask the same ask.
   */
  const next = useCallback((from) => setPage(n => (n === from ? n + 1 : n)), []);

  const more = useCallback(() => {
    if (!busy && !failed && hasMore) next(page);
  }, [busy, failed, hasMore, next, page]);

  useEffect(() => {
    const node = edge.current;
    if (!node || page >= AUTO_PAGES || typeof IntersectionObserver !== 'function') return undefined;
    const eye = new IntersectionObserver(([e]) => { if (e.isIntersecting) more(); }, { rootMargin: '500px 0px' });
    eye.observe(node);
    return () => eye.disconnect();
  }, [more, page]);

  /*
   * ...and asked again the moment a page lands. The observer only speaks when the edge CROSSES into
   * view; if it crossed while the previous page was still arriving, `more` ignored it (busy) and
   * nothing crossed again -- so on a tall screen the grid stopped after one page with its edge in
   * plain sight. Seen on Swathy Reddy's 36 sarees at 1440px.
   */
  useEffect(() => {
    if (busy || failed || !hasMore || page >= AUTO_PAGES) return;
    const node = edge.current;
    if (node && node.getBoundingClientRect().top < window.innerHeight + 500) next(page);
  }, [busy, failed, hasMore, page, next]);

  const rows = shown.filter(p => !hidden.has(p.productCode));
  /* A small shop whose every piece is already in the row above has nothing new to say here. Keep
     going while another page might still hold something; say nothing once it cannot. */
  useEffect(() => {
    if (!busy && !failed && hasMore && rows.length === 0 && page < AUTO_PAGES) next(page);
  }, [busy, failed, hasMore, rows.length, page, next]);

  if (!near) {
    return <section ref={spot} className="alsoin endless"><Waiting tall={320} /></section>;
  }
  if (!busy && !failed && rows.length === 0) return null;

  const MID = 6;
  return (
    <section ref={spot} className="alsoin endless">
      <div className="head">
        <h2>You may also like</h2>
        <Link to={`/${slug}`}>See everything</Link>
      </div>
      <div className="grid">
        {rows.map((p, i) => (
          <React.Fragment key={p.productCode}>
            {i === MID && banner ? <Promo slug={slug} banner={banner} inline /> : null}
            <Tile slug={slug} p={p} />
          </React.Fragment>
        ))}
        {busy ? Array.from({ length: 4 }, (_, i) => (
          <div key={`bone-${i}`} className="tile"><div className="shot bone" style={{ aspectRatio: '3 / 4' }} /></div>
        )) : null}
      </div>
      <div ref={edge} className="edge">
        {failed ? (
          <div className="tiny" role="status" style={{ textAlign: 'center' }}>
            More pieces could not load. Check the connection.{' '}
            <button type="button" className="go quiet" style={{ flex: '0 0 auto', marginTop: 10 }} onClick={again}>
              Try again
            </button>
          </div>
        ) : hasMore && page >= AUTO_PAGES ? (
          <button type="button" className="go quiet" style={{ flex: '0 0 auto' }} disabled={busy} onClick={more}>
            {busy ? 'Fetching…' : 'Show more'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export default function MoreToExplore({ slug, product, shop }) {
  const banners = useMemo(() => (shop?.banners ?? []).filter(b => b?.imageUrl), [shop]);
  const first = banners.length ? pick(product.productCode, banners.length) : -1;
  const top = first >= 0 ? banners[first] : null;
  const mid = banners.length > 1 ? banners[(first + 1) % banners.length] : null;

  /* What the "more like this" row is showing, so the grid below does not show it twice. */
  const [reel, setReel] = useState([]);
  const [together, setTogether] = useState([]);

  return (
    <>
      <Promo slug={slug} banner={top} />
      {/* What people actually bought with this, first: it is the one row that is about this piece. */}
      <AlsoBought slug={slug} product={product} onRows={rows => setTogether(rows.map(p => p.productCode))} />
      <AlsoIn slug={slug} product={product} shop={shop} onRows={rows => setReel(rows.map(p => p.productCode))} />
      <Recent slug={slug} product={product} />
      <Endless slug={slug} product={product} skip={[...reel, ...together]} banner={mid} />
    </>
  );
}
