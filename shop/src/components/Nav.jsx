import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { bagCount, useBag } from '../bag';

/**
 * The bar at the top of every page of a shop.
 *
 * Every part of it belongs to the shop: its logo, its name, its colour, and -- this is the part
 * that matters -- the categories it actually sells. Those come from the shop's own catalogue, so a
 * shop that has never sold a lehenga has no Lehengas in its nav, and the day it adds one, it
 * appears without anybody touching this file.
 *
 * It stays with the shopper as they scroll, because on a phone the search, the categories and the
 * bag are the only ways out of a long grid of photographs.
 */

const Bag = ({ n }) => (
  <span className="bagicon">
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M6 7h12l-1 13H7L6 7Z" strokeLinejoin="round" />
      <path d="M9 7a3 3 0 0 1 6 0" strokeLinecap="round" />
    </svg>
    {n > 0 ? <i aria-hidden="true">{n > 9 ? '9+' : n}</i> : null}
  </span>
);

export default function Nav({ shop, compact = false }) {
  const { slug } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const lines = useBag(slug);
  const count = lines.reduce((n, l) => n + l.quantity, 0);

  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const [typed, setTyped] = useState(q);
  const [seeking, setSeeking] = useState(false);
  const box = useRef(null);

  useEffect(() => { setTyped(q); }, [q]);
  useEffect(() => { if (seeking) box.current?.focus(); }, [seeking]);

  const categories = shop?.facets?.categories ?? [];

  /*
   * Searching from a product page has to leave it: the results belong to the shop's front page.
   * Searching from the front page only changes the address, so Back undoes the search rather than
   * leaving the shop.
   */
  const search = (text) => {
    const next = new URLSearchParams(compact ? '' : params);
    if (text) next.set('q', text); else next.delete('q');
    next.delete('page');
    if (compact) nav(`/${slug}?${next.toString()}`);
    else setParams(next, { replace: true });
    setSeeking(false);
  };

  const pickCategory = (value) => {
    const next = new URLSearchParams(compact ? '' : params);
    if (value) next.set('category', value); else next.delete('category');
    next.delete('page');
    if (compact) nav(`/${slug}?${next.toString()}`);
    else setParams(next);
  };

  return (
    <header className="bar">
      <div className="wrap">
        <div className="row">
          <Link to={`/${slug}`} className="brand" aria-label={`${shop?.name ?? 'Shop'}, front page`}>
            {shop?.logoUrl ? <img className="mark" src={shop.logoUrl} alt="" /> : null}
            <span className="names">
              <span className="name">{shop?.name}</span>
              {shop?.facets?.total ? <span className="sub">{shop.facets.total} pieces online</span> : null}
            </span>
          </Link>

          {/* On a wide screen the search sits in the bar; on a phone it opens from the glass. */}
          <form className="find" role="search" onSubmit={e => { e.preventDefault(); search(typed.trim()); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input value={typed} onChange={e => setTyped(e.target.value)} type="search" maxLength={60}
              placeholder={`Search ${shop?.name ?? 'the shop'}`} aria-label="Search this shop" />
          </form>

          <button type="button" className="icon only-phone" aria-label="Search"
            onClick={() => setSeeking(s => !s)} aria-expanded={seeking}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
          </button>

          <Link to={`/${slug}/bag`} className="icon" aria-label={count ? `Your bag, ${count} pieces` : 'Your bag'}>
            <Bag n={count} />
          </Link>
        </div>

        {seeking && (
          <form className="seek only-phone" role="search" onSubmit={e => { e.preventDefault(); search(typed.trim()); }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: .45, flex: '0 0 auto' }} aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input ref={box} value={typed} onChange={e => setTyped(e.target.value)} type="search" maxLength={60}
              placeholder={`Search ${shop?.name ?? 'the shop'}`} aria-label="Search this shop" />
            {typed ? <button type="button" className="icon" style={{ width: 30, height: 30 }} aria-label="Clear"
              onClick={() => { setTyped(''); search(''); }}>✕</button> : null}
          </form>
        )}

        {/* The shop's own departments. Hidden when it sells only one kind of thing, because a nav
            offering the only choice there is would be furniture and nothing else. */}
        {categories.length > 1 && (
          <nav className="depts" aria-label="What this shop sells">
            <button type="button" aria-current={!category} onClick={() => pickCategory('')}>All</button>
            {categories.map(c => (
              <button key={c.value} type="button" aria-current={category === c.value}
                onClick={() => pickCategory(category === c.value ? '' : c.value)}>
                {c.label}
              </button>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}

export { bagCount };
