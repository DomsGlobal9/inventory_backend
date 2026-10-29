import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getOrder, cancelOrder, money, askOnWhatsApp } from '../api';
import { Problem, Say } from '../components/States';
import { Landed } from '../components/Motion';
import { becomeSignedIn } from '../account';
import { sized, orWhole, THUMB } from '../photo';

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
  PACKED: { title: 'Your order is packed', note: 'It leaves the shop with the courier soon.' },
  PART_PACKED: { title: 'Part of your order is packed', note: 'The rest follows shortly.' },
  PART_SENT: { title: 'Part of your order is on its way', note: 'The rest follows shortly.' },
  SENT: { title: 'Your order is on its way', note: 'The shop has sent it.' },
  OUT_FOR_DELIVERY: { title: 'Your order arrives today', note: 'It is out for delivery.' },
  DELIVERED: { title: 'Your order was delivered', note: 'We hope you love it.' },
  TROUBLE: { title: 'There is a problem with your delivery', note: 'The shop will be in touch. You can also ask them below.' },
  CANCELLED: { title: 'This order was cancelled', note: 'Nothing is owed. Ask the shop if this is a surprise.' }
};

/*
 * One parcel, in the customer's words (stage from services/online-shop/tracking). The courier's name
 * is not shown: Logistics chooses it, and the tracking number and page are what a customer can use.
 */
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
function parcelWords(p) {
  switch (p.stage) {
    case 'PACKED': return { title: 'Packed', note: 'The tracking number shows here once the courier has it.' };
    case 'BOOKED': return { title: 'Packed', note: 'The courier collects it soon.' };
    case 'ON_ITS_WAY': return { title: 'On its way' };
    case 'OUT_FOR_DELIVERY': return { title: 'Out for delivery today' };
    case 'MISSED': return { title: 'Delivery attempt missed', note: 'The courier will try again. If you will not be in, ask the shop.' };
    case 'DELIVERED': return { title: p.deliveredAt ? `Delivered on ${dayOf(p.deliveredAt)}` : 'Delivered' };
    case 'RETURNING': return { title: 'Going back to the shop', note: 'It could not be delivered. The shop will be in touch.' };
    case 'PROBLEM': return { title: 'A problem with this parcel', note: 'The shop will be in touch.' };
    case 'REARRANGING': return { title: 'Being booked again', note: 'The shop is arranging the courier again.' };
    default: return { title: 'On its way' };
  }
}
/** Worth a line of its own: more than one parcel, a number or page to track, or something to say. */
const worthShowing = (parcels) => parcels.length > 1
  || parcels.some(p => p.trackingNumber || p.trackingUrl || !['ON_ITS_WAY', 'DELIVERED'].includes(p.stage));

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
  const [copied, setCopied] = useState(null);

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

  /*
   * A guest who proved their number at the checkout lands here holding that proof: it becomes a
   * sign-in (90 days), so their orders, addresses and hearts are there next time without asking.
   * Quiet either way; nothing on this page waits for it.
   */
  useEffect(() => { if (shop?.accounts !== false) void becomeSignedIn(slug); }, [slug, shop?.accounts]);

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

  /*
   * "Nothing is owed" is the right thing to say about a cancelled order paid on delivery, and the
   * wrong thing entirely to somebody who paid online -- they are owed their money, and it is being
   * returned automatically. Said plainly, so they do not ring the shop to ask.
   */
  const refunding = o.state === 'CANCELLED' && o.paid && o.payWay === 'ONLINE';
  const said = refunding
    ? { title: 'This order was cancelled', note: 'Your payment is being refunded to how you paid. Banks usually take 5–7 working days to show it.' }
    : (STATES[o.state] ?? STATES.PLACED);
  const trouble = o.state === 'TROUBLE';
  const ask = askOnWhatsApp(shop?.whatsapp, shop?.name, null);
  const when = new Date(o.placedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  /*
   * Where it has got to, in the three steps a customer actually asks about. Taken from the order's
   * own state rather than kept separately -- the shop dispatching from the Orders screen is what
   * moves this, with nothing else to remember to update.
   */
  const pr = o.progress ?? { packed: false, moving: false, delivered: !!o.delivered };
  const steps = [
    { label: 'Placed', done: true },
    { label: 'Packed', done: pr.packed },
    { label: 'On its way', done: pr.moving },
    { label: 'Delivered', done: pr.delivered }
  ];
  const parcels = o.parcels ?? [];
  const copyNumber = async (n) => {
    try { await navigator.clipboard.writeText(n); setCopied(n); } catch { /* the number is on screen anyway */ }
  };

  // A courier page that cannot take the number in its link opens with the number already copied.
  const track = async (p) => {
    if (p.copyNumber && p.trackingNumber) {
      try { await navigator.clipboard.writeText(p.trackingNumber); setCopied(p.trackingNumber); } catch { /* the number is on screen anyway */ }
    }
    window.open(p.trackingUrl, '_blank', 'noopener');
  };

  const pieces = o.items.reduce((t, i) => t + i.quantity, 0);

  /*
   * One narrow receipt, read top to bottom (29 Oct): where the order is, what was bought and what
   * it came to, then where it goes and what can be done. It was a wide page with a two-column body,
   * and one bought piece left most of the left side empty beside a tall column holding everything.
   */
  return (
    <div className="orderpage">
      <section className={`ohead landed ${o.state === 'CANCELLED' || trouble ? 'sad' : ''}`}>
        <div className="otop">
          <div className="tick">
            {o.state === 'CANCELLED' ? (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M8 8l8 8M16 8l-8 8" strokeLinecap="round" />
              </svg>
            ) : trouble ? (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 7v6" strokeLinecap="round" /><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none" />
              </svg>
            ) : <Landed />}
          </div>
          <div className="osaid">
            <h1>{said.title}</h1>
            <p>{said.note}</p>
          </div>
          <div className="oref">
            <p className="num">{o.orderNumber}</p>
            <p className="when">Placed on {when}</p>
          </div>
        </div>

        {o.state !== 'CANCELLED' && (
          <div className="track" aria-label="Where your order has got to">
            {steps.map(st => <div key={st.label} data-done={st.done}><i />{st.label}</div>)}
          </div>
        )}

        {/* Each parcel: where it is, and its tracking number and page once Logistics has them. */}
        {o.state !== 'CANCELLED' && parcels.length > 0 && worthShowing(parcels) && (
          <div className="parcels" aria-label="Tracking">
            {parcels.map((p, n) => {
              const w = parcelWords(p);
              return (
                <div key={n} className="parcel" data-stage={p.stage}>
                  <span>
                    <b>{parcels.length > 1 ? `Parcel ${n + 1} of ${parcels.length}: ` : ''}{w.title}</b>
                    {w.note ? <span className="awb">{w.note}</span> : null}
                    {p.trackingNumber ? (
                      <span className="awb">
                        Tracking number <span className="awbno">{p.trackingNumber}</span>
                        <button type="button" className="copyno" onClick={() => copyNumber(p.trackingNumber)}>
                          {copied === p.trackingNumber ? 'Copied' : 'Copy'}
                        </button>
                      </span>
                    ) : null}
                  </span>
                  {p.trackingUrl ? <button type="button" className="go quiet" onClick={() => track(p)}>Track</button> : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card obill bill">
        {/* Pieces, not lines. Two of one colour and one of another is three pieces, and
            counting the lines said "2 pieces" on the confirmation for an order the checkout
            had just called "3 pieces" -- which reads like something was dropped on the way,
            at the exact moment a customer is checking that it was not. */}
        <h2>{pieces === 1 ? '1 piece' : `${pieces} pieces`}</h2>
        <ul className="baglines flat">
          {o.items.map((i, n) => (
            <li key={`${i.variantCode}-${n}`}>
              <span className="shot">
                {i.imageUrl ? <img src={sized(i.imageUrl, THUMB)} onError={orWhole(i.imageUrl)} alt="" loading="lazy" decoding="async" /> : null}
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

        <h3 className="osub">What it came to</h3>
        <dl>
          <div><dt>Pieces</dt><dd>{money(o.goods)}</dd></div>
          {o.saved > 0 ? <div className="good"><dt>You saved</dt><dd>−{money(o.saved)}</dd></div> : null}
          <div><dt>Delivery</dt><dd>{o.delivery > 0 ? money(o.delivery) : <span className="good">Free</span>}</dd></div>
          <div className="sum"><dt>Total</dt><dd>{money(o.total)}</dd></div>
        </dl>

        {/* The line a customer opens this page to read. */}
        <div className="due">
          <span>
            {refunding ? 'Being refunded' : o.paid ? 'Paid in full' : o.paidOnDelivery ? 'Paid on delivery' : o.payWay === 'ON_DELIVERY' ? 'Have this ready' : 'Still to pay'}
            <span>{refunding ? 'Going back to how you paid' : (o.paid || o.paidOnDelivery) ? 'Nothing more to pay' : o.payWay === 'ON_DELIVERY' ? 'Cash on Delivery (COD): cash or UPI' : ''}</span>
          </span>
          <b>{money(o.total)}</b>
        </div>
      </section>

      <div className="ogrid">
        <section className="card goesto">
          <h3>Going to</h3>
          <p><b>{o.name}</b></p>
          <p>{o.address}</p>
          {o.phone ? <p>{o.phone}</p> : null}
        </section>

        <section className="card ohelp bill">
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
                <p>
                  {/* Paid online, the customer IS owed something: their money, and they should know it comes back by itself. */}
                  {o.paid && o.payWay === 'ONLINE'
                    ? `Cancel ${o.orderNumber}? Your ${money(o.total)} goes back to how you paid, by itself — banks usually take 5–7 working days to show it.`
                    : `Cancel ${o.orderNumber}? The shop puts everything back and nothing is owed.`}
                </p>
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
        </section>
      </div>
    </div>
  );
}
