import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useParams, Navigate, Link } from 'react-router-dom';
import { getShop, askOnWhatsApp } from './api';
import ShopHome from './pages/ShopHome';
import ProductPage from './pages/ProductPage';
import Banners from './components/Banners';
import { Problem, Say, GridSkeleton } from './components/States';

/**
 * shop.scaleezy.com/<shop>
 *
 * The shop is fetched once here and handed down, so moving between the grid and a piece does not
 * ask again for the name, the logo, the colours and the banners the page is already showing.
 */

/** The shop's own details, which the law asks it to show on every page. */
function Footer({ shop }) {
  if (!shop) return null;
  const { seller, grievance, returnPolicy } = shop;
  const anything = seller?.name || seller?.address || seller?.gstNumber || grievance?.name || returnPolicy;

  return (
    <footer className="foot">
      <div className="wrap">
        {anything ? (
          <div className="cols">
            {(seller?.name || seller?.address || seller?.gstNumber) && (
              <section>
                <h3>Sold by</h3>
                {seller.name ? <p>{seller.name}</p> : null}
                {seller.address ? <p>{seller.address}</p> : null}
                {seller.gstNumber ? <p>GSTIN: {seller.gstNumber}</p> : null}
              </section>
            )}
            {(grievance?.name || grievance?.phone || grievance?.email) && (
              <section>
                <h3>Any problem? Contact</h3>
                {grievance.name ? <p>{grievance.name}</p> : null}
                {grievance.phone ? <p><a href={`tel:${grievance.phone}`}>{grievance.phone}</a></p> : null}
                {grievance.email ? <p><a href={`mailto:${grievance.email}`}>{grievance.email}</a></p> : null}
              </section>
            )}
            {returnPolicy ? <section><h3>Returns</h3><p>{returnPolicy}</p></section> : null}
          </div>
        ) : null}
        {/* Whose shop this is, so a customer knows the seller is the shop and not ScaleEzy. */}
        <p className="by">{shop.name} · online shop powered by ScaleEzy</p>
      </div>
    </footer>
  );
}

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

  // The title matters: it is what a shopper sees in their tabs and in their history, and what is
  // saved when they add the shop to their home screen.
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

  const ask = askOnWhatsApp(shop.whatsapp, shop.name, null);

  /*
   * Shops that set a single picture before banners existed keep it, shown as the one banner. No
   * shop has to go and do anything for its page to carry on looking the way it did.
   */
  const banners = shop.banners?.length
    ? shop.banners
    : (shop.bannerUrl ? [{ imageUrl: shop.bannerUrl, heading: null, subtext: null, link: null }] : []);

  return (
    <>
      <header className="bar">
        <div className="wrap">
          <div className="row">
            <Link to={`/${slug}`} style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0, flex: 1 }}>
              {shop.logoUrl ? <img className="mark" src={shop.logoUrl} alt="" /> : null}
              <div style={{ minWidth: 0 }}>
                <h1 className="name">{shop.name}</h1>
                <p className="sub">Online shop</p>
              </div>
            </Link>
            {ask ? (
              <a className="icon" href={ask} target="_blank" rel="noopener noreferrer"
                aria-label={`Chat with ${shop.name} on WhatsApp`} title="Chat on WhatsApp">
                <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.13h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.21-8.24 8.21Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.17.24-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.11-.23-.17-.48-.29Z" />
                </svg>
              </a>
            ) : null}
          </div>
        </div>
      </header>

      {page === 'home' ? <Banners slug={slug} banners={banners} /> : null}

      <div className="wrap">
        {page === 'product'
          ? <ProductPage slug={slug} shop={shop} />
          : <ShopHome slug={slug} shop={shop} />}
      </div>
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
        {/* Anything else inside a shop is that shop's front page, not a dead end. */}
        <Route path="/:slug/*" element={<Navigate to="." replace />} />
        <Route path="*" element={<Root />} />
      </Routes>
    </BrowserRouter>
  );
}
