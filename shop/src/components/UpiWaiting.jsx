import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { upiStatus, money } from '../api';
import { keptBagTokens, forgetKeptBag, putKeptBagBack } from '../bag';

/**
 * On the bag and checkout pages (26 Nov 2026): a UPI order this browser left unfinished.
 *
 * The bag is emptied the moment a UPI order is placed (its pieces are held for it), so a shopper who leaves the QR
 * page by the phone's back button lands on an empty bag while the order still holds their pieces. This says so, with
 * the two ways on: finish paying, or pay another way (which lets the order go and puts the pieces back). An order
 * whose time ran out offers the pieces back. Paid or being checked: forgotten, nothing shown.
 *
 * Also carries the one-line note the QR page leaves when it sends the shopper here ("...back in your bag").
 */
export default function UpiWaiting({ slug, compact = false }) {
  const location = useLocation();
  const note = compact ? null : (location.state?.upiNote ?? null);
  const [orders, setOrders] = useState([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stop = false;
    (async () => {
      const found = [];
      for (const token of keptBagTokens(slug)) {
        try {
          const st = await upiStatus(slug, token);
          if (st.state === 'AWAITING' || st.state === 'EXPIRED' || st.state === 'CANCELLED') found.push({ token, st });
          else forgetKeptBag(slug, token);            // paid, being checked, or not found by the shop: not the bag's business
        } catch (e) {
          if (/could not be found/i.test(e?.message ?? '')) forgetKeptBag(slug, token);
        }
      }
      if (!stop) setOrders(found);
    })();
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; window.clearInterval(t); };
  }, [slug, location.key]);   // asked again on every page change: it may have been paid or let go meanwhile

  const putBack = (token) => {
    putKeptBagBack(slug, token);
    setOrders(o => o.filter(x => x.token !== token));
  };

  const waiting = orders.filter(o => o.st.state === 'AWAITING' && new Date(o.st.expiresAt).getTime() > now);
  const lapsed = orders.filter(o => !waiting.includes(o));
  if (!note && !orders.length) return null;

  // Every other page: one slim line under the header, the newest waiting order only.
  if (compact) {
    const o = waiting[waiting.length - 1];
    if (!o) return null;
    const left = Math.max(0, new Date(o.st.expiresAt).getTime() - now);
    const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    return (
      <div className="upiwait-bar" role="status">
        <span>A UPI order ({money(o.st.amount, 'INR')}) is waiting for payment · <b>{mm}:{ss}</b> left</span>
        <Link to={`/${slug}/upi/${o.token}`}>Finish paying</Link>
      </div>
    );
  }

  return (
    <div className="upiwaits">
      {note ? <p className="upiwait-note" role="status">{note}</p> : null}
      {waiting.map(({ token, st }) => {
        const left = Math.max(0, new Date(st.expiresAt).getTime() - now);
        const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
        return (
          <div key={token} className="upiwait" role="status">
            <p><b>A UPI order is waiting for payment</b></p>
            <p>Order {st.orderNumber} · {money(st.amount, 'INR')}. Its pieces are kept for you for <b>{mm}:{ss}</b>.</p>
            <div className="upiwait-row">
              <Link className="go" to={`/${slug}/upi/${token}`}>Finish paying</Link>
              <Link className="go quiet" to={`/${slug}/upi/${token}?another=1`}>Pay another way</Link>
            </div>
          </div>
        );
      })}
      {lapsed.map(({ token, st }) => (
        <div key={token} className="upiwait" role="status">
          <p><b>Your UPI order {st.orderNumber} was not completed</b></p>
          <p>{st.state === 'CANCELLED' ? 'It was cancelled, so its pieces went back on sale.' : 'No payment reached the shop in time, so its pieces went back on sale.'}</p>
          <div className="upiwait-row">
            <button type="button" className="go" onClick={() => putBack(token)}>Put the pieces back in my bag</button>
            <button type="button" className="go quiet" onClick={() => { forgetKeptBag(slug, token); setOrders(o => o.filter(x => x.token !== token)); }}>Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}
