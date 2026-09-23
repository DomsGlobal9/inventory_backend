import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { askOnWhatsApp } from '../api';

/**
 * The bottom of every page: who this shop is, what it sells, and how to reach a person.
 *
 * All of it is the shop's own. The departments are the categories it really sells, the fabrics are
 * the fabrics it really stocks, the address and GSTIN are the ones in its General Info, and the
 * return policy is in its own words. A shop that changes any of those changes this, with nothing
 * to republish.
 *
 * The seller's details and a way to reach them are not decoration: the Consumer Protection
 * (E-Commerce) Rules 2020 require the seller -- which is the shop, not ScaleEzy -- to be
 * identifiable and contactable on the page.
 */
export default function Footer({ shop }) {
  const { slug } = useParams();
  if (!shop) return null;

  const { seller, grievance, returnPolicy, facets } = shop;
  const ask = askOnWhatsApp(shop.whatsapp, shop.name, null);
  const departments = (facets?.categories ?? []).slice(0, 6);
  const fabrics = (facets?.fabrics ?? []).slice(0, 8);

  return (
    <footer className="foot">
      <div className="wrap">
        <div className="cols">
          <section className="who">
            {shop.logoUrl ? <img className="mark" src={shop.logoUrl} alt="" /> : null}
            <h3>{shop.name}</h3>
            {seller?.address ? <p>{seller.address}</p> : null}
            {seller?.gstNumber ? <p>GSTIN: {seller.gstNumber}</p> : null}
            {ask ? (
              <p style={{ marginTop: 10 }}>
                <a className="wa" href={ask} target="_blank" rel="noopener noreferrer">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.13h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.21-8.24 8.21Z" />
                  </svg>
                  Chat with us
                </a>
              </p>
            ) : null}
          </section>

          {departments.length > 1 && (
            <section>
              <h3>Shop</h3>
              <ul>
                {departments.map(c => (
                  <li key={c.value}>
                    <Link to={`/${slug}?category=${encodeURIComponent(c.value)}`}>{c.label}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {fabrics.length > 1 && (
            <section>
              <h3>By fabric</h3>
              <ul>
                {fabrics.map(f => (
                  <li key={f.value}>
                    <Link to={`/${slug}?fabric=${encodeURIComponent(f.value)}`}>{f.value}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(grievance?.name || grievance?.phone || grievance?.email || returnPolicy) && (
            <section>
              <h3>Help</h3>
              {grievance?.name ? <p>{grievance.name}</p> : null}
              {grievance?.phone ? <p><a href={`tel:${grievance.phone}`}>{grievance.phone}</a></p> : null}
              {grievance?.email ? <p><a href={`mailto:${grievance.email}`}>{grievance.email}</a></p> : null}
              {returnPolicy ? <p className="policy">{returnPolicy}</p> : null}
            </section>
          )}
        </div>

        {/* Whose shop this is. The seller is the shop; ScaleEzy only carries the page. */}
        <p className="by">
          Sold by {seller?.name || shop.name}
          {shop.buying?.open ? ' · Orders are taken here' : ''}
          <span> · Shop online with ScaleEzy</span>
        </p>
      </div>
    </footer>
  );
}
