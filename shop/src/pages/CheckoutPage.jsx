import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  priceBag, placeOrder, sendCode, checkCode, money,
  myAddresses, heldProof, holdProof, dropProof
} from '../api';
import { useBag, emptyBag, placementKey, clearPlacementKey } from '../bag';
import { Say, Problem } from '../components/States';
import { EmptyBag } from '../components/Motion';

/**
 * Where a customer actually buys.
 *
 * Three things are asked for and no more: who you are, where it goes, and how you will pay. Every
 * extra box on a checkout is a customer who does not finish -- there is no account to make, no
 * password to choose, and nothing optional dressed up as required.
 *
 * The totals are the shop's, re-asked here rather than carried over from the bag page, because a
 * price that changed while the customer was typing their address has to be the price they agree
 * to. Ordering re-prices a third time on the server, and that one is what the order is written
 * against.
 */

const PAY = {
  ON_DELIVERY: { title: 'Pay when it arrives', note: 'Cash or UPI to the delivery person.' },
  ONLINE: { title: 'Pay now', note: 'Card, UPI or net banking.' }
};

export default function CheckoutPage({ shop }) {
  const { slug } = useParams();
  const nav = useNavigate();
  const lines = useBag(slug);

  const [state, setState] = useState({ loading: true, error: null, bag: null });
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', pincode: '', payWay: '' });
  const [placing, setPlacing] = useState(false);
  const [refused, setRefused] = useState(null);

  /* Codes the shop printed on a card. Applied by the shop, never worked out here. */
  const [codes, setCodes] = useState([]);
  const [typedCode, setTypedCode] = useState('');

  /*
   * Proving the number. `proof.state` is where this checkout has got to, not what the server
   * believes -- the server is asked again when the order is placed, so nothing here can skip it.
   */
  const [proof, setProof] = useState({ state: 'none', code: '', busy: false, said: null, forPhone: '' });

  /*
   * Addresses this person has saved, and which one is in the boxes below.
   *
   * `usingId` is cleared the moment they type in the address themselves, so the highlighted card
   * never disagrees with what is actually going to be ordered to.
   */
  const [book, setBook] = useState([]);
  const [usingId, setUsingId] = useState(null);

  const key = lines.map(l => `${l.variantCode}:${l.quantity}`).join('|');

  const reprice = useCallback((signal) => {
    if (lines.length === 0) { setState({ loading: false, error: null, bag: null }); return; }
    setState(s => ({ ...s, loading: true, error: null }));
    priceBag(slug, lines.map(l => ({ variantCode: l.variantCode, quantity: l.quantity })), codes, { signal })
      .then(bag => {
        setState({ loading: false, error: null, bag });
        // The shop's first way to pay, chosen for them: one fewer decision, and they can change it.
        setForm(f => (f.payWay ? f : { ...f, payWay: bag.payWays?.[0] ?? '' }));
      })
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, bag: null }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, key, codes.join(',')]);

  /*
   * The first look is immediate; every change after it waits a moment.
   *
   * Each "+" re-prices, and the old request was aborted in the browser but had already been SENT.
   * Taking one line from one to ten is nine calls to the shop, and the shop counts them: a shopper
   * adjusting their own bag could be refused by it. A third of a second is below noticing and turns
   * a run of taps into one request.
   */
  const priced = useRef(false);
  useEffect(() => {
    const ac = new AbortController();
    const t = window.setTimeout(() => { priced.current = true; reprice(ac.signal); }, priced.current ? 350 : 0);
    return () => { window.clearTimeout(t); ac.abort(); };
  }, [reprice]);

  /* Remembered for next time on this phone. Their own details, in their own browser, nowhere else. */
  useEffect(() => {
    try {
      const held = JSON.parse(window.localStorage.getItem(`scaleezy.you.${slug}`) ?? 'null');
      if (held) setForm(f => ({ ...f, ...held, payWay: f.payWay }));
    } catch { /* a browser that will not store: they type it once */ }
  }, [slug]);

  /*
   * The book, fetched only where there is a secret to fetch it with.
   *
   * A proof that has run out, or been cleared, simply answers "confirm your number" -- which is
   * not a failure worth showing on a checkout, so it empties the list and says nothing.
   *
   * ABOVE THE EMPTY-BAG RETURN BELOW, with every other hook. Placed after it, these two would be
   * skipped the moment the bag emptied -- which happens on the way out of a successful order --
   * and React counts hooks: one render with fewer than the last is the "rendered fewer hooks than
   * expected" crash, on the happiest path there is.
   */
  const loadBook = useCallback(async () => {
    const token = heldProof(slug);
    if (!token) { setBook([]); return; }
    try {
      const out = await myAddresses(slug, token);
      setBook(out?.addresses ?? []);
    } catch {
      dropProof(slug);
      setBook([]);
    }
  }, [slug]);

  useEffect(() => { void loadBook(); }, [loadBook]);

  /*
   * Arriving at a checkout with a book already filled in.
   *
   * Once, when the book lands, and never again -- a shopper who has since chosen a different card,
   * or typed over the boxes, must not have their own choice taken back off them by a late render.
   *
   * What is on the form already WINS: it is what they last ordered to on this device, and it is
   * almost always one of these cards anyway, since the book fills itself. Where it matches a card,
   * that card is the one shown as chosen -- otherwise the page would offer three saved addresses
   * and highlight "Somewhere else" while displaying one of the three.
   */
  const formNow = useRef(form);
  useEffect(() => { formNow.current = form; }, [form]);
  const settled = useRef(false);

  useEffect(() => {
    if (settled.current || book.length === 0) return;
    settled.current = true;

    const typed = formNow.current.address.trim();
    if (typed) {
      const same = book.find(a => a.line.trim() === typed);
      if (same) setUsingId(same.id);
      return;
    }
    const first = book.find(a => a.isDefault) ?? book[0];
    setForm(f => ({ ...f, address: first.line, pincode: first.pincode, name: f.name || first.name }));
    setUsingId(first.id);
  }, [book]);

  if (lines.length === 0) {
    return (
      <Say title="Your bag is empty" art={<EmptyBag />}
        action={<Link className="go" style={{ display: 'inline-flex', flex: '0 0 auto' }} to={`/${slug}`}>Have a look around</Link>}>
        Put something in it and you can order from here.
      </Say>
    );
  }

  const bag = state.bag;
  const currency = bag?.currency ?? 'INR';
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setRefused(null); };

  /*
   * What is missing, said only once they have tried. A form that turns red while somebody is still
   * typing their own name is a form that tells them they are wrong before they have finished.
   */
  const missing = () => {
    if (form.name.trim().length < 2) return 'Tell the shop your name.';
    if (form.phone.replace(/\D/g, '').length < 10) return 'The shop needs a phone number to reach you on.';
    if (form.address.trim().length < 10) return 'Write out the full address, with the house, the street and the area.';
    if (!/^[1-9][0-9]{5}$/.test(form.pincode.replace(/\D/g, ''))) return 'That PIN code does not look right. It is six digits.';
    if (!form.payWay) return 'Choose how you would like to pay.';
    return null;
  };

  /*
   * The code. Asked for only when the shop can send one and the number has changed -- a shopper
   * who proves their number and then fixes a typo in their name should not be asked again.
   */
  const askForCode = async () => {
    const wrong = form.phone.replace(/\D/g, '').length < 10 ? 'The shop needs a phone number to reach you on.' : null;
    if (wrong) { setRefused(wrong); return; }
    setProof(p => ({ ...p, busy: true, said: null }));
    try {
      const out = await sendCode(slug, form.phone);
      setProof({
        state: out.alreadyVerified ? 'done' : 'sent',
        code: '', busy: false, forPhone: form.phone,
        said: out.alreadyVerified ? 'This number is already confirmed.' : 'We have sent a code to your WhatsApp.'
      });
    } catch (err) {
      setProof(p => ({ ...p, busy: false, said: err?.message ?? 'That could not be sent.' }));
    }
  };

  const confirmCode = async () => {
    setProof(p => ({ ...p, busy: true, said: null }));
    try {
      // The secret comes back with the confirmation and is kept on this device; it is what the
      // saved addresses are read with from here on.
      const out = await checkCode(slug, form.phone, proof.code);
      holdProof(slug, out?.token);
      setProof(p => ({ ...p, state: 'done', busy: false, said: 'Number confirmed.', forPhone: form.phone }));
      void loadBook();
    } catch (err) {
      setProof(p => ({ ...p, busy: false, said: err?.message ?? 'That code was not right.' }));
    }
  };

  /** Put a saved address into the boxes, so what is ordered to is always what is on screen. */
  const useSaved = (a) => {
    setUsingId(a.id);
    setRefused(null);
    setForm(f => ({
      ...f,
      address: a.line,
      pincode: a.pincode,
      // A gift goes to somebody else, and it is their name the parcel wants.
      name: a.name || f.name
    }));
  };

  const proved = proof.state === 'done' && proof.forPhone === form.phone;

  const submit = async (e) => {
    e.preventDefault();
    const wrong = missing();
    if (wrong) { setRefused(wrong); return; }

    setPlacing(true);
    setRefused(null);
    try {
      try {
        window.localStorage.setItem(`scaleezy.you.${slug}`, JSON.stringify({
          name: form.name, phone: form.phone, email: form.email,
          address: form.address, pincode: form.pincode
        }));
      } catch { /* fine */ }

      const order = await placeOrder(slug, {
        placementKey: placementKey(slug),
        lines: lines.map(l => ({ variantCode: l.variantCode, quantity: l.quantity })),
        couponCodes: codes,
        name: form.name, phone: form.phone, email: form.email,
        address: form.address, pincode: form.pincode, payWay: form.payWay
      });

      // Only once the shop has it. Emptying the bag before this would lose the order on a refusal.
      emptyBag(slug);
      clearPlacementKey(slug);
      nav(`/${slug}/order/${order.token}`, { replace: true });
    } catch (err) {
      setRefused(err?.message ?? 'That could not be sent. Please try again.');
      setPlacing(false);
      // The bag may have been the problem -- something sold out while they typed. Ask again.
      reprice();
    }
  };

  return (
    <form className="checkout" onSubmit={submit} noValidate>
      <h1 className="pagetitle">Your order</h1>

      {state.error ? <Problem error={state.error} shopName={shop?.name} onRetry={() => reprice()} /> : null}

      <div className="checkbody">
        <div className="asks">
          <section className="ask">
            <h2><i>1</i> Who is it for?</h2>
            <div className="fields">
              <label>
                <span>Your name</span>
                <input value={form.name} onChange={e => set('name', e.target.value)}
                  autoComplete="name" maxLength={80} placeholder="Priya Reddy" />
              </label>
              <label>
                <span>Phone</span>
                <input value={form.phone} onChange={e => { set('phone', e.target.value); setProof(p => ({ ...p, said: null })); }}
                  type="tel" inputMode="tel" autoComplete="tel" maxLength={20} placeholder="98480 22338" />
                <small>The shop rings this to arrange delivery.</small>
              </label>
              <label className="wide">
                <span>Email <em>(optional)</em></span>
                <input value={form.email} onChange={e => set('email', e.target.value)}
                  type="email" autoComplete="email" maxLength={120} placeholder="you@example.com" />
              </label>
            </div>
          </section>

          {/*
            Confirming the number. Shown only where the shop can actually send a code; a shop with
            no WhatsApp linked simply takes the order and rings. The code is what lets this order
            be attached to the customer's real record rather than a new one, and what stops a
            made-up number holding the shop's stock.

            `canVerifyPhone` is the shop telling us, not this page guessing. Until it existed this
            comment described something that was never true: the block rendered for every shop, and
            a shop with no linked number answered every press with "Something went wrong".
          */}
          {!shop?.canVerifyPhone ? null : proved ? (
            <p className="proved">✓ {form.phone} confirmed</p>
          ) : (
            <div className="verify">
              {proof.state === 'sent' ? (
                <>
                  <label>
                    <span>The code we sent to your WhatsApp</span>
                    <input value={proof.code} onChange={e => setProof(p => ({ ...p, code: e.target.value }))}
                      inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" />
                  </label>
                  <div className="row">
                    <button type="button" className="go quiet" disabled={proof.busy || proof.code.replace(/\D/g, '').length !== 6}
                      onClick={confirmCode}>{proof.busy ? 'Checking…' : 'Confirm'}</button>
                    <button type="button" className="again" disabled={proof.busy} onClick={askForCode}>Send it again</button>
                  </div>
                </>
              ) : (
                <div className="row">
                  <span>Confirm your number so the shop knows the order is real.</span>
                  <button type="button" className="go quiet" disabled={proof.busy} onClick={askForCode}>
                    {proof.busy ? 'Sending…' : 'Send me a code'}
                  </button>
                </div>
              )}
              {proof.said ? <p className="said">{proof.said}</p> : null}
            </div>
          )}

          <section className="ask">
            <h2><i>2</i> Where does it go?</h2>

            {/*
              Addresses this person has saved, for a shopper whose number is proved.

              Not offered otherwise, and that is the point rather than a limitation: a number typed
              at a checkout is not proof of who somebody is, and these are people's homes. The book
              fills itself as they order, so nobody is asked to tick "save this address".
            */}
            {book.length > 0 && (
              <div className="book">
                {book.map(a => (
                  <button
                    key={a.id} type="button" className="saved" aria-pressed={usingId === a.id}
                    onClick={() => useSaved(a)}
                  >
                    <b>
                      {a.label || a.name}
                      {a.isDefault ? <em>Default</em> : null}
                    </b>
                    <span>{a.line}</span>
                    <span className="pin">{a.pincode}{a.name && a.label ? ` · ${a.name}` : ''}</span>
                  </button>
                ))}
                <button
                  type="button" className="saved fresh" aria-pressed={usingId === null}
                  onClick={() => { setUsingId(null); set('address', ''); set('pincode', ''); }}
                >
                  <b>Somewhere else</b>
                  <span>Type a new address</span>
                </button>
              </div>
            )}

            <div className="fields">
              <label className="wide">
                <span>Full address</span>
                <textarea value={form.address}
                  onChange={e => { set('address', e.target.value); setUsingId(null); }}
                  rows={4} maxLength={500} autoComplete="street-address"
                  placeholder={'House / flat, street\nArea, landmark\nCity, State'} />
              </label>
              <label>
                <span>PIN code</span>
                <input value={form.pincode} onChange={e => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="postal-code" maxLength={6} placeholder="500029" />
                {bag && bag.deliversEverywhere === false
                  ? <small>This shop delivers to some areas only.</small>
                  : null}
              </label>
            </div>
          </section>

          <section className="ask">
            <h2><i>3</i> How would you like to pay?</h2>
            <div className="ways">
              {(bag?.payWays ?? []).map(way => (
                <label key={way} className="way" data-on={form.payWay === way}>
                  <input type="radio" name="payWay" value={way}
                    checked={form.payWay === way} onChange={() => set('payWay', way)} />
                  <span>
                    <b>{PAY[way]?.title ?? way}</b>
                    <small>{PAY[way]?.note ?? ''}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>
        </div>

        <aside className="bill">
          <h2>{(() => { const n = lines.reduce((t, l) => t + l.quantity, 0); return n === 1 ? '1 piece' : `${n} pieces`; })()}</h2>
          {bag ? (
            <>
              <ul className="mini">
                {bag.lines.map(l => (
                  <li key={l.variantCode}>
                    <span className="n">{l.quantity}×</span>
                    <span className="t">{l.title}{l.size ? ` · ${l.size}` : ''}</span>
                    <span className="m">{money(l.lineTotal, currency)}</span>
                  </li>
                ))}
              </ul>
              {/* A code the shop printed on a card. The engine has always taken these; until now
                  the shop's own page was the one place that offered nowhere to type one. */}
              <div className="codebox">
                <input value={typedCode} onChange={e => setTypedCode(e.target.value.toUpperCase())}
                  maxLength={32} placeholder="Discount code" aria-label="Discount code"
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const c = typedCode.trim().toUpperCase();
                    if (c && !codes.includes(c)) setCodes(list => [...list, c].slice(0, 5));
                    setTypedCode('');
                  }} />
                <button type="button" disabled={!typedCode.trim()} onClick={() => {
                  const c = typedCode.trim().toUpperCase();
                  if (c && !codes.includes(c)) setCodes(list => [...list, c].slice(0, 5));
                  setTypedCode('');
                }}>Apply</button>
              </div>
              {codes.length > 0 && (
                <ul className="codes">
                  {codes.map(c => {
                    const bad = bag.codesRefused?.find(r => r.code === c);
                    return (
                      <li key={c} data-bad={!!bad}>
                        <b>{c}</b>
                        <span>{bad ? bad.why : 'Applied'}</span>
                        <button type="button" aria-label={`Take off ${c}`}
                          onClick={() => setCodes(list => list.filter(x => x !== c))}>✕</button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <dl>
                <div><dt>Pieces</dt><dd>{money(bag.goods, currency)}</dd></div>
                {bag.saved > 0 ? <div className="good"><dt>You save</dt><dd>−{money(bag.saved, currency)}</dd></div> : null}
                <div><dt>Delivery</dt><dd>{bag.delivery > 0 ? money(bag.delivery, currency) : <span className="good">Free</span>}</dd></div>
                <div className="sum"><dt>To pay</dt><dd>{money(bag.total, currency)}</dd></div>
              </dl>

              {refused ? <p className="refused" role="alert">{refused}</p> : null}

              <button type="submit" className="go" disabled={placing || state.loading}>
                {placing ? 'Sending your order…'
                  : form.payWay === 'ONLINE' ? `Pay ${money(bag.total, currency)}`
                  : `Place order · ${money(bag.total, currency)}`}
              </button>
              <p className="tiny">
                By ordering you agree to {shop?.seller?.name || shop?.name}'s terms.
                {shop?.returnPolicy ? ' Returns are at the bottom of this page.' : ''}
              </p>
              <Link className="go quiet" to={`/${slug}/bag`}>Back to the bag</Link>
            </>
          ) : state.error ? (
            /*
             * A checkout that cannot price itself.
             *
             * It used to sit on a skeleton for ever, which reads as a page still loading rather
             * than one that has given up -- and the only way out was the bag icon in the bar. The
             * reason is already shown above; this is the way back to do something about it.
             */
            <>
              <p className="tiny" style={{ marginTop: 0 }}>
                Sort your bag out and come back — nothing has been ordered.
              </p>
              <Link className="go" to={`/${slug}/bag`}>Back to the bag</Link>
            </>
          ) : (
            <div className="bone" style={{ height: 180, borderRadius: 12 }} />
          )}
        </aside>
      </div>
    </form>
  );
}
