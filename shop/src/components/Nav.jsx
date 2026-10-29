import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { bagCount, useBag } from '../bag';
import { signedIn, onAccountChange, wishlistOn } from '../account';

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

/**
 * The bag, and the little jolt it gives when something lands in it.
 *
 * "Add to bag" on a product page changes a number in the corner of the screen, which on a phone is
 * easy to miss entirely -- so a shopper taps again, and again, and ends up with three of something
 * they wanted one of. The jolt is the answer to "where did that go?", and it only fires when the
 * count goes UP: bumping while somebody empties their bag would be cheerful about the wrong thing.
 */
const Bag = ({ n }) => {
  const [jolt, setJolt] = useState(false);
  const was = useRef(n);

  useEffect(() => {
    if (n > was.current) {
      setJolt(true);
      const t = setTimeout(() => setJolt(false), 460);
      was.current = n;
      return () => clearTimeout(t);
    }
    was.current = n;
    return undefined;
  }, [n]);

  return (
  <span className={`bagicon${jolt ? ' jolt' : ''}`}>
    {/* A shopping bag, not a bin: straight sides, a fold along the top, the handle on its front. */}
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M6 2.5 3.5 6v13.5a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V6L18 2.5Z" strokeLinejoin="round" />
      <path d="M3.5 6h17" />
      <path d="M15.5 10a3.5 3.5 0 0 1-7 0" strokeLinecap="round" />
    </svg>
    {n > 0 ? <i aria-hidden="true">{n > 9 ? '9+' : n}</i> : null}
  </span>
  );
};

