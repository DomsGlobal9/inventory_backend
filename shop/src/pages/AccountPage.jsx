import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { EmptyWishlist } from '../components/Motion';
import { placed } from '../components/Banners';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { getAccount, getProducts, sendCode, checkCode, signOutOf, signOutOthers, likePiece, removeAddress, saveAddress, heldProof, holdProof, money } from '../api';
import { becomeSignedIn, remember, forget, noteHeart, signedIn, onAccountChange } from '../account';
import { addToBag } from '../bag';
import { sized, orWhole } from '../photo';

/**
 * The shopper's account at this shop (29 Oct): "Sign in with WhatsApp", no password.
 *
 * Signed out: their number, a code on WhatsApp from the shop's own number, signed in for 90 days on
 * this phone. Signed in: their orders (from any phone), wishlist, saved addresses, and points and
 * store credit where the shop has them -- everything read with the sign-in and nothing else.
 */
const ICONS = {
  orders: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 2.8 20.5 7.4v9.2L12 21.2l-8.5-4.6V7.4Z" />
      <path d="M3.8 7.6 12 12l8.2-4.4M12 12v9" />
      <path d="m7.8 5.1 8.4 4.6" />
    </svg>
  ),
  heart: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 20.3s-7.6-4.6-9-9.4C2 7.6 4.1 4.6 7.3 4.6c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.2 0 5.3 3 4.3 6.3-1.4 4.8-9 9.4-9 9.4Z" />
    </svg>
  ),
  pin: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  )
};

const shownPhone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : p;
};

/**
 * One component, three pages (owner, 29 Oct): view 'profile' (/account) is who they are, their balances
 * and a short menu; 'wishlist' (/wishlist) the hearted pieces as a grid; 'addresses' (/addresses) the
 * address book. Orders keep their own page (/orders). Signing in is the same on all three.
 */
