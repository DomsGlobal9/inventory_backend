import React, { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useParams, Navigate, useLocation, useNavigationType, useNavigate } from 'react-router-dom';
import PayLinkPage from './pages/PayLinkPage';
import { getShop, findLook } from './api';
import ShopHome from './pages/ShopHome';
import ProductPage from './pages/ProductPage';
import LookPage from './pages/LookPage';
import ReelsPage from './pages/ReelsPage';
/*
 * Split off, because most shoppers never open them.
 *
 * Somebody who taps a link in WhatsApp to look at a saree downloads the shop and a product page.
 * The bag, the checkout, the order and the order list are a third of this app and belong to the
 * minority who buy -- and they are fetched the instant one of them is needed, on a connection the
 * shopper has already proved by loading the shop. What arrives first is what they came for.
 */
const BagPage = lazy(() => import('./pages/BagPage'));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage'));
const OrderPage = lazy(() => import('./pages/OrderPage'));
const MyOrdersPage = lazy(() => import('./pages/MyOrdersPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const PaymentPage = lazy(() => import('./pages/PaymentPage'));
const UpiPage = lazy(() => import('./pages/UpiPage'));
import Nav from './components/Nav';
import Footer from './components/Footer';
import Banners, { placed } from './components/Banners';
import Announcement from './components/Announcement';
import { Problem, Say, GridSkeleton } from './components/States';

/**
 * shop.scaleezy.com/<shop>
 *
 * The shop is fetched once here and handed to every page, so moving between the grid, a piece, the
 * bag and the checkout never asks again for the name, the logo, the colours, the banners, the
 * departments or the delivery terms. All of those are the shop's own, and all of them change the
 * moment the shop changes them -- nothing about this page is written for one particular shop.
 */

/** One shop, whichever page of it is being looked at. */
function Shop({ page }) {
  const { slug, code } = useParams();
  const [state, setState] = useState({ loading: true, error: null, shop: null });
  const [nonce, setNonce] = useState(0);

  /*
   * A new page starts at the top. The browser keeps the scroll position across an in-app link, so
   * tapping a fabric or a price chip far down a product page opened the shop already 900px down,
   * past its own filters. Back (POP) is left alone: returning to where you were is the point of it.
   */
  const { pathname } = useLocation();
  const how = useNavigationType();
  useEffect(() => { if (how !== 'POP') window.scrollTo(0, 0); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ac = new AbortController();
    setState({ loading: true, error: null, shop: null });
    getShop(slug, { signal: ac.signal })
      .then(shop => setState({ loading: false, error: null, shop }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, shop: null }); });
    return () => ac.abort();
  }, [slug, nonce]);

  const { shop } = state;

  // The shop's own colour, applied to the whole page rather than passed to every button.
  // A light colour (a yellow, a pastel) gets dark words and a dark tick on it, so they can still be read (17 Nov 2026).
  useEffect(() => {
    const root = document.documentElement;
    if (shop?.accent) {
      root.style.setProperty('--accent', shop.accent);
      const light = isLightColour(shop.accent);
      root.style.setProperty('--accent-ink', light ? '#16181d' : '#ffffff');
      if (light) root.setAttribute('data-accent-light', ''); else root.removeAttribute('data-accent-light');
    }
    return () => { root.style.removeProperty('--accent'); root.style.removeProperty('--accent-ink'); root.removeAttribute('data-accent-light'); };
  }, [shop?.accent]);

  // What a shopper sees in their tabs, in their history, and on their home screen if they save it.
  useEffect(() => {
    if (shop?.name) document.title = shop.name;
  }, [shop?.name]);

  if (state.loading) {
    return (
      <div className="wrap">
        <div className="bar"><div className="row">
          <div className="bone" style={{ width: 34, height: 34, borderRadius: 9 }} />
          <div style={{ flex: 1 }}><div className="bone" style={{ height: 16, width: '50%' }} /></div>
        </div></div>
        <GridSkeleton count={6} />
      </div>
    );
  }

  /*
   * A customer who has just paid must be able to see so, even if the shop closed while they were
   * on Razorpay's page. Every other page of a closed shop says it is closed; this one carries on,
   * in a plain frame, because it is about money already taken.
   */
  if (state.error && (page === 'pay' || page === 'upi') && state.error.kind === 'CLOSED') {
    return (
      <main className="wrap grow">
        <Suspense fallback={<div className="bone" style={{ height: 260, borderRadius: 14, margin: '20px 0' }} />}>
          {page === 'upi' ? <UpiPage shop={null} /> : <PaymentPage shop={null} />}
        </Suspense>
      </main>
    );
  }

  if (state.error) {
    return <div className="wrap"><Problem error={state.error} onRetry={() => setNonce(n => n + 1)} /></div>;
  }

  /*
   * A reel link's page is its own whole screen (17 Nov 2026, "A. Frames"): one piece fills it, as the reel did, so it
   * carries its own slim band (the shop's name, the bag) instead of this bar, and the footer rides at its end. Keyed
   * by the reel, so going from one reel to another starts that one from its first frame.
   */
  if (page === 'look') {
    return <LookPage key={code} slug={slug} code={code} shop={shop} footer={<Footer shop={shop} />}
      announcement={<Announcement slug={slug} announcement={shop.announcement} />} />;
  }

  /*
   * A shop that set a single picture before banners existed keeps it, shown as the one banner. No
   * shop has to go and do anything for its page to carry on looking the way it did.
   */
  const banners = shop.banners?.length
    ? shop.banners
    : (shop.bannerUrl ? [{ imageUrl: shop.bannerUrl, heading: null, subtext: null, link: null }] : []);

  return (
    <>
      {/* Compact everywhere but the front page: searching from a product page has to leave it. */}
      <Announcement slug={slug} announcement={shop.announcement} />
      <Nav shop={shop} compact={page !== 'home'} />

      {page === 'home' ? <Banners slug={slug} banners={placed(banners, 'HOME_TOP')} /> : null}

      <main className="wrap grow">
        {/* The shape of what is coming, not a spinner: these arrive in a few hundred
            milliseconds and a spinner for that long is worse than a quiet pause. */}
        <Suspense fallback={<div className="bone" style={{ height: 320, borderRadius: 14, margin: '20px 0' }} />}>
          {page === 'product' ? <ProductPage slug={slug} shop={shop} />
            : page === 'reels' ? <ReelsPage slug={slug} shop={shop} />
            : page === 'bag' ? <BagPage shop={shop} />
            : page === 'checkout' ? <CheckoutPage shop={shop} />
            : page === 'order' ? <OrderPage shop={shop} />
            : page === 'orders' ? <MyOrdersPage shop={shop} />
            : page === 'account' ? <AccountPage shop={shop} />
            : page === 'wishlist' ? <AccountPage shop={shop} view="wishlist" />
            : page === 'addresses' ? <AccountPage shop={shop} view="addresses" />
            : page === 'pay' ? <PaymentPage shop={shop} />
            : page === 'upi' ? <UpiPage shop={shop} />
            : <ShopHome slug={slug} shop={shop} />}
        </Suspense>
      </main>

      <Footer shop={shop} />
    </>
  );
}

