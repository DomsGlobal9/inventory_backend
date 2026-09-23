import React, { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useParams, Navigate } from 'react-router-dom';
import { getShop } from './api';
import ShopHome from './pages/ShopHome';
import ProductPage from './pages/ProductPage';
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
import Nav from './components/Nav';
import Footer from './components/Footer';
import Banners from './components/Banners';
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
  const { slug } = useParams();
  const [state, setState] = useState({ loading: true, error: null, shop: null });
  const [nonce, setNonce] = useState(0);

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
  useEffect(() => {
    if (shop?.accent) document.documentElement.style.setProperty('--accent', shop.accent);
    return () => document.documentElement.style.removeProperty('--accent');
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

  if (state.error) {
    return <div className="wrap"><Problem error={state.error} onRetry={() => setNonce(n => n + 1)} /></div>;
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
      <Nav shop={shop} compact={page !== 'home'} />

      {page === 'home' ? <Banners slug={slug} banners={banners} /> : null}

      <main className="wrap grow">
        {/* The shape of what is coming, not a spinner: these arrive in a few hundred
            milliseconds and a spinner for that long is worse than a quiet pause. */}
        <Suspense fallback={<div className="bone" style={{ height: 320, borderRadius: 14, margin: '20px 0' }} />}>
          {page === 'product' ? <ProductPage slug={slug} shop={shop} />
            : page === 'bag' ? <BagPage shop={shop} />
            : page === 'checkout' ? <CheckoutPage shop={shop} />
            : page === 'order' ? <OrderPage shop={shop} />
            : page === 'orders' ? <MyOrdersPage shop={shop} />
            : <ShopHome slug={slug} shop={shop} />}
        </Suspense>
      </main>

      <Footer shop={shop} />
    </>
  );
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
        <Route path="/:slug/bag" element={<Shop page="bag" />} />
        <Route path="/:slug/checkout" element={<Shop page="checkout" />} />
        <Route path="/:slug/orders" element={<Shop page="orders" />} />
        <Route path="/:slug/order/:token" element={<Shop page="order" />} />
        {/* Anything else inside a shop is that shop's front page, not a dead end. */}
        <Route path="/:slug/*" element={<Navigate to="." replace />} />
        <Route path="*" element={<Root />} />
      </Routes>
    </BrowserRouter>
  );
}
