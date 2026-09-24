import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getOrder, cancelOrder, money, askOnWhatsApp } from '../api';
import { Problem, Say } from '../components/States';
import { Landed } from '../components/Motion';

/**
 * The customer's own order.
 *
 * This page is the receipt. It is the only proof a customer has until the box arrives, so it is
 * addressed by a secret the shop generated -- not by the order number, which somebody could count
 * upwards from and read a stranger's name, phone and address.
 *
 * It is also where they come back to. The link goes in their WhatsApp confirmation and is kept on
 * this phone, so "where is my order" is a tap rather than a phone call to the shop.
 */

const STATES = {
  PLACED: { title: 'Your order is placed', note: 'The shop has it and is getting it ready.' },
  PART_SENT: { title: 'Part of your order is on its way', note: 'The rest follows shortly.' },
  SENT: { title: 'Your order is on its way', note: 'The shop has sent it.' },
  CANCELLED: { title: 'This order was cancelled', note: 'Nothing is owed. Ask the shop if this is a surprise.' }
};

/** The orders this phone has placed at this shop, so somebody can find them again. */
function remember(slug, token, orderNumber) {
  try {
    const key = `scaleezy.orders.${slug}`;
    const held = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    if (!held.some(o => o.token === token)) {
      window.localStorage.setItem(key, JSON.stringify([{ token, orderNumber, at: Date.now() }, ...held].slice(0, 20)));
    }
  } catch { /* a browser that will not store: the link in their WhatsApp still works */ }
}

