import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getOrder, money } from '../api';
import { Say } from '../components/States';

/**
 * The orders placed from this phone, at this shop.
 *
 * There is no account, so this is not "your orders" in the sense a big site means it -- it is the
 * links this browser has kept. That is the honest thing to offer: somebody who ordered from their
 * husband's phone will not find it here, and the link in their WhatsApp still works. Said plainly
 * on the page rather than left to be discovered.
 *
 * Each one is re-read from the shop, so a row cannot claim an order is still coming when the shop
 * has already sent it or the customer has called it off.
 */

const SAID = {
  PLACED: 'Being got ready', PART_SENT: 'Partly on its way', SENT: 'On its way', CANCELLED: 'Cancelled'
};

function kept(slug) {
  try { return JSON.parse(window.localStorage.getItem(`scaleezy.orders.${slug}`) ?? '[]'); }
  catch { return []; }
}

export default function MyOrdersPage({ shop }) {
  const { slug } = useParams();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    const held = kept(slug);
    if (!held.length) { setRows([]); return; }
    let alive = true;
    Promise.all(held.map(o =>
      getOrder(slug, o.token).catch(() => null)
    )).then(list => {
      if (!alive) return;
      // An order the shop can no longer find (a shop that deleted it, a link from another shop)
      // is dropped rather than shown as a broken row.
      setRows(list.filter(Boolean));
    });
    return () => { alive = false; };
  }, [slug]);

  if (rows === null) return <div className="bone" style={{ height: 200, borderRadius: 14, margin: '20px 0' }} />;

  if (!rows.length) {
    return (
      <Say title="No orders from this phone yet"
        action={<Link className="go" style={{ display: 'inline-flex', flex: '0 0 auto' }} to={`/${slug}`}>Have a look around</Link>}>
        Orders you place here are kept on this phone. If you ordered from another phone, open the
        link {shop?.name || 'the shop'} sent you on WhatsApp.
      </Say>
    );
  }

  return (
    <div className="myorders">
      <h1 className="pagetitle">Your orders</h1>
      <ul className="orderlist">
        {rows.map(o => (
          <li key={o.token}>
            <Link to={`/${slug}/order/${o.token}`}>
              <div className="thumbs">
                {o.items.slice(0, 3).map((i, n) => (
                  <span key={n} className="shot">
                    {i.imageUrl ? <img src={i.imageUrl} alt="" loading="lazy" decoding="async" /> : null}
                  </span>
                ))}
                {o.items.length > 3 ? <span className="more">+{o.items.length - 3}</span> : null}
              </div>
              <div className="what">
                <h2>{o.orderNumber}</h2>
                <p className="of">
                  {new Date(o.placedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                  {' · '}
                  {o.items.length === 1 ? '1 piece' : `${o.items.length} pieces`}
                </p>
                <p className="state" data-state={o.state}>{SAID[o.state] ?? 'Placed'}</p>
              </div>
              <div className="cash"><b>{money(o.total)}</b></div>
            </Link>
          </li>
        ))}
      </ul>
      <p className="tiny" style={{ paddingBottom: 30 }}>
        These are the orders placed from this phone. Anything ordered elsewhere is in the link the
        shop sent you.
      </p>
    </div>
  );
}
