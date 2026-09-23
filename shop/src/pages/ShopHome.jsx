import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getProducts, money } from '../api';
import { GridSkeleton, Problem, Say } from '../components/States';

/**
 * The shop, as a customer sees it after tapping a link in WhatsApp.
 *
 * The search and the filters live in the address bar, not only in memory. A shopper who finds
 * something and forwards the link to her sister should forward what she is looking at, and pressing
 * Back should undo one choice rather than leaving the shop.
 */

const SORTS = [
  ['NEW', 'Newest'],
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
  const live = p.variants?.filter(v => v.sellable) ?? [];
  const sellable = live.length > 0;

  const prices = (p.variants ?? []).map(v => Number(v.price)).filter(Number.isFinite);
  const from = prices.length ? Math.min(...prices) : null;
  const spread = prices.length > 1 && Math.min(...prices) !== Math.max(...prices);
  const wasList = (p.variants ?? []).map(v => Number(v.compareAtPrice)).filter(Number.isFinite);
  const was = wasList.length ? Math.max(...wasList) : null;
  const off = saving(from, was);
  const currency = p.variants?.[0]?.currency ?? 'INR';
  const colours = [...new Set((p.variants ?? []).map(v => v.colour).filter(Boolean))];

  return (
    <Link className={`tile${sellable ? '' : ' gone'}`} to={`/${slug}/p/${encodeURIComponent(p.productCode)}`}>
      <div className="shot">
        {off ? <span className="tag">{off}% off</span> : null}
        {!sellable ? <span className="tag out">Sold out</span> : null}
        {photo ? <img src={photo.url} alt={p.title} loading="lazy" decoding="async" /> : null}
      </div>
      <h2>{p.title}</h2>
      <p className="sub">{[p.fabric, p.dressType].filter(Boolean).join(' · ') || ' '}</p>
      {from != null && (
        <div className="row">
          <span className="now">{spread ? 'From ' : ''}{money(from, currency)}</span>
          {was && off ? <><span className="was">{money(was, currency)}</span><span className="off">{off}% off</span></> : null}
        </div>
      )}
      {colours.length > 1 && (
        <div className="dots" aria-label={`${colours.length} colours`}>
          {colours.slice(0, 5).map(c => <i key={c} style={{ background: c.toLowerCase() }} />)}
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

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'NEW';
  const fabric = params.get('fabric') ?? '';
  const page = Number(params.get('page')) || 1;

  // What is being typed, kept apart from what has been searched for: the address bar should not
  // change on every keystroke, and neither should the results.
  const [typed, setTyped] = useState(q);
  useEffect(() => { setTyped(q); }, [q]);

  useEffect(() => {
    const ac = new AbortController();
    setState(s => ({ ...s, loading: true, error: null }));
    getProducts(slug, { q, sort, fabric, page, limit: 24 }, { signal: ac.signal })
      .then(data => setState({ loading: false, error: null, data }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, data: null }); });
    return () => ac.abort();
  }, [slug, q, sort, fabric, page, nonce]);

  /** Changing anything goes back to page 1: page 3 of a different search is nonsense. */
  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: key === 'q' });
    if (key === 'page') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const fabrics = [...new Set((state.data?.products ?? []).map(p => p.fabric).filter(Boolean))].sort();
  const total = state.data?.total ?? 0;
  const filtered = Boolean(q || fabric);

  return (
    <>
      <form role="search" onSubmit={e => { e.preventDefault(); setParam('q', typed.trim()); }}>
        <div className="seek">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: .45, flex: '0 0 auto' }} aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input type="search" inputMode="search" value={typed} onChange={e => setTyped(e.target.value)}
            placeholder={`Search ${shop?.name || 'the shop'}`} aria-label="Search this shop" maxLength={60} />
          {typed ? (
            <button type="button" className="icon" style={{ width: 28, height: 28 }} aria-label="Clear"
              onClick={() => { setTyped(''); setParam('q', ''); }}>✕</button>
          ) : null}
        </div>
      </form>

      <div className="rail">
        {filtered ? (
          <button type="button" className="pill" aria-pressed="true" onClick={() => setParams(new URLSearchParams())}>
            Clear ✕
          </button>
        ) : null}
        <label className="pill">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 6h18M7 12h10M10 18h4" strokeLinecap="round" />
          </svg>
          <select value={sort} onChange={e => setParam('sort', e.target.value)} aria-label="Order them by">
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {/* Only offered when there is something to choose between. */}
        {fabrics.length > 1 || fabric ? (
          <>
            <button type="button" className="pill" aria-pressed={!fabric} onClick={() => setParam('fabric', '')}>All fabrics</button>
            {(fabric && !fabrics.includes(fabric) ? [fabric, ...fabrics] : fabrics).map(f => (
              <button key={f} type="button" className="pill" aria-pressed={fabric === f}
                onClick={() => setParam('fabric', fabric === f ? '' : f)}>{f}</button>
            ))}
          </>
        ) : null}
      </div>

      {state.loading && !state.data ? <GridSkeleton /> : null}

      {state.error ? <Problem error={state.error} shopName={shop?.name} onRetry={() => setNonce(n => n + 1)} /> : null}

      {state.data && !state.error ? (
        total === 0 ? (
          filtered ? (
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
            <p className="count">{total === 1 ? '1 piece' : `${total} pieces`}{q ? ` for “${q}”` : ''}</p>
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