export default function OrderPage({ shop }) {
  const { slug, token } = useParams();
  const [state, setState] = useState({ loading: true, error: null, order: null });
  /* 'no' -> 'asking' -> 'doing'. Asked properly, because a cancelled order cannot be un-cancelled. */
  const [calling, setCalling] = useState('no');
  const [refused, setRefused] = useState(null);

  const load = useCallback((signal) => {
    setState(s => ({ ...s, loading: true, error: null }));
    getOrder(slug, token, { signal })
      .then(order => {
        setState({ loading: false, error: null, order });
        remember(slug, order.token, order.orderNumber);
      })
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, order: null }); });
  }, [slug, token]);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  if (state.loading) return <div className="bone" style={{ height: 260, borderRadius: 14, margin: '20px 0' }} />;

  if (state.error) {
    return (
      <>
        <Problem error={state.error} shopName={shop?.name} onRetry={() => load()} />
        <div style={{ textAlign: 'center', paddingBottom: 40 }}>
          <Link className="go quiet" style={{ display: 'inline-flex' }} to={`/${slug}`}>Go to the shop</Link>
        </div>
      </>
    );
  }

  const o = state.order;
  if (!o) return <Say title="That order could not be found" />;

  const said = STATES[o.state] ?? STATES.PLACED;
  const ask = askOnWhatsApp(shop?.whatsapp, shop?.name, null);
  const when = new Date(o.placedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  /*
   * Where it has got to, in the three steps a customer actually asks about. Taken from the order's
   * own state rather than kept separately -- the shop dispatching from the Orders screen is what
   * moves this, with nothing else to remember to update.
   */
  const steps = [
    { label: 'Placed', done: true },
    { label: 'Packed', done: o.state === 'PART_SENT' || o.state === 'SENT' },
    { label: 'On its way', done: o.state === 'SENT' }
  ];

  return (
    <div className="orderpage">
      <div className={`landed ${o.state === 'CANCELLED' ? 'sad' : ''}`}>
        <div className="tick">
          {o.state === 'CANCELLED' ? (
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M8 8l8 8M16 8l-8 8" strokeLinecap="round" />
            </svg>
          ) : <Landed />}
        </div>
        <h1>{said.title}</h1>
        <p>{said.note}</p>
        <p className="num">{o.orderNumber}</p>
        <p className="when">Placed on {when}</p>
      </div>

      {o.state !== 'CANCELLED' && (
        <div className="track" aria-label="Where your order has got to">
          {steps.map(st => <div key={st.label} data-done={st.done}><i />{st.label}</div>)}
        </div>
      )}

      <div className="orderbody">
        <section className="card">
          {/* Pieces, not lines. Two of one colour and one of another is three pieces, and
              counting the lines said "2 pieces" on the confirmation for an order the checkout
              had just called "3 pieces" -- which reads like something was dropped on the way,
              at the exact moment a customer is checking that it was not. */}
          <h2>{(() => { const n = o.items.reduce((t, i) => t + i.quantity, 0); return n === 1 ? '1 piece' : `${n} pieces`; })()}</h2>
          <ul className="baglines flat">
            {o.items.map((i, n) => (
              <li key={`${i.variantCode}-${n}`}>
                <span className="shot">
                  {i.imageUrl ? <img src={i.imageUrl} alt="" loading="lazy" decoding="async" /> : null}
                </span>
                <div className="what">
                  <h3>{i.title}</h3>
                  <p className="of">
                    {[i.colour, i.size].filter(Boolean).join(' · ')}
                    {i.colourHex ? <i className="swatch" style={{ background: i.colourHex }} aria-hidden="true" /> : null}
                  </p>
                  <p className="of">{i.quantity} × {money(i.unitPrice)}</p>
                </div>
                <div className="cash"><b>{money(i.lineTotal)}</b></div>
              </li>
            ))}
          </ul>
        </section>

        <aside className="bill">
          <h2>What it came to</h2>
          <dl>
            <div><dt>Pieces</dt><dd>{money(o.goods)}</dd></div>
            {o.saved > 0 ? <div className="good"><dt>You saved</dt><dd>−{money(o.saved)}</dd></div> : null}
            <div><dt>Delivery</dt><dd>{o.delivery > 0 ? money(o.delivery) : <span className="good">Free</span>}</dd></div>
            <div className="sum"><dt>Total</dt><dd>{money(o.total)}</dd></div>
          </dl>

          {/* The line a customer opens this page to read. */}
          <div className="due">
            <span>
              {o.paid ? 'Paid in full' : o.payWay === 'ON_DELIVERY' ? 'Have this ready' : 'Still to pay'}
              <span>{o.paid ? 'Nothing more to pay' : o.payWay === 'ON_DELIVERY' ? 'Cash or UPI when it arrives' : ''}</span>
            </span>
            <b>{money(o.total)}</b>
          </div>

          <div className="goesto">
            <h3>Going to</h3>
            <p><b>{o.name}</b></p>
            <p>{o.address}</p>
            {o.phone ? <p>{o.phone}</p> : null}
          </div>

          {ask ? (
            <a className="go quiet" href={ask} target="_blank" rel="noopener noreferrer">
              Ask {shop?.name || 'the shop'} about this order
            </a>
          ) : null}
          <Link className="go quiet" to={`/${slug}`}>Keep shopping</Link>

          {/*
            Calling it off, while it is still sitting at the shop. Offered rather than hidden: a
            customer who cannot cancel rings the shop, and the shop cancels it anyway -- with the
            stock held in between. Once any of it has been sent this is a return, which is a
            conversation, so the button goes and the chat stays.
          */}
          {o.mayCancel && (
            calling === 'asking' ? (
              <div className="callingoff">
                <p>Cancel {o.orderNumber}? The shop puts everything back and nothing is owed.</p>
                {refused ? <p className="refused">{refused}</p> : null}
                <div className="row">
                  <button type="button" className="go quiet" onClick={() => { setCalling('no'); setRefused(null); }}>
                    Keep it
                  </button>
                  <button type="button" className="go danger" onClick={async () => {
                    setCalling('doing');
                    try {
                      const after = await cancelOrder(slug, token);
                      setState({ loading: false, error: null, order: after });
                      setCalling('no');
                    } catch (err) {
                      setRefused(err?.message ?? 'That could not be cancelled. Message the shop.');
                      setCalling('asking');
                    }
                  }}>Yes, cancel it</button>
                </div>
              </div>
            ) : (
              <button type="button" className="drop wide" disabled={calling === 'doing'}
                onClick={() => setCalling('asking')}>
                {calling === 'doing' ? 'Cancelling…' : 'Cancel this order'}
              </button>
            )
          )}

          <p className="tiny">Keep this link — it is how you check on your order.</p>
        </aside>
      </div>
    </div>
  );
}
