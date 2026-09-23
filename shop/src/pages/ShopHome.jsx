import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getProducts, money } from '../api';
import { GridSkeleton, Problem, Say } from '../components/States';

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
      <div className="shot">
        {off ? <span className="tag">{off}% off</span> : null}
        {!sellable ? <span className="tag out">Sold out</span> : null}
        {photo ? <img src={photo.url} alt={p.title} loading="lazy" decoding="async" /> : null}
      </div>
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

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'NEW';
  const category = params.get('category') ?? '';
  const fabric = params.get('fabric') ?? '';
  const dressType = params.get('dressType') ?? '';
  const maxPrice = params.get('maxPrice') ?? '';
  const page = Number(params.get('page')) || 1;

  useEffect(() => {
    const ac = new AbortController();
    setState(s => ({ ...s, loading: true, error: null }));
    getProducts(slug, { q, sort, category, fabric, dressType, maxPrice, page, limit: 24 }, { signal: ac.signal })
      .then(data => setState({ loading: false, error: null, data }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, data: null }); });
    return () => ac.abort();
  }, [slug, q, sort, category, fabric, dressType, maxPrice, page, nonce]);

  /** Changing anything goes back to page 1: page 3 of a different search is nonsense. */
  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: key === 'q' });
    if (key === 'page') window.scrollTo({ top: 0, behavior: 'smooth' });
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
            <Say title="Nothing matched that"
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
            <p className="count">{total === 1 ? '1 piece' : `${total} pieces`}</p>
            <div className="grid" style={state.loading ? { opacity: .45 } : undefined}>
              {state.data.products.map(p => <Tile key={p.productCode} slug={slug} p={p} />)}
            </div>
            {(state.data.hasMore || page > 1) && (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', padding: '0 0 36px' }}>
                <button className="go quiet" style={{ flex: '0 0 auto' }} disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>Back</button>
                <span style={{ alignSelf: 'center', color: 'var(--muted)', fontSize: 13 }}>Page {page}</span>
                <button className="go quiet" style={{ flex: '0 0 auto' }} disabled={!state.data.hasMore} onClick={() => setParam('page', String(page + 1))}>More</button>
              </div>
            )}
          </>
        )
      ) : null}
    </>
  );
}
