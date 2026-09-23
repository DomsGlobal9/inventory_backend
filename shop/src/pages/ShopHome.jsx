import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getProducts, money } from '../api';
import { GridSkeleton, Problem, Say } from '../components/States';
import { NoMatch } from '../components/Motion';
import Shot from '../components/Shot';

/**
 * The shop, as a customer sees it after tapping a link in WhatsApp.
 *
 * The filters are the shop's OWN: its categories, its fabrics, what kinds of thing it sells, and
 * the range its prices actually run over -- all read from its whole catalogue, not from whichever
 * products happen to be on the page being looked at. That was a real bug: a shop with sixty pieces
 * showed the fabrics of the first twenty-four, and turning to page two changed the filters
 * underneath the shopper's hand.
 *
 * Everything chosen lives in the address bar. A shopper who finds something and forwards the link
 * to her sister forwards what she is looking at, and Back undoes one choice rather than leaving
 * the shop.
 */

const SORTS = [
  ['NEW', 'Newest first'],
  ['PRICE_LOW', 'Price: low to high'],
  ['PRICE_HIGH', 'Price: high to low'],
  ['NAME', 'A–Z']
];

/** What is worth saying about the saving: shoppers compare the percentage, not the difference. */
function saving(now, was) {
  const a = Number(now), b = Number(was);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round(((b - a) / b) * 100);
}

function Tile({ slug, p }) {
  const photo = p.images?.find(i => i.isPrimary) ?? p.images?.[0] ?? null;
  const sellable = (p.variants ?? []).some(v => v.sellable);

  const prices = (p.variants ?? []).map(v => Number(v.price)).filter(Number.isFinite);
  const from = prices.length ? Math.min(...prices) : null;
  const spread = prices.length > 1 && Math.min(...prices) !== Math.max(...prices);
  const wasList = (p.variants ?? []).map(v => Number(v.compareAtPrice)).filter(Number.isFinite);
  const was = wasList.length ? Math.max(...wasList) : null;
  const off = saving(from, was);
  const currency = p.variants?.[0]?.currency ?? 'INR';

  /* The shop's own shades, so the dots under a piece are its colours and not a browser's idea. */
  const colours = [];
  for (const v of p.variants ?? []) {
    if (!v.colour || colours.some(c => c.name === v.colour)) continue;
    colours.push({ name: v.colour, hex: v.colourHex ?? null });
  }

  return (
    <Link className={`tile${sellable ? '' : ' gone'}`} to={`/${slug}/p/${encodeURIComponent(p.productCode)}`}>
      <Shot src={photo?.url} alt={p.title}>
        {off ? <span className="tag">{off}% off</span> : null}
        {!sellable ? <span className="tag out">Sold out</span> : null}
      </Shot>
      <h2>{p.title}</h2>
      <p className="sub">{[p.fabric, p.dressType].filter(Boolean).join(' · ') || ' '}</p>
      {from != null && (
        <div className="row">
          <span className="now">{spread ? 'From ' : ''}{money(from, currency)}</span>
          {was && off ? <><span className="was">{money(was, currency)}</span><span className="off">{off}% off</span></> : null}
        </div>
      )}
      {colours.length > 1 && (
        <div className="dots" aria-label={`${colours.length} colours`}>
          {colours.slice(0, 5).map(c => (
            <i key={c.name} title={c.name}
              style={c.hex ? { background: c.hex } : { background: 'transparent' }}
              data-noshade={c.hex ? undefined : true} />
          ))}
          {colours.length > 5 ? <span className="sub" style={{ margin: 0 }}>+{colours.length - 5}</span> : null}
        </div>
      )}
    </Link>
  );
}

