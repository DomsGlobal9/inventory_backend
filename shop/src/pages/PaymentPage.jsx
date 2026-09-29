import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { paymentStatus, money, askOnWhatsApp } from '../api';
import { emptyBag, clearPlacementKey } from '../bag';

/**
 * shop.scaleezy.com/<shop>/pay/<token> -- "is my payment through?"
 *
 * Where a customer waits between paying in Razorpay and seeing their order. It has its own address
 * so a refresh, a phone that locked, or a UPI app that took them away and brought them back all
 * land somewhere that knows what is happening -- instead of on an empty checkout that invites them
 * to pay again.
 *
 * It only ever REPORTS. Whether the money arrived is decided by the shop asking Razorpay; this page
 * asks the shop, every couple of seconds, and moves on to the order the moment there is one.
 */
export default function PaymentPage({ shop }) {
  const { slug, token } = useParams();
  const nav = useNavigate();
  const [st, setSt] = useState(null);
  const [error, setError] = useState(null);
  const started = useRef(Date.now());

  useEffect(() => {
    let stop = false;
    let timer = null;
    const ac = new AbortController();

    const ask = async () => {
      try {
        const now = await paymentStatus(slug, token, { signal: ac.signal });
        if (stop) return;
        setSt(now);
        setError(null);
        if (now.state === 'PAID' && now.orderToken) {
          // Paid: the bag has become an order, so it is emptied -- only now, never before.
          emptyBag(slug);
          clearPlacementKey(slug);
          nav(`/${slug}/order/${now.orderToken}`, { replace: true });
          return;
        }
        if (now.state !== 'WAITING') return; // settled one way or the other: nothing more to ask
      } catch (e) {
        if (e?.name === 'AbortError' || stop) return;
        setError(e);
      }
      // Quickly at first -- most confirmations land within seconds -- then gently, for a UPI
      // approval that is sitting on somebody's other phone.
      const waited = Date.now() - started.current;
      timer = setTimeout(ask, waited < 60_000 ? 2000 : 6000);
    };
    ask();
    return () => { stop = true; ac.abort(); if (timer) clearTimeout(timer); };
  }, [slug, token, nav]);

  const ask = askOnWhatsApp(shop?.whatsapp, shop?.name, null);

  if (!st && !error) {
    return (
      <div className="paypage">
        <div className="landed"><div className="spin" aria-hidden="true" /><h1>Checking your payment…</h1></div>
      </div>
    );
  }

  if (!st && error) {
    return (
      <div className="paypage">
        <div className="landed sad">
          <h1>We could not check just now</h1>
          <p>{error.message} If money was taken, the shop will confirm your order or return it automatically.</p>
        </div>
        <div className="payacts"><Link className="go quiet" to={`/${slug}`}>Go to the shop</Link></div>
      </div>
    );
  }

  const amount = money(st.amount, shop?.currency ?? 'INR');

  if (st.state === 'WAITING') {
    return (
      <div className="paypage">
        <div className="landed">
          <div className="spin" aria-hidden="true" />
          <h1>Waiting for your payment</h1>
          <p>
            {st.lastFailReason
              ? `The last try did not go through: ${st.lastFailReason} You can try again from your bag.`
              : `As soon as ${amount} is confirmed, your order appears here. If you approved it in a UPI app, it can take a minute.`}
          </p>
        </div>
        <div className="payacts">
          <Link className="go quiet" to={`/${slug}/checkout`}>Back to checkout</Link>
        </div>
        <p className="paynote">You can close this page. If the payment goes through, the shop confirms your order on WhatsApp.</p>
      </div>
    );
  }

  if (st.state === 'RETURNED') {
    return (
      <div className="paypage">
        <div className="landed sad">
          <h1>Your money is going back</h1>
          <p>{st.message}</p>
          <p>
            {st.refund === 'DONE'
              ? `${amount} has been refunded to how you paid. Banks usually take 5–7 working days to show it.`
              : st.refund === 'SHOP_WILL_CALL'
                ? 'The automatic refund could not go through, so the shop will contact you to return it.'
                : `${amount} is on its way back to how you paid.`}
          </p>
        </div>
        <div className="payacts">
          <Link className="go" to={`/${slug}`}>Back to the shop</Link>
          {ask ? <a className="go quiet" href={ask} target="_blank" rel="noopener noreferrer">Ask the shop on WhatsApp</a> : null}
        </div>
      </div>
    );
  }

  // NOT_PAID: nothing was taken, and the bag is still theirs.
  return (
    <div className="paypage">
      <div className="landed sad">
        <h1>No payment was taken</h1>
        <p>{st.message}</p>
      </div>
      <div className="payacts">
        <Link className="go" to={`/${slug}/checkout`}>Try again</Link>
        <Link className="go quiet" to={`/${slug}/bag`}>See your bag</Link>
      </div>
    </div>
  );
}
