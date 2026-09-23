import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { priceBag, money } from '../api';
import { useBag, setQuantity, removeFromBag } from '../bag';
import { Say, Problem } from '../components/States';
import { EmptyBag, Toward } from '../components/Motion';

/**
 * The bag.
 *
 * What is in it lives in the shopper's browser; what it COSTS is worked out by the shop, every
 * time, from its own prices, its own offers and its own delivery terms. Nothing on this page is
 * arithmetic done here -- if it were, the day a shop set up "10% off silk" this page would show
 * one figure and the checkout another, and the customer would be right to walk away.
 *
 * That also means the bag tells the truth about a piece that sold out, or came off sale, while it
 * sat here. The shop says so by name, and the shopper can take it out and carry on.
 */
export default function BagPage({ shop }) {
  const { slug } = useParams();
  const nav = useNavigate();
  const lines = useBag(slug);
  const [state, setState] = useState({ loading: true, error: null, bag: null });
  /*
   * A line on its way out.
   *
   * Removing it outright made the rest of the bag jump up the screen, and on a phone that reads as
   * the wrong thing having gone. It collapses first, then goes -- long enough to follow, short
   * enough that nobody is waiting on it.
   */
  const [leaving, setLeaving] = useState(null);
  const take = (variantCode) => {
    setLeaving(variantCode);
    window.setTimeout(() => { removeFromBag(slug, variantCode); setLeaving(null); }, 240);
  };

  const key = lines.map(l => `${l.variantCode}:${l.quantity}`).join('|');

  const reprice = useCallback((signal) => {
    if (lines.length === 0) { setState({ loading: false, error: null, bag: null }); return; }
    setState(s => ({ ...s, loading: true, error: null }));
    // No codes on the bag page -- they are typed at the checkout -- but the argument has to be
    // there, or the abort signal lands in its place and leaving the page cancels nothing.
    priceBag(slug, lines.map(l => ({ variantCode: l.variantCode, quantity: l.quantity })), [], { signal })
      .then(bag => setState({ loading: false, error: null, bag }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, bag: null }); });
    // `key` rather than `lines`: the same bag in a new array should not re-price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, key]);

  useEffect(() => {
    const ac = new AbortController();
    reprice(ac.signal);
    return () => ac.abort();
  }, [reprice]);

  if (lines.length === 0) {
    return (
      <Say title="Your bag is empty" art={<EmptyBag />}
        action={<Link className="go" style={{ display: 'inline-flex', flex: '0 0 auto' }} to={`/${slug}`}>Have a look around</Link>}>
        Anything you add is kept here until you order it, even if you close the page.
      </Say>
    );
  }

  const bag = state.bag;
  const currency = bag?.currency ?? 'INR';

  /* How much more is needed for the shop's own free-delivery figure. Only ever encouraging. */
  const toFree = bag && bag.freeDeliveryAbove != null && bag.delivery > 0
    ? Math.max(0, bag.freeDeliveryAbove - (bag.goods - bag.saved))
    : 0;

  const short = bag && bag.minOrderValue != null && (bag.goods - bag.saved) < bag.minOrderValue
    ? bag.minOrderValue - (bag.goods - bag.saved)
    : 0;

  return (
    <div className="bagpage">
      <h1 className="pagetitle">Your bag</h1>

      {state.error ? (
        <Problem error={state.error} shopName={shop?.name} onRetry={() => reprice()} />
      ) : null}

      <div className="bagbody">
        <ul className="baglines">
          {lines.map(line => {
            const priced = bag?.lines?.find(l => l.variantCode === line.variantCode);
            return (
              <li key={line.variantCode} className={leaving === line.variantCode ? 'going' : undefined}>
                <Link to={priced?.productCode ? `/${slug}/p/${encodeURIComponent(priced.productCode)}` : `/${slug}`}
                  className="shot" aria-hidden={!priced}>
                  {priced?.imageUrl
                    ? <img src={priced.imageUrl} alt="" loading="lazy" decoding="async" />
                    : <span className="bone" style={{ display: 'block', width: '100%', height: '100%' }} />}
                </Link>
                <div className="what">
                  <h2>{priced?.title ?? line.title ?? 'Loading…'}</h2>
                  <p className="of">
                    {[priced?.colour ?? line.colour, priced?.size ?? line.size].filter(Boolean).join(' · ') || ' '}
                    {(priced?.colourHex ?? line.colourHex)
                      ? <i className="swatch" style={{ background: priced?.colourHex ?? line.colourHex }} aria-hidden="true" />
                      : null}
                  </p>

                  <div className="qty" role="group" aria-label={`How many ${priced?.title ?? 'of this'}`}>
                    <button type="button" aria-label="One fewer" disabled={line.quantity <= 1}
                      onClick={() => setQuantity(slug, line.variantCode, line.quantity - 1)}>−</button>
                    <span aria-live="polite">{line.quantity}</span>
                    <button type="button" aria-label="One more" disabled={line.quantity >= 10}
                      onClick={() => setQuantity(slug, line.variantCode, line.quantity + 1)}>+</button>
                  </div>
                </div>
                <div className="cash">
                  <b>{priced ? money(priced.lineTotal, currency) : ''}</b>
                  {priced && priced.saved > 0 ? <span className="off">{money(priced.saved, currency)} off</span> : null}
                  <button type="button" className="drop" onClick={() => take(line.variantCode)}>Remove</button>
                </div>
              </li>
            );
          })}
        </ul>

        <aside className="bill">
          <h2>What it comes to</h2>
          {bag ? (
            <>
              <dl>
                <div><dt>Pieces</dt><dd>{money(bag.goods, currency)}</dd></div>
                {bag.saved > 0 ? <div className="good"><dt>You save</dt><dd>−{money(bag.saved, currency)}</dd></div> : null}
                <div>
                  <dt>Delivery</dt>
                  <dd>{bag.delivery > 0 ? money(bag.delivery, currency) : <span className="good">Free</span>}</dd>
                </div>
                <div className="sum"><dt>To pay</dt><dd>{money(bag.total, currency)}</dd></div>
              </dl>

              {/* Why money came off, in the shop's own words. */}
              {bag.offers?.length ? (
                <ul className="whyoff">
                  {bag.offers.map((o, i) => <li key={i}>{o.name} <b>−{money(o.saved, currency)}</b></li>)}
                </ul>
              ) : null}

              {/* A bar that fills as they add, because "add ₹400 more" is a fact and a bar that is
                  nearly full is a reason. */}
              {toFree > 0 ? (
                <div className="nudge">
                  Add {money(toFree, currency)} more and delivery is free.
                  <Toward done={(bag.goods - bag.saved) / bag.freeDeliveryAbove} />
                </div>
              ) : bag.freeDeliveryAbove != null && bag.delivery === 0 && bag.goods > 0 ? (
                <p className="nudge">You have free delivery.</p>
              ) : null}
              {short > 0 ? (
                <p className="nudge warn">This shop sends orders of {money(bag.minOrderValue, currency)} and above.
                  Add {money(short, currency)} more.</p>
              ) : null}

              <button type="button" className="go" disabled={short > 0 || state.loading}
                onClick={() => nav(`/${slug}/checkout`)}>
                {short > 0 ? 'Add a little more' : 'Place your order'}
              </button>
              <Link className="go quiet" to={`/${slug}`}>Keep looking</Link>
            </>
          ) : (
            <div className="bone" style={{ height: 150, borderRadius: 12 }} />
          )}
        </aside>
      </div>
    </div>
  );
}