export default function ShopHome({ slug, shop }) {
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [nonce, setNonce] = useState(0);
  const [showFilters, setShowFilters] = useState(false);

  /*
   * Everything shown so far, and how far in we are.
   *
   * A phone shopper going through sixty sarees should not be turning pages -- they scroll, and the
   * next lot arrives before they reach the bottom. The filters and the search stay in the ADDRESS,
   * because that is the part worth forwarding to your sister; how many pages deep somebody has
   * scrolled is not, and a link that reopened at page four of a scroll would be stranger than one
   * that starts at the top.
   */
  const [shown, setShown] = useState([]);
  const [deeper, setDeeper] = useState(1);
  const [fetchingMore, setFetchingMore] = useState(false);
  const edge = useRef(null);

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'NEW';
  const category = params.get('category') ?? '';
  const fabric = params.get('fabric') ?? '';
  const dressType = params.get('dressType') ?? '';
  const maxPrice = params.get('maxPrice') ?? '';

  /* Anything chosen starts the list again from the top. */
  useEffect(() => { setDeeper(1); setShown([]); }, [slug, q, sort, category, fabric, dressType, maxPrice, nonce]);

  useEffect(() => {
    const ac = new AbortController();
    const first = deeper === 1;
    if (first) setState(s => ({ ...s, loading: true, error: null }));
    else setFetchingMore(true);

    getProducts(slug, { q, sort, category, fabric, dressType, maxPrice, page: deeper, limit: 24 }, { signal: ac.signal })
      .then(data => {
        setState({ loading: false, error: null, data });
        setShown(was => {
          if (first) return data.products ?? [];
          // Guarded against a page arriving twice -- a fast scroll can ask before the last
          // answer has landed, and a saree shown twice in one grid is a shop that looks broken.
          const seen = new Set(was.map(p => p.productCode));
          return [...was, ...(data.products ?? []).filter(p => !seen.has(p.productCode))];
        });
        setFetchingMore(false);
      })
      .catch(e => {
        if (e?.name === 'AbortError') return;
        setFetchingMore(false);
        if (first) setState({ loading: false, error: e, data: null });
      });
    return () => ac.abort();
  }, [slug, q, sort, category, fabric, dressType, maxPrice, deeper, nonce]);

  /*
   * The next lot, fetched before the bottom is reached.
   *
   * 600px of margin, so on a phone the grid has usually grown by the time a thumb gets there --
   * the point is that it never feels like waiting. The button below stays, for a keyboard, for a
   * screen reader, and for the browser where this observer does not exist.
   */
  const more = useCallback(() => {
    if (fetchingMore || !state.data?.hasMore) return;
    setDeeper(n => n + 1);
  }, [fetchingMore, state.data?.hasMore]);

  useEffect(() => {
    const node = edge.current;
    if (!node || typeof IntersectionObserver !== 'function') return undefined;
    const eye = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) more(); },
      { rootMargin: '600px 0px' }
    );
    eye.observe(node);
    return () => eye.disconnect();
  }, [more]);

  /** Changing anything goes back to page 1: page 3 of a different search is nonsense. */
  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('page');
    setParams(next, { replace: key === 'q' });
  };

  // The shop's own catalogue, not this page of it.
  const facets = shop?.facets ?? { fabrics: [], dressTypes: [], price: null };
  const total = state.data?.total ?? 0;
  const chosen = [q && ['q', `“${q}”`], category && ['category', category], fabric && ['fabric', fabric],
    dressType && ['dressType', dressType], maxPrice && ['maxPrice', `under ${money(maxPrice)}`]].filter(Boolean);

  /* Round figures a shopper actually thinks in, from the shop's own range. */
  const bands = facets.price
    ? [0.25, 0.5, 0.75].map(f => Math.round((facets.price.min + (facets.price.max - facets.price.min) * f) / 500) * 500)
      .filter((v, i, a) => v > facets.price.min && a.indexOf(v) === i)
    : [];

  return (
    <>
      <div className="rail">
        <button type="button" className="pill" aria-pressed={showFilters} onClick={() => setShowFilters(s => !s)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 6h18M7 12h10M10 18h4" strokeLinecap="round" />
          </svg>
          Filter{chosen.length ? ` (${chosen.length})` : ''}
        </button>
        <label className="pill">
          <select value={sort} onChange={e => setParam('sort', e.target.value)} aria-label="Order them by">
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {facets.dressTypes.slice(0, 6).map(d => (
          <button key={d.value} type="button" className="pill" aria-pressed={dressType === d.value}
            onClick={() => setParam('dressType', dressType === d.value ? '' : d.value)}>{d.value}</button>
        ))}
      </div>

      {showFilters && (
        <div className="filters">
          {facets.fabrics.length > 1 && (
            <div className="group">
              <h3>Fabric</h3>
              <div className="opts">
                {facets.fabrics.map(f => (
                  <button key={f.value} type="button" className="opt" aria-pressed={fabric === f.value}
                    onClick={() => setParam('fabric', fabric === f.value ? '' : f.value)}>
                    {f.value} <em>{f.count}</em>
                  </button>
                ))}
              </div>
            </div>
          )}
          {bands.length > 0 && (
            <div className="group">
              <h3>Price</h3>
              <div className="opts">
                {bands.map(b => (
                  <button key={b} type="button" className="opt" aria-pressed={String(b) === maxPrice}
                    onClick={() => setParam('maxPrice', String(b) === maxPrice ? '' : String(b))}>
                    Under {money(b)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {chosen.length > 0 && (
        <div className="chosen">
          {chosen.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setParam(key, '')}>{label} ✕</button>
          ))}
          <button type="button" className="all" onClick={() => setParams(new URLSearchParams())}>Clear all</button>
        </div>
      )}

      {state.loading && !state.data ? <GridSkeleton /> : null}
      {state.error ? <Problem error={state.error} shopName={shop?.name} onRetry={() => setNonce(n => n + 1)} /> : null}

      {state.data && !state.error ? (
        total === 0 ? (
          chosen.length ? (
            <Say title="Nothing matched that" art={<NoMatch />}
              action={<button className="go quiet" style={{ flex: '0 0 auto' }} onClick={() => setParams(new URLSearchParams())}>Show everything</button>}>
              Try a shorter word, or have a look at everything {shop?.name || 'the shop'} has.
            </Say>
          ) : (
            <Say title="Nothing here yet">
              {shop?.name || 'This shop'} has not put anything online yet. Do come back.
            </Say>
          )
        ) : (
          <>
            <p className="count">
              {total === 1 ? '1 piece' : `${total} pieces`}
              {shown.length < total ? <span> · showing {shown.length}</span> : null}
            </p>
            <div className="grid">
              {shown.map(p => <Tile key={p.productCode} slug={slug} p={p} />)}
              {/* The shape of the next lot, while it is on its way. */}
              {fetchingMore ? Array.from({ length: 4 }, (_, i) => (
                <div key={`more-${i}`} className="tile">
                  <div className="shot bone" style={{ aspectRatio: '3 / 4' }} />
                </div>
              )) : null}
            </div>

            {/* What the observer watches for, and what anybody without one can press. */}
            <div ref={edge} className="edge">
              {state.data.hasMore ? (
                <button className="go quiet" style={{ flex: '0 0 auto' }} disabled={fetchingMore} onClick={more}>
                  {fetchingMore ? 'Fetching…' : 'Show more'}
                </button>
              ) : shown.length > 12 ? (
                <p className="tiny">That is everything {shop?.name || 'this shop'} has online.</p>
              ) : null}
            </div>
          </>
        )
      ) : null}
    </>
  );
}