/** An order is a parcel on its way: a box. */
const OrdersGlyph = ({ size = 21 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2.8 20.5 7.4v9.2L12 21.2l-8.5-4.6V7.4Z" />
    <path d="M3.8 7.6 12 12l8.2-4.4M12 12v9" />
    <path d="m7.8 5.1 8.4 4.6" />
  </svg>
);

/**
 * Profile, opening a short menu: who is signed in, their orders, the wishlist, and the account (or
 * Sign in). Closes on a tap outside, on Escape, and when a page is chosen.
 */
function ProfileMenu({ slug, me, firstName, wishlist }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const where = useLocation();
  // On a phone the menu hangs from the screen's right edge under the bar (styles.css), not from the
  // icon -- which is second of four, so the menu opened in the middle of the screen (owner, 29 Oct).
  const [below, setBelow] = useState(0);
  const toggle = () => {
    const bar = box.current?.closest('header');
    setBelow(Math.round(bar?.getBoundingClientRect().bottom ?? 64));
    setOpen(o => !o);
  };
  useEffect(() => { setOpen(false); }, [where.pathname, where.hash]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="pmenu" ref={box}>
      <button type="button" className="icon worded" aria-haspopup="menu" aria-expanded={open}
        aria-label={me ? `Your profile${firstName ? `, ${firstName}` : ''}` : 'Profile'} onClick={toggle}>
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="8.5" r="3.8" />
          <path d="M4.5 20.2c1.2-3.6 4.1-5.4 7.5-5.4s6.3 1.8 7.5 5.4" />
        </svg>
        <span className="word" aria-hidden="true">Profile</span>
      </button>
      {open && (
        <div className="pmenu-list" role="menu" style={{ '--below': `${below}px` }} onClick={(e) => { if (e.target.closest('a')) setOpen(false); }}>
          <div className="pmenu-who">
            {me ? <><b>Hello{firstName ? ` ${firstName}` : ''}</b><span>{me.phone ? `Signed in with ••${String(me.phone).slice(-4)}` : 'Signed in'}</span></>
              : <><b>Welcome</b><span>Sign in to see your orders from any phone</span></>}
          </div>
          {me ? null : <Link role="menuitem" className="pmenu-sign" to={`/${slug}/account`}>Sign in</Link>}
          <Link role="menuitem" to={`/${slug}/orders`}><OrdersGlyph size={18} /> Orders</Link>
          {wishlist ? <Link role="menuitem" to={`/${slug}/account#wishlist`} state={me ? undefined : { why: 'heart' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20.3s-7.6-4.6-9-9.4C2 7.6 4.1 4.6 7.3 4.6c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.2 0 5.3 3 4.3 6.3-1.4 4.8-9 9.4-9 9.4Z" />
            </svg> Wishlist</Link> : null}
          {/* Signed in only: the addresses saved at past checkouts (owner, 29 Oct). */}
          {me ? <Link role="menuitem" to={`/${slug}/account#addresses`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.4" />
            </svg> Saved addresses</Link> : null}
          {me ? <Link role="menuitem" to={`/${slug}/account`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20.2c1.2-3.6 4.1-5.4 7.5-5.4s6.3 1.8 7.5 5.4" />
            </svg> Your account</Link> : null}
        </div>
      )}
    </div>
  );
}

/**
 * The shop's name, whole, on a phone: two lines at most, a size smaller at a time until it fits, never
 * cut off with dots (29 Oct, "Sw…"). Wider screens keep the stylesheet's size.
 */
function useFitName(name) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      el.style.fontSize = '';
      if (window.innerWidth >= 720) return;
      let size = parseFloat(getComputedStyle(el).fontSize) || 17;
      // More than two lines (with room for a tall serif's line boxes), or a single word wider than the space.
      const tooBig = () => el.scrollHeight > parseFloat(getComputedStyle(el).lineHeight) * 2.5 || el.scrollWidth > el.clientWidth + 1;
      while (tooBig() && size > 11) { size -= 1; el.style.fontSize = `${size}px`; }
    };
    fit();
    // Fonts arrive late and change the width of the words; phones turn sideways.
    document.fonts?.ready?.then(fit).catch(() => null);
    window.addEventListener('resize', fit);
    // The room changes after the first look too: the logo arrives and takes its width. Refitted when
    // the bar's own width for the brand changes -- never because of the size this sets.
    const brand = el.closest('.brand');
    let room = brand?.clientWidth ?? 0;
    const watch = typeof ResizeObserver === 'function' && brand
      ? new ResizeObserver(() => { const now = brand.clientWidth; if (Math.abs(now - room) > 1) { room = now; fit(); } })
      : null;
    watch?.observe(brand);
    const logo = brand?.querySelector('.mark');
    logo?.addEventListener('load', fit);
    return () => { window.removeEventListener('resize', fit); watch?.disconnect(); logo?.removeEventListener('load', fit); };
  }, [name]);
  return ref;
}

export default function Nav({ shop, compact = false }) {
  const nameRef = useFitName(shop?.name);
  const { slug } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const lines = useBag(slug);
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  // Who is signed in here, kept up to date when they sign in or out on another page.
  const [me, setMe] = useState(() => signedIn(slug));
  useEffect(() => { setMe(signedIn(slug)); return onAccountChange(() => setMe(signedIn(slug))); }, [slug]);
  const firstName = me?.name ? String(me.name).trim().split(/\s+/)[0] : null;
  // Hearted pieces, for the count on the Wishlist icon. Kept on this phone by account.js and updated as hearts are tapped.
  const hearts = me?.hearts?.length ?? 0;

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
              <span className="name" ref={nameRef}>{shop?.name}</span>
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

          {/*
            Grouped at the right, each icon with its word under it, as Myntra does (owner, 29 Oct):
            Search, Profile (its menu holds Orders), Wishlist and Bag. A word under each says what it is
            without a tap to find out.
          */}
          <div className="tools">
            <button type="button" className="icon worded only-phone" aria-label="Search"
              onClick={() => setSeeking(s => !s)} aria-expanded={seeking}>
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              <span className="word" aria-hidden="true">Search</span>
            </button>

            {/* Profile opens a menu with Orders in it, as Myntra's does (owner, 29 Oct). */}
            {shop?.accounts !== false ? <ProfileMenu slug={slug} me={me} firstName={firstName} wishlist={wishlistOn(shop)} /> : null}
            {/* The hearts live with the account; this goes straight to them. */}
            {wishlistOn(shop) ? <Link to={`/${slug}/account#wishlist`} state={me ? undefined : { why: 'heart' }} className="icon worded" aria-label={hearts ? `Your wishlist, ${hearts} ${hearts === 1 ? 'piece' : 'pieces'}` : 'Your wishlist'} title="Your wishlist">
              {/* How many are hearted, on the icon like the bag's count (owner, 29 Oct): it moves the
                  moment a heart is tapped, since noteHeart tells the bar (onAccountChange). */}
              <span className="bagicon wishicon">
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20.3s-7.6-4.6-9-9.4C2 7.6 4.1 4.6 7.3 4.6c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.2 0 5.3 3 4.3 6.3-1.4 4.8-9 9.4-9 9.4Z" />
                </svg>
                {hearts > 0 ? <i aria-hidden="true">{hearts > 9 ? '9+' : hearts}</i> : null}
              </span>
              <span className="word" aria-hidden="true">Wishlist</span>
            </Link> : null}
            {/* With no accounts there is no Profile to hold it, so Orders keeps its own place. */}
            {shop?.accounts === false ? <Link to={`/${slug}/orders`} className="icon worded" aria-label="Your orders" title="Your orders">
              <OrdersGlyph />
              <span className="word" aria-hidden="true">Orders</span>
            </Link> : null}
            <Link to={`/${slug}/bag`} className="icon worded" aria-label={count ? `Your bag, ${count} pieces` : 'Your bag'}>
              <Bag n={count} />
              <span className="word" aria-hidden="true">Bag</span>
            </Link>
          </div>
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
