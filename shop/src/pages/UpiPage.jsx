import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { upiStatus, upiPaid, upiPayAnotherWay, money } from '../api';
import { hasKeptBag, putKeptBagBack, forgetKeptBag } from '../bag';

/**
 * shop.scaleezy.com/<shop>/upi/<order> -- pay by UPI straight to the shop (26 Nov 2026, PLAN-upi-mockups.html).
 *
 * The order is already placed and its pieces held. Here the shopper pays the exact amount (QR on a laptop, their UPI
 * app on a phone) and types the 12-digit reference their app shows; the shop checks its bank and confirms. The page
 * has its own address so a UPI app that took them away and brought them back lands where they were.
 *
 *   AWAITING      the QR, the app button, the reference box, and how long the pieces are kept
 *   TO_CHECK      "Order placed: the shop is checking your payment"
 *   RECEIVED      "Paid. Thank you!"
 *   NOT_RECEIVED  the shop could not find it: check the app, or message the shop
 *   EXPIRED / CANCELLED  not completed; if money left the account, message the shop
 */
/**
 * How to reach the shop about this order (owner, 26 Nov 2026): WhatsApp with the order already written, a call, an
 * email. Only what the shop has given; nothing at all when it has given none (or the shop is closed: no details then).
 */
function ContactShop({ shop, st }) {
  const wa = String(shop?.whatsapp || '').replace(/\D/g, '');
  const tel = String(shop?.grievance?.phone || shop?.whatsapp || '').replace(/[^\d+]/g, '');
  const mail = shop?.grievance?.email || null;
  const about = `about my order ${st.orderNumber}: I paid ${money(st.amount, 'INR')} by UPI${st.utr ? ` (reference ${st.utr})` : ''}.`;
  const ways = [
    wa.length >= 10 && { key: 'wa', label: 'WhatsApp', href: `https://wa.me/${wa.length === 10 ? `91${wa}` : wa}?text=${encodeURIComponent(`Hi ${shop?.name || ''}, ${about}`)}`, out: true },
    tel.replace(/\D/g, '').length >= 10 && { key: 'tel', label: 'Call', href: `tel:${tel}` },
    mail && { key: 'mail', label: 'Email', href: `mailto:${mail}?subject=${encodeURIComponent(`Order ${st.orderNumber}`)}&body=${encodeURIComponent(`Hello, ${about}`)}` }
  ].filter(Boolean);
  if (!ways.length) return null;
  return (
    <div className="upicontact">
      <p>Questions about your order? Contact {shop?.name || 'the shop'}:</p>
      <div className="upicontact-ways">
        {ways.map(w => <a key={w.key} className="go quiet" href={w.href} {...(w.out ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{w.label}</a>)}
      </div>
    </div>
  );
}

const isPhone = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export default function UpiPage({ shop }) {
  const { slug, token } = useParams();
  const [st, setSt] = useState(null);
  const [error, setError] = useState(null);
  const [utr, setUtr] = useState('');
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState(null);
  const [now, setNow] = useState(Date.now());
  const busy = useRef(false);
  const nav = useNavigate();
  // "Pay another way" asks first (they may have paid in their UPI app already). Opened straight away when the bag
  // page's "a UPI order is waiting" note sent them here with ?another=1.
  const [params] = useSearchParams();
  const [asking, setAsking] = useState(params.get('another') === '1');
  const [leaving, setLeaving] = useState(false);

  // Asked now, and again every few seconds: the shop's "Payment received" shows here without a refresh.
  useEffect(() => {
    let stop = false;
    const ac = new AbortController();
    const ask = async () => {
      if (busy.current) return;
      try { const s = await upiStatus(slug, token, { signal: ac.signal }); if (!stop) { setSt(s); setError(null); } }
      catch (e) { if (!stop && e?.name !== 'AbortError') setError(e); }
    };
    void ask();
    const t = window.setInterval(ask, 5000);
    const c = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; ac.abort(); window.clearInterval(t); window.clearInterval(c); };
  }, [slug, token]);

  const digits = utr.replace(/\D/g, '').slice(0, 12);
  const shown = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
  const send = async (e) => {
    e?.preventDefault?.();
    if (digits.length !== 12) { setRefused('Type all 12 digits of the UPI reference (UTR) your app shows after paying.'); return; }
    setSending(true); setRefused(null); busy.current = true;
    try { setSt(await upiPaid(slug, token, digits)); }
    catch (err) { setRefused(err?.message ?? 'That did not go through. Please try again.'); }
    finally { setSending(false); busy.current = false; }
  };

  const orderLink = `/${slug}/order/${token}`;

  // Paid or being checked: the kept bag has done its job. Not completed: it stays, for "Put these pieces back".
  useEffect(() => {
    if (st?.state === 'TO_CHECK' || st?.state === 'RECEIVED' || st?.state === 'NOT_RECEIVED') forgetKeptBag(slug, token);
  }, [st?.state, slug, token]);

  const payAnotherWay = async () => {
    setLeaving(true); setRefused(null); busy.current = true;
    try {
      await upiPayAnotherWay(slug, token);
      const back = putKeptBagBack(slug, token);
      nav(back ? `/${slug}/checkout` : `/${slug}/bag`, { replace: true, state: { upiNote: back
        ? 'Your UPI order was cancelled and the pieces are back in your bag. Choose how you would like to pay.'
        : 'Your UPI order was cancelled. Please add the pieces to your bag again.' } });
    } catch (err) {
      setRefused(err?.message ?? 'That did not go through. Please try again.');
      setAsking(false);
      try { setSt(await upiStatus(slug, token)); } catch { /* the poll catches up */ }
    } finally { setLeaving(false); busy.current = false; }
  };
  const putBack = () => {
    const back = putKeptBagBack(slug, token);
    nav(`/${slug}/bag`, { replace: true, state: back ? { upiNote: 'The pieces are back in your bag.' } : undefined });
  };

  if (error && !st) {
    return <div className="upipay"><h1 className="pagetitle">Pay by UPI</h1><p className="refused" role="alert">{error.message ?? 'This page could not be opened. Please try again.'}</p></div>;
  }
  if (!st) return <div className="upipay"><div className="bone" style={{ height: 420, borderRadius: 14 }} /></div>;

  const amount = money(st.amount, 'INR');
  const left = Math.max(0, new Date(st.expiresAt).getTime() - now);
  const mm = String(Math.floor(left / 60000)).padStart(2, '0'), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');

  if (st.state === 'TO_CHECK' || st.state === 'RECEIVED') {
    const paid = st.state === 'RECEIVED';
    return (
      <div className="upipay done">
        <div className="upitick" aria-hidden="true">✓</div>
        <h1 className="pagetitle">{paid ? 'Paid. Thank you!' : 'Thank you!'}</h1>
        <p className="upimeta">{st.orderNumber} · {amount} by UPI{st.utr ? <><br />Reference {st.utr.replace(/(\d{4})(?=\d)/g, '$1 ')}</> : null}</p>
        <p>{paid
          ? 'Your payment has reached the shop and your order is confirmed. The confirmation is on its way to your WhatsApp (and email, if you gave one).'
          : 'We have told the shop about your payment. As soon as they confirm it has arrived, your order confirmation comes to your WhatsApp (and email, if you gave one).'}</p>
        <Link className="go quiet" to={orderLink}>Track my order</Link>
        <ContactShop shop={shop} st={st} />
      </div>
    );
  }
  if (st.state === 'NOT_RECEIVED') {
    return (
      <div className="upipay done">
        <h1 className="pagetitle">The shop could not find your payment</h1>
        <p className="upimeta">{st.orderNumber} · {amount}{st.utr ? ` · reference ${st.utr}` : ''}</p>
        <p>Please check your UPI app. If the money left your account, message the shop with a screenshot and they will sort it out. Your order is kept for 24 hours; after that it is cancelled.</p>
        <Link className="go quiet" to={orderLink}>See my order</Link>
        <ContactShop shop={shop} st={st} />
      </div>
    );
  }
  if (st.state === 'EXPIRED' || st.state === 'CANCELLED') {
    return (
      <div className="upipay done">
        <h1 className="pagetitle">This order was not completed</h1>
        <p className="upimeta">{st.orderNumber} · {amount}</p>
        <p>{st.state === 'CANCELLED'
          ? 'This order was cancelled, so the pieces are no longer kept for you.'
          : 'No UPI Ref. No. was given within 30 minutes, so this order was cancelled and the pieces are no longer kept for you.'}{' '}
          If money did leave your account, message the shop with a screenshot and they will sort it out.</p>
        {hasKeptBag(slug, token) ? <button type="button" className="go" onClick={putBack}>Put these pieces back in my bag</button> : null}
        <Link className="go quiet" to={`/${slug}`}>Back to the shop</Link>
        <ContactShop shop={shop} st={st} />
      </div>
    );
  }

  // AWAITING: pay, then say so.
  const phone = isPhone();
  return (
    <>
    <div className="upiback">
      <button type="button" className="upiback-btn" onClick={() => { setAsking(true); setRefused(null); }} disabled={leaving}>
        <span aria-hidden="true">←</span> Pay another way
      </button>
    </div>
    {asking ? (
      <div className="upiask" role="alertdialog" aria-labelledby="upiask-h">
        <p id="upiask-h"><b>Pay another way?</b> This UPI order is cancelled and the pieces go back to your bag. Already paid? Don&rsquo;t cancel: type the UPI Ref. No. below.</p>
        <div className="upiask-row">
          <button type="button" className="go quiet" onClick={() => setAsking(false)} disabled={leaving}>Stay and pay</button>
          <button type="button" className="go" onClick={payAnotherWay} disabled={leaving}>{leaving ? 'One moment…' : 'Yes, pay another way'}</button>
        </div>
      </div>
    ) : null}
    <form className="upipay upicard" onSubmit={send} noValidate>
      <div className="upihead">
        <p className="upito">Pay {st.payee}</p>
        <p className="upiamount">{amount}</p>
        <p className="upito">Order {st.orderNumber}</p>
      </div>

      <div className="upibody">
        <div className="upiscan">
          {/* On a phone the app button comes first: a QR cannot be scanned by the phone showing it. */}
          {phone ? <a className="go" href={st.link}>Pay {amount} with a UPI app</a> : null}
          <div className="upiqr" aria-label={`QR code to pay ${amount} to ${st.payee}`}>
            <QRCodeSVG value={st.link} size={196} level="M" includeMargin={false} />
          </div>
          <p className="upiid">{st.upiId}</p>
        </div>

        <div className="upiact">
          <ol className="upisteps">
            <li><span>1</span><p><b>Pay {amount}</b> by scanning the QR with GPay, PhonePe, Paytm or any UPI app{phone ? ', or tap the button above' : ''}.</p></li>
            <li><span>2</span><p>Type the 12-digit <b>UPI Ref. No.</b> your app shows after paying. Some apps call it <b>UTR</b> or <b>UPI transaction ID</b>.</p></li>
          </ol>
          <input className="upiutr" inputMode="numeric" autoComplete="off" aria-label="UPI Ref. No., 12 digits"
            placeholder="1234 5678 9012" value={shown} onChange={(e) => setUtr(e.target.value)} />
          {refused ? <p className="refused" role="alert">{refused}</p> : null}
          <button type="submit" className="go" disabled={sending || digits.length !== 12}>{sending ? 'Sending…' : 'I have paid'}</button>
          <p className="upinote">
            {left > 0 ? <>Pay within <b>{mm}:{ss}</b>. Until then, these pieces are kept for you.</> : 'Time is up: this order is being cancelled and the pieces are no longer kept.'}{' '}
            Your order confirmation comes on WhatsApp once the shop sees your payment.
          </p>
        </div>
      </div>
    </form>
    </>
  );
}
