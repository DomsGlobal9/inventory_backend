import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAlsoBought, money } from '../api';
import Shot from './Shot';

/**
 * "Customers who bought this also bought", under the piece being looked at.
 *
 * From the shop's own bills, at the till and online: only what at least two different people bought
 * together with this piece, and only what can be bought online now. Most pieces of a young shop
 * have no such history, so until the answer arrives -- and when it is empty -- the row is simply not
 * there, rather than placeholders that vanish.
 */
export default function AlsoBought({ slug, product, onRows }) {
  const [rows, setRows] = useState(null);
  const reel = useRef(null);
  useEffect(() => { if (rows) onRows?.(rows); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const slide = (dir) => {
    const el = reel.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  useEffect(() => {
    const ac = new AbortController();
    setRows(null);
    getAlsoBought(slug, product.productCode, { signal: ac.signal })
      .then(page => setRows((page.products ?? []).filter(p => p.productCode !== product.productCode)))
      .catch(e => { if (e?.name !== 'AbortError') setRows([]); });
    return () => ac.abort();
  }, [slug, product?.productCode]);

  if (!rows || rows.length === 0) return null;

  return (
    <section className="alsoin">
      <div className="head">
        <h2>Customers who bought this also bought</h2>
        <span className="ends">
          <button type="button" className="nudge" aria-label="Scroll back" onClick={() => slide(-1)}>‹</button>
          <button type="button" className="nudge" aria-label="Scroll on" onClick={() => slide(1)}>›</button>
        </span>
      </div>

      <div className="reel" ref={reel}>
        {rows.map(p => {
          const photo = p.images?.find(i => i.isPrimary) ?? p.images?.[0] ?? null;
          const prices = (p.variants ?? []).filter(v => v.sellable).map(v => Number(v.price)).filter(Number.isFinite);
          const from = prices.length ? Math.min(...prices) : null;
          return (
            <Link key={p.productCode} className="small" to={`/${slug}/p/${encodeURIComponent(p.productCode)}`}>
              <Shot src={photo?.url} alt={p.title} />
              <h3>{p.title}</h3>
              {from != null ? <p className="now">{money(from, p.variants?.[0]?.currency ?? 'INR')}</p> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
