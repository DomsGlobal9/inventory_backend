import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { payLinkView, payLinkCheckout, payLinkConfirm } from '../api';
import { openCheckout } from '../razorpay';

/**
 * Pay what is due on one order (20 Nov 2026): the page a shop's payment reminder links to, shop.scaleezy.com/pay/<token>.
 * Shows the shop, the order number and what is left; Pay opens Razorpay's own checkout (the shop's account); paid is
 * then confirmed by asking Razorpay, never from this page. Nothing private is shown.
 */
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export default function PayLinkPage() {
  const { token } = useParams();
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  useEffect(() => {
    const ac = new AbortController();
    payLinkView(token, { signal: ac.signal }).then(setV).catch(e => { if (e?.name !== 'AbortError') setErr(e?.message || 'This payment link is not valid.'); });
    return () => ac.abort();
  }, [token]);

  const pay = async () => {
    setBusy(true); setNote(null);
    try {
      const { checkout } = await payLinkCheckout(token);
      try { await openCheckout(checkout); }
      catch (e) {
        if (e?.unavailable) { setNote('The payment window could not open. Check your internet connection and try again.'); return; }
        if (e?.dismissed) { setNote('No payment was taken. You can pay whenever you are ready.'); return; }
      }
      setNote('Checking your payment…');
      setV(await payLinkConfirm(token));
      setNote(null);
    } catch (e) {
      setNote(e?.message || 'Something went wrong. Please try again in a minute.');
    } finally { setBusy(false); }
  };

  if (err) {
    return (
      <div className="paypage">
        <div className="landed sad"><h1>This link does not work</h1><p>{err}</p></div>
      </div>
    );
  }
  if (!v) return <div className="paypage"><div className="landed"><div className="spin" aria-hidden="true" /><h1>Opening…</h1></div></div>;

  const shop = (
    <div className="plink-shop">
      {v.shop.logoUrl ? <img src={v.shop.logoUrl} alt="" /> : null}
      <span>{v.shop.name}</span>
    </div>
  );

  if (v.state === 'PAID' || v.state === 'NOTHING_DUE') {
    return (
      <div className="paypage" data-plink-state={v.state}>
        {shop}
        <div className="landed">
          <h1>{v.state === 'PAID' ? `${money(v.paid)} paid` : 'Nothing to pay'}</h1>
          <p>Order {v.orderNumber} is fully paid. Thank you.</p>
          {v.paymentId ? <p className="num">Payment {v.paymentId}</p> : null}
        </div>
      </div>
    );
  }
  if (v.state === 'EXPIRED' || v.state === 'CANCELLED') {
    return (
      <div className="paypage" data-plink-state={v.state}>
        {shop}
        <div className="landed sad"><h1>This link has expired</h1><p>Ask {v.shop.name} for a new one. Nothing was taken.</p></div>
      </div>
    );
  }
  return (
    <div className="paypage" data-plink-state={v.state}>
      {shop}
      <p className="plink-note" style={{ marginTop: 0, marginBottom: 14 }}>{v.firstName ? `Hi ${v.firstName}, this` : 'This'} is the balance for your order.</p>
      <div className="plink-rows">
        <div className="plink-row"><span className="k">Order</span><span>{v.orderNumber}</span></div>
        <div className="plink-row"><span className="k">Bill</span><span>{money(v.bill)}</span></div>
        <div className="plink-row"><span className="k">Paid</span><span>{money(v.paid)}</span></div>
        <div className="plink-row total"><span>To pay</span><span data-plink-due>{money(v.due)}</span></div>
      </div>
      <div className="payacts">
        <button type="button" className="go" onClick={pay} disabled={busy}>{busy ? 'Opening…' : `Pay ${money(v.due)}`}</button>
      </div>
      {note ? <p className="plink-note" role="status">{note}</p> : null}
      <p className="plink-note">UPI, card or net banking, by Razorpay. Paid to {v.shop.name}.</p>
    </div>
  );
}