/**
 * /_look/<code>: where a reel's short link lands. The server sends it on to the shop's current address before this app
 * loads; this is the same step for the development server, which has no such route.
 */
function LookRedirect() {
  const { code } = useParams();
  const nav = useNavigate();
  const { search } = useLocation();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    findLook(code, { signal: ac.signal })
      .then(d => nav(`/${d.slug}/look/${encodeURIComponent(code)}${search}`, { replace: true }))
      .catch(e => { if (e?.name !== 'AbortError') setGone(true); });
    return () => ac.abort();
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!gone) return <div className="wrap"><GridSkeleton count={4} /></div>;
  return <div className="wrap"><Say title="This link is not available">The shop may have removed it. Open the shop from its Instagram profile.</Say></div>;
}

/** Somebody who opened shop.scaleezy.com with no shop after it. */
const Root = () => (
  <div className="wrap">
    <Say title="ScaleEzy shops">
      Shops on this address are run by their own owners. Open the link the shop sent you.
    </Say>
  </div>
);

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Root />} />
        <Route path="/:slug" element={<Shop page="home" />} />
        <Route path="/:slug/p/:code" element={<Shop page="product" />} />
        <Route path="/_look/:code" element={<LookRedirect />} />
        <Route path="/pay/:token" element={<PayLinkPage />} />
        <Route path="/:slug/look/:code" element={<Shop page="look" />} />
        <Route path="/:slug/reels" element={<Shop page="reels" />} />
        <Route path="/:slug/bag" element={<Shop page="bag" />} />
        <Route path="/:slug/checkout" element={<Shop page="checkout" />} />
        <Route path="/:slug/orders" element={<Shop page="orders" />} />
        <Route path="/:slug/account" element={<Shop page="account" />} />
        <Route path="/:slug/wishlist" element={<Shop page="wishlist" />} />
        <Route path="/:slug/addresses" element={<Shop page="addresses" />} />
        <Route path="/:slug/order/:token" element={<Shop page="order" />} />
        <Route path="/:slug/pay/:token" element={<Shop page="pay" />} />
        <Route path="/:slug/upi/:token" element={<Shop page="upi" />} />
        {/* Anything else inside a shop is that shop's front page, not a dead end. */}
        <Route path="/:slug/*" element={<Navigate to="." replace />} />
        <Route path="*" element={<Root />} />
      </Routes>
    </BrowserRouter>
  );
}

/** True when dark words (#16181d) read better on this colour than white does: WCAG contrast, whichever is higher. */
export function isLightColour(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return false;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const DARK = 0.0094;   // #16181d
  return (L + 0.05) / (DARK + 0.05) > 1.05 / (L + 0.05);
}