export default function AccountPage({ shop, view = 'profile' }) {
  const { slug } = useParams();
  const nav = useNavigate();
  const where = useLocation();
  const back = where.state?.back ?? null;
  const [me, setMe] = useState(null);           // null while loading; { signedIn: false } or the account
  const [said, setSaid] = useState(null);
  const [asking, setAsking] = useState(false);
  const [ending, setEnding] = useState(false);
  const [done, setDone] = useState(null);

  // Signed out in another tab or by the Profile menu: this page follows, instead of showing an
  // account it can no longer read.
  useEffect(() => onAccountChange(() => {
    if (!signedIn(slug)) setMe(m => (m?.signedIn ? { signedIn: false, canSignIn: true } : m));
  }), [slug]);

  // With the other hooks, above the early returns: declared after them, signing in added a hook
  // between two renders and the page went blank.
  const [editing, setEditing] = useState(null);   // null, 'new', or the address being changed
  const [confirming, setConfirming] = useState(null); // the id of an address whose Remove asked "are you sure"

  const load = useCallback(async () => {
    const token = heldProof(slug);
    if (!token) { setMe({ signedIn: false, canSignIn: !!shop?.canVerifyPhone }); return; }
    // A pass from a code check (the checkout, a try-on) becomes a sign-in here too.
    const account = await becomeSignedIn(slug);
    if (account) { setMe(account); return; }
    try {
      const out = await getAccount(slug, heldProof(slug));
      if (!out?.signedIn) forget(slug);
      setMe(out?.signedIn ? out : { signedIn: false, canSignIn: out?.canSignIn ?? !!shop?.canVerifyPhone });
    } catch {
      setMe({ signedIn: false, canSignIn: !!shop?.canVerifyPhone });
    }
  }, [slug, shop?.canVerifyPhone]);

  useEffect(() => { void load(); }, [load]);

  // Links made before the pages were split (/account#wishlist, #addresses) open the page they meant.
  useEffect(() => {
    const to = { '#wishlist': 'wishlist', '#addresses': 'addresses' }[where.hash];
    if (view === 'profile' && to) nav(`/${slug}/${to}`, { replace: true, state: where.state });
  }, [view, where.hash, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  if (shop?.accounts === false) {
    return (
      <div className="account">
        <section className="card asignin">
          <h1>{shop?.name || 'This shop'} does not offer accounts</h1>
          <p>You can still order as a guest. Use the link in your WhatsApp order confirmation to track it.</p>
          <Link className="go quiet" to={`/${slug}/orders`}>Your orders</Link>
        </section>
      </div>
    );
  }
  if (view === 'wishlist' && shop?.wishlist === false) {
    return (
      <div className="account">
        <section className="card asignin">
          <h1>{shop?.name || 'This shop'} does not keep wishlists</h1>
          <p>Browse the latest collection on the home page.</p>
          <Link className="go quiet keepon" to={`/${slug}`}>Continue shopping</Link>
        </section>
      </div>
    );
  }
  if (me === null) return <div className="bone" style={{ height: 320, borderRadius: 14, margin: '20px 0' }} />;
  if (!me.signedIn) {
    return (
      <SignIn
        slug={slug}
        shop={shop}
        canSignIn={me.canSignIn}
        why={where.state?.why ?? (view === 'wishlist' ? 'heart' : view === 'addresses' ? 'addresses' : undefined)}
        onDone={async () => {
          const account = await becomeSignedIn(slug);
          // Signed in because of a heart: that piece is saved now, then back to it, saying so.
          const heart = where.state?.heart;
          let hearted = null;
          if (account && heart?.productCode) {
            try {
              await likePiece(slug, heldProof(slug), heart.productCode, true, heart.variantCode ?? undefined);
              noteHeart(slug, heart.productCode, true);
              hearted = heart.productCode;
            } catch { /* not saved: the heart is still there to tap */ }
          }
          if (account && back) { nav(back, { replace: true, state: hearted ? { hearted } : null }); return; }
          setMe(account ?? { signedIn: false, canSignIn: true });
        }}
      />
    );
  }

  const token = heldProof(slug);
  const refresh = async () => {
    const out = await getAccount(slug, token).catch(() => null);
    if (out?.signedIn) { remember(slug, out); setMe(out); }
    else { forget(slug); setMe({ signedIn: false, canSignIn: true }); }
  };

  const out = async (everywhere) => {
    setSaid(null);
    try { await signOutOf(slug, token, everywhere); } catch { /* signed out here either way */ }
    forget(slug);
    setMe({ signedIn: false, canSignIn: true });
  };

  // Every other device signed out, after a warning; this one stays signed in (3 Nov, owner).
  const outOthers = async () => {
    setEnding(true); setSaid(null); setDone(null);
    try {
      const r = await signOutOthers(slug, token);
      setAsking(false);
      if (r?.signedOut === true) {
        forget(slug);
        setMe({ signedIn: false, canSignIn: true });
        return;
      }
      const n = Number(r?.devices ?? 0);
      setDone(n > 0 ? `Signed out of ${n} other ${n === 1 ? 'device' : 'devices'}. You are still signed in here.` : 'No other device was signed in. You are still signed in here.');
      await refresh();
    } catch (e) {
      setAsking(false);
      setSaid(e?.message ?? 'We could not sign out your other devices. Please try again.');
    } finally { setEnding(false); }
  };

  const unheart = async (h) => {
    try {
      await likePiece(slug, token, h.productCode, false, h.variantCode ?? undefined);
      noteHeart(slug, h.productCode, false);
      await refresh();
    } catch (e) {
      setSaid(e?.message ?? 'That could not be changed. Try again.');
    }
  };

  const dropAddress = async (a) => {
    try { await removeAddress(slug, token, a.id); await refresh(); }
    catch (e) { setSaid(e?.message ?? 'That could not be removed. Try again.'); }
  };

  // Adding and editing an address here (owner, 29 Oct); the checkout offers whatever is saved.
  const useFirst = async (a) => {
    try {
      await saveAddress(slug, token, {
        id: a.id,
        label: a.label,
        name: a.name,
        phone: a.phone,
        line: a.line,
        pincode: a.pincode,
        isDefault: true
      });
      await refresh();
    } catch (e) {
      setSaid(e?.message ?? 'That could not be changed. Try again.');
    }
  };

  // 1. Wishlist View
  if (view === 'wishlist') {
    return (
      <WishlistView
        slug={slug}
        shop={shop}
        me={me}
        token={token}
        said={said}
        refresh={refresh}
        unheart={unheart}
      />
    );
  }

  // 2. Saved Addresses View
  if (view === 'addresses') {
    return (
      <div className="account apage book-page">
        <nav className="acrumb" aria-label="Breadcrumb">
          <Link to={`/${slug}/account`}>Account</Link>
          <span aria-hidden="true">›</span>
          <span>Saved addresses</span>
        </nav>
        <header className="book-header">
          <div className="orders-title-group">
            <div className="orders-title-icon" aria-hidden="true"><PlaceGlyph label="" size={22} /></div>
            <div>
              <h1 className="pagetitle">Saved addresses</h1>
              <p className="orders-subtitle">
                {me.addresses.length === 0
                  ? 'Ready to use at checkout'
                  : `${me.addresses.length} saved ${me.addresses.length === 1 ? 'address' : 'addresses'} · Ready to use at checkout`}
              </p>
            </div>
          </div>
        </header>
        {said ? <p className="refused" role="alert">{said}</p> : null}
        <section className="card book-grid" id="addresses">
          {me.addresses.length === 0 && editing !== 'new' ? (
            <div className="wish-empty-wrap book-empty">
              <div className="orders-title-icon book-empty-art" aria-hidden="true"><PlaceGlyph label="" size={30} /></div>
              <h2>No saved addresses yet</h2>
              <p>Add an address to use it at checkout. Addresses from your orders are saved here too.</p>
              <button type="button" className="go" onClick={() => setEditing('new')}>+ Add a new address</button>
            </div>
          ) : (
            <ul className="aaddr">
              {me.addresses.map(a => editing?.id === a.id ? (
                <li key={a.id} className="aedit">
                  <AddressForm slug={slug} token={token} me={me} address={a} onDone={async () => { setEditing(null); await refresh(); }} onCancel={() => setEditing(null)} />
                </li>
              ) : (
                <li key={a.id} className="acard book-card" data-default={a.isDefault ? 'true' : undefined}>
                  <span className="awhere">
                    <span className="book-head">
                      <span className="book-icon" aria-hidden="true"><PlaceGlyph label={a.label} size={18} /></span>
                      <b>{a.name || a.label || 'Address'}</b>
                      <span className="atags">
                        {a.label ? <em className="atag">{a.label}</em> : null}
                        {a.isDefault ? <em className="atag adefault">Default</em> : null}
                      </span>
                    </span>
                    <span className="book-line">{withoutPin(a.line, a.pincode)}</span>
                    <small className="book-meta">
                      <span>PIN {a.pincode}</span>
                      {a.phone ? <span>{shownPhone(a.phone)}</span> : null}
                    </small>
                  </span>
                  {confirming === a.id ? (
                    <span className="abtns asure" role="group" aria-label="Remove this address?">
                      <span className="asureq">Remove this address?</span>
                      <button type="button" className="abtn danger" onClick={async () => { setConfirming(null); await dropAddress(a); }}>Yes, remove</button>
                      <button type="button" className="abtn" onClick={() => setConfirming(null)}>Keep it</button>
                    </span>
                  ) : (
                    <span className="abtns">
                      <button type="button" className="abtn" onClick={() => setEditing(a)}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>
                        Edit
                      </button>
                      {!a.isDefault ? (
                        <button type="button" className="abtn" onClick={() => useFirst(a)}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z" /></svg>
                          Set default
                        </button>
                      ) : null}
                      <button type="button" className="abtn danger" aria-label={`Remove ${a.label || 'this'} address`} onClick={() => setConfirming(a.id)}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
                        Remove
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editing === 'new' ? (
            <div className="aedit"><AddressForm slug={slug} token={token} me={me} address={null} first={me.addresses.length === 0} onDone={async () => { setEditing(null); await refresh(); }} onCancel={() => setEditing(null)} /></div>
          ) : editing || me.addresses.length === 0 ? null : me.addresses.length >= MOST_ADDRESSES ? (
            <p className="aempty">You can keep {MOST_ADDRESSES} addresses. Remove one to add another.</p>
          ) : (
            <button type="button" className="book-add" onClick={() => setEditing('new')}>+ Add a new address</button>
          )}
        </section>
      </div>
    );
  }

  // 3. Profile View (Default)
  return (
    <ProfileView
      slug={slug}
      shop={shop}
      me={me}
      said={said}
      done={done}
      asking={asking}
      setAsking={setAsking}
      ending={ending}
      out={out}
      outOthers={outOthers}
    />
  );
}

/**
 * ── WishlistView: Redesigned with premium cards, Add-to-bag, filters & empty state ──
 */
function WishlistView({ slug, shop, me, said, unheart }) {
  const [stockFilter, setStockFilter] = useState('ALL');
  const [addedCodes, setAddedCodes] = useState({});
  const [movingAll, setMovingAll] = useState(false);
  const [search, setSearch] = useState('');

  const hearts = me?.hearts ?? [];
  const inStockCount = hearts.filter(h => h.available).length;
  // Only what the bag can truly take: a shop not taking orders has no bag to add to, and a piece with a
  // choice of sizes is chosen on its own page.
  const buying = shop?.buying?.open === true;
  const ready = buying ? hearts.filter(h => h.available && h.buyCode) : [];
  const soldOutCount = hearts.filter(h => !h.available).length;

  const filteredHearts = useMemo(() => {
    return hearts.filter(h => {
      if (stockFilter === 'IN_STOCK' && !h.available) return false;
      if (stockFilter === 'SOLD_OUT' && h.available) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchTitle = h.title?.toLowerCase().includes(q);
        const matchColour = h.colour?.toLowerCase().includes(q);
        if (!matchTitle && !matchColour) return false;
      }
      return true;
    });
  }, [hearts, stockFilter, search]);

  const handleAdd = (h, e) => {
    e.preventDefault();
    e.stopPropagation();
    addToBag(slug, h.buyCode, 1);
    setAddedCodes(prev => ({ ...prev, [h.productCode]: true }));
    setTimeout(() => {
      setAddedCodes(prev => ({ ...prev, [h.productCode]: false }));
    }, 2200);
  };

  const handleMoveAll = () => {
    if (!ready.length) return;
    for (const h of ready) addToBag(slug, h.buyCode, 1);
    setMovingAll(true);
    setTimeout(() => setMovingAll(false), 2500);
  };

  const digits = String(shop?.whatsapp || '').replace(/\D/g, '');
  const categories = (shop?.facets?.categories ?? []).slice(0, 8);

  return (
    <div className="account apage wish-page">
      <nav className="acrumb" aria-label="Breadcrumb">
        <Link to={`/${slug}/account`}>Account</Link>
        <span aria-hidden="true">›</span>
        <span>Wishlist</span>
      </nav>

      {/* Wishlist Header Banner */}
      <header className="wish-header">
        <div className="wish-header-main">
          <div className="wish-title-group">
            <div className="wish-title-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
              </svg>
            </div>
            <div>
              <h1 className="pagetitle">My Wishlist</h1>
              <p className="wish-subtitle">
                {hearts.length === 0
                  ? 'Items you have saved to shop later'
                  : `${hearts.length} saved ${hearts.length === 1 ? 'item' : 'items'} · ${inStockCount} available to order`}
              </p>
            </div>
          </div>

          {ready.length > 1 && (
            <button
              type="button"
              className="wish-move-all-btn"
              onClick={handleMoveAll}
              disabled={movingAll}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5.3 8.2h13.4l1.2 11.4a1.7 1.7 0 0 1-1.7 1.9H5.8a1.7 1.7 0 0 1-1.7-1.9Z" strokeLinejoin="round" />
                <path d="M8.7 8.2V6.6a3.3 3.3 0 0 1 6.6 0v1.6" strokeLinecap="round" />
              </svg>
              <span>{movingAll ? 'Added in-stock items to bag ✓' : 'Move in-stock to bag'}</span>
            </button>
          )}
        </div>

        {hearts.length > 2 && (
          <div className="wish-filters-bar">
            <div className="wish-filter-tabs">
              <button
                type="button"
                className={`wish-tab ${stockFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => setStockFilter('ALL')}
              >
                All items <span className="tab-pill">{hearts.length}</span>
              </button>
              <button
                type="button"
                className={`wish-tab ${stockFilter === 'IN_STOCK' ? 'active' : ''}`}
                onClick={() => setStockFilter('IN_STOCK')}
              >
                In stock <span className="tab-pill in-stock-pill">{inStockCount}</span>
              </button>
              {soldOutCount > 0 && (
                <button
                  type="button"
                  className={`wish-tab ${stockFilter === 'SOLD_OUT' ? 'active' : ''}`}
                  onClick={() => setStockFilter('SOLD_OUT')}
                >
                  Sold out <span className="tab-pill">{soldOutCount}</span>
                </button>
              )}
            </div>

            {hearts.length > 4 && (
              <div className="wish-search-box">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                  type="text"
                  placeholder="Filter wishlist..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Filter wishlist"
                />
                {search && (
                  <button type="button" className="clear-search" onClick={() => setSearch('')} aria-label="Clear filter">
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </header>

      {said ? <p className="refused" role="alert">{said}</p> : null}

      {/* Wishlist Grid or Empty State */}
      {hearts.length === 0 ? (
        <div className="wish-empty-wrap">
          <div className="wish-empty-art">
            <EmptyWishlist />
          </div>
          <h2>Your wishlist is empty</h2>
          <p>Tap the heart icon on any item you love to save it here for later, compare options, or add to bag when you're ready.</p>
          <div className="wish-empty-actions">
            <Link className="go" to={`/${slug}`}>
              Explore our collection
            </Link>
          </div>
          {categories.length > 0 && (
            <div className="wish-category-suggestions">
              <p className="sugg-label">Explore popular departments</p>
              <div className="sugg-chips">
                {categories.map(c => (
                  <Link key={c.value} to={`/${slug}?category=${encodeURIComponent(c.value)}`} className="sugg-chip">
                    {c.label}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : filteredHearts.length === 0 ? (
        <div className="wish-empty-filtered">
          <p>No wishlist items match this filter.</p>
          <button type="button" className="abtn" onClick={() => { setStockFilter('ALL'); setSearch(''); }}>
            Show all items
          </button>
        </div>
      ) : (
        <div className="wish-cards-grid">
          {filteredHearts.map(h => {
            const isAdded = !!addedCodes[h.productCode];
            const waInquiry = digits.length >= 10
              ? `https://wa.me/${digits}?text=${encodeURIComponent(`Hi ${shop?.name || ''}, I liked ${h.title} (${h.productCode}) on my wishlist. Is this available or restocked soon?`)}`
              : null;

            return (
              <article key={h.productCode} className="wish-card">
                <div className="wish-shot-wrap">
                  <Link to={`/${slug}/p/${encodeURIComponent(h.productCode)}${h.variantCode ? `?v=${encodeURIComponent(h.variantCode)}` : ''}`} className="wish-shot-link">
                    {h.imageUrl ? (
                      <img
                        src={sized(h.imageUrl, 540)}
                        onError={orWhole(h.imageUrl)}
                        alt={h.title}
                        loading="lazy"
                        decoding="async"
                        className="wish-shot-img"
                      />
                    ) : (
                      <div className="wish-shot-placeholder" />
                    )}
                  </Link>

                  {/* Stock and Colour Badges */}
                  <div className="wish-badges-row">
                    {h.available ? (
                      <span className="stock-badge in-stock">In stock</span>
                    ) : (
                      <span className="stock-badge sold-out">Sold out</span>
                    )}
                    {h.colour ? (
                      <span className="colour-badge">{h.colour}</span>
                    ) : null}
                  </div>

                  {/* Unheart floating button */}
                  <button
                    type="button"
                    className="wish-unheart-btn"
                    title={`Remove ${h.title} from wishlist`}
                    aria-label={`Remove ${h.title} from wishlist`}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); unheart(h); }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                    </svg>
                  </button>
                </div>

                {/* Card Information */}
                <div className="wish-info">
                  <Link to={`/${slug}/p/${encodeURIComponent(h.productCode)}${h.variantCode ? `?v=${encodeURIComponent(h.variantCode)}` : ''}`} className="wish-title-link">
                    <h2 className="wish-piece-title">{h.title}</h2>
                  </Link>

                  <div className="wish-price-row">
                    {h.price !== null ? (
                      <strong className="wish-price">{money(h.price)}</strong>
                    ) : (
                      <span className="wish-price-na">Price on request</span>
                    )}
                  </div>

                  {/* Quick Action Button */}
                  <div className="wish-actions">
                    {h.available && !(buying && h.buyCode) ? (
                      <Link className="wish-add-btn" to={`/${slug}/p/${encodeURIComponent(h.productCode)}${h.variantCode ? `?v=${encodeURIComponent(h.variantCode)}` : ''}`}>
                        <span>{buying ? 'Choose size' : 'View item'}</span>
                      </Link>
                    ) : h.available ? (
                      <button
                        type="button"
                        className={`wish-add-btn ${isAdded ? 'added' : ''}`}
                        onClick={(e) => handleAdd(h, e)}
                        disabled={isAdded}
                      >
                        {isAdded ? (
                          <>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                            <span>Added to bag!</span>
                          </>
                        ) : (
                          <>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M5.3 8.2h13.4l1.2 11.4a1.7 1.7 0 0 1-1.7 1.9H5.8a1.7 1.7 0 0 1-1.7-1.9Z" strokeLinejoin="round" />
                              <path d="M8.7 8.2V6.6a3.3 3.3 0 0 1 6.6 0v1.6" strokeLinecap="round" />
                            </svg>
                            <span>Add to bag</span>
                          </>
                        )}
                      </button>
                    ) : (
                      <div className="wish-soldout-actions">
                        {waInquiry ? (
                          <a href={waInquiry} target="_blank" rel="noopener noreferrer" className="wish-inquire-btn">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.13h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.21-8.24 8.21Z" />
                            </svg>
                            <span>Ask store</span>
                          </a>
                        ) : (
                          <span className="wish-soldout-badge">Out of stock</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * ── ProfileView: Redesigned luxury profile header, interactive metric tiles & concierge ──
 */
function ProfileView({ slug, shop, me, said, done, asking, setAsking, ending, out, outOthers }) {
  const firstName = (me.name ? String(me.name).trim().split(/\s+/)[0] : null);
  const initial = (me.name || 'You').trim().charAt(0).toUpperCase();
  const digits = String(shop?.whatsapp || '').replace(/\D/g, '');
  const waChatLink = digits.length >= 10
    ? `https://wa.me/${digits}?text=${encodeURIComponent(`Hi ${shop?.name || ''}, I have a question about my account or shopping.`)}`
    : null;
  const grievanceEmail = shop?.grievance?.email;
  const gmailUrl = grievanceEmail
    ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(grievanceEmail)}`
    : null;

  const defaultAddr = me.addresses?.find(a => a.isDefault) || me.addresses?.[0] || null;

  const rows = [
    {
      to: `/${slug}/orders`,
      title: 'Orders & Deliveries',
      sub: me.orders.length ? `${me.orders.length} ${me.orders.length === 1 ? 'order' : 'orders'} placed · Track, cancel or view receipts` : 'Track or view past orders',
      count: me.orders.length,
      icon: ICONS.orders
    },
    ...(shop?.wishlist === false ? [] : [{
      to: `/${slug}/wishlist`,
      title: 'My Wishlist',
      sub: me.hearts.length ? `${me.hearts.length} saved ${me.hearts.length === 1 ? 'item' : 'items'} · Add directly to bag` : 'Items you bookmarked',
      count: me.hearts.length,
      icon: ICONS.heart
    }]),
    {
      to: `/${slug}/addresses`,
      title: 'Saved Delivery Addresses',
      sub: me.addresses.length ? `${me.addresses.length} saved · Ready for instant checkout` : 'Add an address for one-tap checkout',
      count: me.addresses.length,
      icon: ICONS.pin
    }
  ];

  return (
    <div className="account profile-page">
      {/* Profile Hero Header Card */}
      <section className="profile-hero-card">
        <div className="profile-hero-top">
          <div className="profile-avatar-wrap">
            <span className="profile-avatar" aria-hidden="true">{initial}</span>
            <span className="profile-verified-dot" title="WhatsApp Verified" aria-hidden="true">✓</span>
          </div>

          <div className="profile-hero-details">
            <div className="profile-greeting-row">
              <h1>{firstName ? `Hello, ${firstName}` : 'Your Account'}</h1>
              <span className="profile-status-chip">Member</span>
            </div>

            <div className="profile-contact-pills">
              <span className="profile-phone-pill">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#25D366" aria-hidden="true">
                  <path d={WA} />
                </svg>
                <span>{shownPhone(me.phone)}</span>
                <em className="verified-text">WhatsApp Verified</em>
              </span>

              <span className="profile-device-pill">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
                  <line x1="12" y1="18" x2="12.01" y2="18" />
                </svg>
                <span>{me.devices > 1 ? `Active on ${me.devices} devices` : 'Active on this device'}</span>
              </span>
            </div>
          </div>

          <div className="profile-header-actions">
            <button type="button" className="profile-signout-btn" onClick={() => out(false)}>
              Sign out
            </button>
            {me.devices > 1 && (
              <button type="button" className="profile-devices-btn" onClick={() => setAsking(true)}>
                Sign out other devices
              </button>
            )}
          </div>
        </div>
      </section>

      {said ? <p className="refused" role="alert">{said}</p> : null}
      {done ? <p className="said" role="status">{done}</p> : null}
      {asking ? <OthersOut count={me.devices - 1} busy={ending} onCancel={() => setAsking(false)} onConfirm={outOthers} /> : null}

      {/* Quick Interactive Metrics Grid */}
      <section className="profile-metrics-grid" aria-label="Account overview metrics">
        <Link to={`/${slug}/orders`} className="profile-metric-tile orders-tile">
          <div className="metric-tile-header">
            <span className="metric-tile-icon icon-orders" aria-hidden="true">{ICONS.orders}</span>
            <span className="metric-tile-arrow" aria-hidden="true">→</span>
          </div>
          <strong className="metric-tile-val">{me.orders.length}</strong>
          <span className="metric-tile-label">Orders placed</span>
          <small className="metric-tile-sub">Track & deliveries</small>
        </Link>

        {shop?.wishlist !== false && (
          <Link to={`/${slug}/wishlist`} className="profile-metric-tile wishlist-tile">
            <div className="metric-tile-header">
              <span className="metric-tile-icon icon-wish" aria-hidden="true">{ICONS.heart}</span>
              <span className="metric-tile-arrow" aria-hidden="true">→</span>
            </div>
            <strong className="metric-tile-val">{me.hearts.length}</strong>
            <span className="metric-tile-label">Wishlist items</span>
            <small className="metric-tile-sub">Saved favorites</small>
          </Link>
        )}

        <Link to={`/${slug}/addresses`} className="profile-metric-tile addresses-tile">
          <div className="metric-tile-header">
            <span className="metric-tile-icon icon-addr" aria-hidden="true">{ICONS.pin}</span>
            <span className="metric-tile-arrow" aria-hidden="true">→</span>
          </div>
          <strong className="metric-tile-val">{me.addresses.length}</strong>
          <span className="metric-tile-label">Addresses</span>
          <small className="metric-tile-sub">Delivery spots</small>
        </Link>

        {(me.points !== null || me.storeCredit !== null) && (
          <div className="profile-metric-tile rewards-tile">
            <div className="metric-tile-header">
              <span className="metric-tile-icon icon-rewards" aria-hidden="true">★</span>
            </div>
            <strong className="metric-tile-val">
              {me.points !== null ? Number(me.points).toLocaleString('en-IN') : money(me.storeCredit)}
            </strong>
            <span className="metric-tile-label">
              {me.points !== null ? 'Store Points' : 'Store Credit'}
            </span>
            <small className="metric-tile-sub">Usable at checkout</small>
          </div>
        )}
      </section>

      {/* Main Navigation Menu */}
      <nav className="profile-menu-card" aria-label="Account sections">
        <h2 className="profile-section-title">Manage Account</h2>
        <div className="profile-menu-list">
          {rows.map(r => (
            <Link key={r.to} to={r.to} className="profile-menu-row">
              <span className="profile-menu-icon" aria-hidden="true">{r.icon}</span>
              <div className="profile-menu-body">
                <span className="profile-menu-title-line">
                  <b>{r.title}</b>
                  {r.count > 0 && <span className="profile-menu-count">{r.count}</span>}
                </span>
                <small className="profile-menu-sub">{r.sub}</small>
              </div>
              <span className="profile-menu-arrow" aria-hidden="true">›</span>
            </Link>
          ))}
        </div>
      </nav>

      {/* Default Address Spotlight Preview (if configured) */}
      {defaultAddr && (
        <section className="profile-default-addr-card">
          <div className="default-addr-header">
            <div className="default-addr-tag-group">
              <span className="default-addr-badge">Primary delivery address</span>
              {defaultAddr.label && <span className="default-addr-label">{defaultAddr.label}</span>}
            </div>
            <Link to={`/${slug}/addresses`} className="default-addr-edit-link">
              Change address
            </Link>
          </div>
          <div className="default-addr-body">
            {defaultAddr.name && <b>{defaultAddr.name}</b>}
            <p>{defaultAddr.line}</p>
            <small>PIN {defaultAddr.pincode}{defaultAddr.phone ? ` · ${shownPhone(defaultAddr.phone)}` : ''}</small>
          </div>
        </section>
      )}

      {/* Store Concierge & Support Card */}
      <section className="profile-support-card">
        <div className="support-card-text">
          <h2>Need assistance with your orders?</h2>
          <p>Our customer concierge at {shop?.name || 'the store'} is here to help with sizing, fabrics, tracking, and returns.</p>
        </div>
        <div className="support-card-buttons">
          {waChatLink && (
            <a href={waChatLink} target="_blank" rel="noopener noreferrer" className="support-btn wa-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.13h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.21-8.24 8.21Z" />
              </svg>
              <span>Chat on WhatsApp</span>
            </a>
          )}
          {gmailUrl && (
            <a href={gmailUrl} target="_blank" rel="noopener noreferrer" className="support-btn email-btn" title="Open Gmail in new tab">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="20" height="16" x="2" y="4" rx="2"/>
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
              </svg>
              <span>Email store</span>
            </a>
          )}
        </div>
      </section>

      {/* Security & Device Session Card */}
      <footer className="profile-security-card">
        <div className="security-card-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <div className="security-card-content">
          <p>
            <strong>Password-free WhatsApp authentication</strong> · Your session stays safely signed in on this device for 90 days.
          </p>
          <div className="security-signout-row">
            <button type="button" className="drop" onClick={() => out(false)}>Sign out this device</button>
            {me.devices > 1 && (
              <button type="button" className="drop" onClick={() => setAsking(true)}>Sign out {me.devices - 1} other {me.devices === 2 ? 'device' : 'devices'}</button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * One address, new or changed (owner, 29 Oct). Saved through the same rules as the checkout's (who it
 * is for, a full address, a six-digit PIN), so whatever is saved here is offered there as it is.
 */
const LABELS = ['Home', 'Work', 'Other'];
/** The most a customer may keep (services/online-shop/addresses.ts says the same). */
const MOST_ADDRESSES = 8;

/** A house, a briefcase, or a map pin, by what the shopper called the address. */
function PlaceGlyph({ label, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (/home/i.test(label ?? '')) return <svg {...common}><path d="M4 11.2 12 4.5l8 6.7" /><path d="M6 9.8V19.5h12V9.8" /><path d="M10 19.5v-5.2h4v5.2" /></svg>;
  if (/work|office/i.test(label ?? '')) return <svg {...common}><rect x="3.5" y="8" width="17" height="11.5" rx="2" /><path d="M9 8V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v2" /><path d="M3.5 13h17" /></svg>;
  return <svg {...common}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.4" /></svg>;
}

/** The address as saved often ends with its PIN, which the card shows on its own line. For showing only. */
const withoutPin = (line, pincode) => {
  const text = String(line ?? '').trimEnd();
  const pin = String(pincode ?? '');
  if (!pin || !text.endsWith(pin) || text.length === pin.length) return text;
  return text.slice(0, -pin.length).replace(/[\s,-]+$/, '');
};
function AddressForm({ slug, token, me, address, first = false, onDone, onCancel }) {
  const [f, setF] = useState(() => ({
    label: address?.label ?? 'Home',
    name: address?.name ?? me?.name ?? '',
    phone: address?.phone ?? me?.phone ?? '',
    line: address?.line ?? '',
    pincode: address?.pincode ?? '',
    isDefault: address ? address.isDefault : first
  }));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setSaid(null);
    try {
      await saveAddress(slug, token, { ...(address ? { id: address.id } : {}), ...f, pincode: f.pincode.replace(/\D/g, '') });
      await onDone();
    } catch (err) {
      setSaid(err?.message ?? 'That address could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <form className="aform" onSubmit={save}>
      <h3>{address ? 'Change this address' : 'Add a new address'}</h3>
      <div className="alabels" role="radiogroup" aria-label="Save it as">
        {LABELS.map(l => (
          <button key={l} type="button" role="radio" aria-checked={f.label === l} className="achip" onClick={() => set('label')(l)}>{l}</button>
        ))}
      </div>
      <label><span>Full name</span><input value={f.name} onChange={set('name')} autoComplete="name" maxLength={80} required /></label>
      <label><span>Phone number</span><input type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" maxLength={20} /></label>
      <label><span>Address (house, street, area, city)</span><textarea rows={3} value={f.line} onChange={set('line')} autoComplete="street-address" maxLength={500} required /></label>
      <label><span>PIN code</span><input inputMode="numeric" value={f.pincode} onChange={set('pincode')} autoComplete="postal-code" maxLength={6} required /></label>
      <label className="acheck"><input type="checkbox" checked={f.isDefault} onChange={set('isDefault')} disabled={!!address?.isDefault || first} /> Make this my default address</label>
      {address?.isDefault ? <small className="ahint">This is your default address. To change it, set another address as default.</small> : first ? <small className="ahint">Your first address is your default.</small> : null}
      {said ? <p className="refused" role="alert">{said}</p> : null}
      <div className="aformbtns">
        <button type="submit" className="go" disabled={busy}>{busy ? 'Saving…' : 'Save address'}</button>
        <button type="button" className="go quiet" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** The four things an account gives a shopper, said once and the same on every shop. */
const PERKS = [
  { key: 'wish', title: 'Wishlist', line: 'Keep the items you love in one place.', d: 'M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2Z' },
  { key: 'orders', title: 'Order tracking', line: 'Follow every order to your doorstep.', d: 'M12 2.8 20.5 7.4v9.2L12 21.2l-8.5-4.6V7.4ZM3.8 7.6 12 12l8.2-4.4M12 12v9' },
  { key: 'addr', title: 'Saved addresses', line: 'Ready and waiting at checkout.', d: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11ZM12 12.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z' },
  { key: 'fast', title: 'Faster checkout', line: 'Your details, filled in for you.', d: 'M13 2 4 14h7l-1 8 9-12h-7Z' }
];
const WA = 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.6-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2.1 1-2.4c.3-.3.6-.3.8-.3h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.2.1.6-.1 1.1Z';

/** Ten digits from whatever was typed: "+91 98480 11122", "098480 11122" and "9848011122" are one number. */
const tenDigits = (typed) => {
  const d = String(typed ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  return d;
};
const spaced = (ten) => (ten.length === 10 ? `${ten.slice(0, 5)} ${ten.slice(5)}` : ten);

/**
 * Signing in (redesigned 3 Nov, owner's option C): the reasons to have an account and a few of the shop's
 * own pieces beside a sign-in card. On a phone the card comes straight after the heading, so nobody scrolls
 * to sign in; the reasons and the pieces follow. The number, then the one-time code on WhatsApp.
 */
function SignIn({ slug, shop, canSignIn, why, onDone }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('number');   // 'number' -> 'code'
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [picks, setPicks] = useState([]);
  const name = shop?.name || 'the shop';

  useEffect(() => {
    const ac = new AbortController();
    getProducts(slug, { limit: 8 }, { signal: ac.signal })
      .then(res => setPicks((res?.products ?? []).filter(p => p.images?.[0]?.url).slice(0, 4)))
      .catch(() => {});
    return () => ac.abort();
  }, [slug]);

  const ask = async () => {
    setSaid(null);
    const ten = tenDigits(phone);
    if (ten.length !== 10) { setSaid('Enter your 10-digit mobile number.'); return; }
    setBusy(true);
    try {
      await sendCode(slug, ten, undefined, 'SIGNIN');
      setPhone(ten); setStep('code'); setCode('');
    } catch (e) { setSaid(e?.message ?? 'We could not send the OTP. Please try again.'); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setSaid(null); setBusy(true);
    try {
      const out = await checkCode(slug, phone, code);
      holdProof(slug, out?.token);
      await onDone();
    } catch (e) { setSaid(e?.message ?? 'That OTP is not correct.'); setBusy(false); }
  };

  const heroBanner = placed(shop?.banners, 'HOME_TOP')[0]?.imageUrl ?? null;
  const lede = why === 'review' ? 'Sign in with the number you ordered with to review this item.'
    : why === 'heart' ? 'Sign in to save this item to your wishlist.'
    : why === 'addresses' ? 'Sign in to keep your addresses ready for checkout.'
    : 'Your wishlist, orders and saved addresses, together in one place.';

  return (
    <div className="account si">
      <section className="si-card asignin" aria-label="Sign in">
        {heroBanner ? (
          <div className="si-hero"><img src={sized(heroBanner, 900)} onError={orWhole(heroBanner)} alt="" /></div>
        ) : picks.length >= 3 ? (
          <div className="si-hero si-strip">{picks.slice(0, 3).map(p => <img key={p.productCode} src={sized(p.images[0].url, 360)} onError={orWhole(p.images[0].url)} alt="" />)}</div>
        ) : null}

        <div className="si-body">
          <h1>Sign in to {name}</h1>
          <p className="si-lede">{lede}</p>

          {!canSignIn ? (
            <p className="refused">Sign-in is unavailable at the moment. You can still place your order as a guest.</p>
          ) : step === 'number' ? (
            <form className="verify" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
              <label className="si-field">
                <span>Mobile number</span>
                <span className="si-phone">
                  <b aria-hidden="true">+91</b>
                  <input type="tel" inputMode="tel" autoComplete="tel-national" value={phone} onChange={e => setPhone(e.target.value)} placeholder="98480 11122" aria-label="Mobile number" />
                </span>
              </label>
              <button type="submit" className="go" disabled={busy}>{busy ? 'Sending OTP…' : 'Get OTP on WhatsApp'}</button>
            </form>
          ) : (
            <form className="verify" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
              <p className="si-sub">Enter the 6-digit OTP sent to WhatsApp on <b>+91 {spaced(phone)}</b>.</p>
              <label className="si-field">
                <span>OTP</span>
                <input className="si-otp" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="• • • • • •" aria-label="OTP" />
              </label>
              <button type="submit" className="go" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify and sign in'}</button>
              <div className="si-links">
                <button type="button" className="again" disabled={busy} onClick={ask}>Resend OTP</button>
                <button type="button" className="again" disabled={busy} onClick={() => { setStep('number'); setSaid(null); }}>Change number</button>
              </div>
            </form>
          )}
          {said ? <p className="said" role="status">{said}</p> : null}
          <p className="si-note">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="#25D366" aria-hidden="true"><path d={WA} /></svg>
            Password-free and secure. You stay signed in on this device for 90 days.
          </p>
          <Link className="go quiet keepon" to={`/${slug}`}>Continue as guest</Link>

          <ul className="si-perks" aria-label="With an account">
            {PERKS.map(k => (
              <li key={k.key} title={k.line}>
                <span className="si-ico" aria-hidden="true">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d={k.d} /></svg>
                </span>
                {k.title}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

/**
 * The warning before every other device is signed out (3 Nov, owner: "warn and keep this device").
 */
function OthersOut({ count, busy, onCancel, onConfirm }) {
  const stay = useRef(null);
  useEffect(() => {
    stay.current?.focus();
    const esc = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onCancel]);
  return createPortal(
    <div className="confirm" onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="confirmin" role="alertdialog" aria-modal="true" aria-labelledby="othersout-h" aria-describedby="othersout-p">
        <h2 id="othersout-h">Sign out of other devices?</h2>
        <p id="othersout-p">
          {count === 1 ? 'You will be signed out on 1 other device.' : `You will be signed out on ${count} other devices.`}{' '}
          You will stay signed in on this device. To sign in again there, you will need a new OTP on WhatsApp.
        </p>
        <div className="confirmdo">
          <button type="button" ref={stay} className="go quiet" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="go" disabled={busy} onClick={onConfirm}>{busy ? 'Signing out…' : 'Sign out other devices'}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
