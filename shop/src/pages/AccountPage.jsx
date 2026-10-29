import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { getAccount, sendCode, checkCode, signOutOf, likePiece, removeAddress, heldProof, holdProof, money } from '../api';
import { becomeSignedIn, remember, forget, noteHeart } from '../account';
import { ORDER_WORDS } from '../orderWords';

/**
 * The shopper's account at this shop (29 Oct): "Sign in with WhatsApp", no password.
 *
 * Signed out: their number, a code on WhatsApp from the shop's own number, signed in for 90 days on
 * this phone. Signed in: their orders (from any phone), wishlist, saved addresses, and points and
 * store credit where the shop has them -- everything read with the sign-in and nothing else.
 */
const ORDERS_SHOWN = 5;
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const shownPhone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : p;
};

export default function AccountPage({ shop }) {
  const { slug } = useParams();
  const nav = useNavigate();
  const where = useLocation();
  const back = where.state?.back ?? null;
  const [me, setMe] = useState(null);           // null while loading; { signedIn: false } or the account
  const [said, setSaid] = useState(null);

  const load = useCallback(async () => {
    const token = heldProof(slug);
    if (!token) { setMe({ signedIn: false, canSignIn: !!shop?.canVerifyPhone }); return; }
    // A pass from a code check (the checkout, a try-on) becomes a sign-in here too.
    const account = await becomeSignedIn(slug);
    if (account) { setMe(account); return; }
    try {
      const out = await getAccount(slug, heldProof(slug));
      if (!out?.signedIn) forget(slug);
      setMe(out?.signedIn ? out : { signedIn: false, canSignIn: out?.canSignIn ?? !!shop?.canVerifyPhone });
    } catch {
      setMe({ signedIn: false, canSignIn: !!shop?.canVerifyPhone });
    }
  }, [slug, shop?.canVerifyPhone]);

  useEffect(() => { void load(); }, [load]);

  if (me === null) return <div className="bone" style={{ height: 320, borderRadius: 14, margin: '20px 0' }} />;
  if (!me.signedIn) {
    return <SignIn slug={slug} shop={shop} canSignIn={me.canSignIn} why={where.state?.why}
      onDone={async () => { const account = await becomeSignedIn(slug); if (account && back) { nav(back, { replace: true }); return; } setMe(account ?? { signedIn: false, canSignIn: true }); }} />;
  }

  const token = heldProof(slug);
  const refresh = async () => { const out = await getAccount(slug, token).catch(() => null); if (out?.signedIn) { remember(slug, out); setMe(out); } else { forget(slug); setMe({ signedIn: false, canSignIn: true }); } };

  const out = async (everywhere) => {
    setSaid(null);
    try { await signOutOf(slug, token, everywhere); } catch { /* signed out here either way */ }
    forget(slug);
    setMe({ signedIn: false, canSignIn: true });
  };

  const unheart = async (h) => {
    try { await likePiece(slug, token, h.productCode, false, h.variantCode ?? undefined); noteHeart(slug, h.productCode, false); await refresh(); }
    catch (e) { setSaid(e?.message ?? 'That could not be changed. Try again.'); }
  };
  const dropAddress = async (a) => {
    try { await removeAddress(slug, token, a.id); await refresh(); }
    catch (e) { setSaid(e?.message ?? 'That could not be removed. Try again.'); }
  };

  return (
    <div className="account">
      <section className="card awho">
        <span className="avatar" aria-hidden="true">{(me.name || 'You').trim().charAt(0).toUpperCase()}</span>
        <div className="awhat">
          <h1>{me.name ? `Hello, ${String(me.name).trim().split(/\s+/)[0]}` : 'Your account'}</h1>
          <p>{shownPhone(me.phone)}{me.devices > 1 ? ` · signed in on ${me.devices} phones` : ''}</p>
        </div>
        <div className="aout">
          <button type="button" className="go quiet" onClick={() => out(false)}>Sign out</button>
          {me.devices > 1 ? <button type="button" className="drop" onClick={() => out(true)}>Sign out on all phones</button> : null}
        </div>
      </section>

      {said ? <p className="refused" role="alert">{said}</p> : null}

      {(me.points !== null || me.storeCredit !== null) && (
        <div className="amoney">
          {me.points !== null ? (
            <div className="card"><b>{Number(me.points).toLocaleString('en-IN')}</b><span>points</span><small>Use them at {shop?.name || 'the shop'}.</small></div>
          ) : null}
          {me.storeCredit !== null ? (
            <div className="card"><b>{money(me.storeCredit)}</b><span>store credit</span><small>Use it at {shop?.name || 'the shop'}.</small></div>
          ) : null}
        </div>
      )}

      <section className="card">
        <h2>Your orders</h2>
        {me.orders.length === 0 ? (
          <p className="aempty">No orders on this number yet. <Link to={`/${slug}`}>Have a look around</Link></p>
        ) : (
          <ul className="arows">
            {me.orders.slice(0, ORDERS_SHOWN).map(o => (
              <li key={o.token}>
                <Link to={`/${slug}/order/${o.token}`}>
                  <span className="shot">{o.firstImage ? <img src={o.firstImage} alt="" loading="lazy" decoding="async" /> : null}</span>
                  <span className="what">
                    <b>{o.orderNumber}</b>
                    <small>{dayOf(o.placedAt)} · {o.pieces === 1 ? '1 piece' : `${o.pieces} pieces`}</small>
                  </span>
                  <span className="end">
                    <b>{money(o.total)}</b>
                    <small className="state" data-state={o.state}>{ORDER_WORDS[o.state] ?? 'Placed'}</small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {me.orders.length > ORDERS_SHOWN ? <Link className="go quiet" to={`/${slug}/orders`}>See all {me.orders.length} orders</Link> : null}
      </section>

      <section className="card">
        <h2>Your wishlist</h2>
        {me.hearts.length === 0 ? (
          <p className="aempty">Tap the heart on a piece to save it here.</p>
        ) : (
          <ul className="awish">
            {me.hearts.map(h => (
              <li key={h.productCode}>
                <Link to={`/${slug}/p/${encodeURIComponent(h.productCode)}`}>
                  <span className="shot">{h.imageUrl ? <img src={h.imageUrl} alt="" loading="lazy" decoding="async" /> : null}
                    {!h.available ? <span className="gone">Sold out</span> : null}
                  </span>
                  <b>{h.title}</b>
                  <small>{[h.colour, h.price !== null ? money(h.price) : null].filter(Boolean).join(' · ')}</small>
                </Link>
                <button type="button" className="unheart" aria-label={`Remove ${h.title} from your wishlist`} onClick={() => unheart(h)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2Z" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Saved addresses</h2>
        {me.addresses.length === 0 ? (
          <p className="aempty">Addresses you order to are saved here for next time.</p>
        ) : (
          <ul className="aaddr">
            {me.addresses.map(a => (
              <li key={a.id}>
                <span>
                  {a.name ? <b>{a.name}</b> : null}
                  <span>{a.line}</span>
                  <small>{a.pincode}{a.isDefault ? ' · used first' : ''}</small>
                </span>
                <button type="button" className="drop" onClick={() => dropAddress(a)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Signing in: the number, then the code from the shop's WhatsApp. */
function SignIn({ slug, shop, canSignIn, why, onDone }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('number');   // 'number' -> 'code'
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);

  const ask = async () => {
    setSaid(null);
    if (phone.replace(/\D/g, '').length < 10) { setSaid('Type your 10-digit WhatsApp number.'); return; }
    setBusy(true);
    try {
      await sendCode(slug, phone, undefined, 'SIGNIN');
      setStep('code'); setCode('');
      setSaid('We have sent a code to your WhatsApp.');
    } catch (e) { setSaid(e?.message ?? 'That code could not be sent. Try again.'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setSaid(null); setBusy(true);
    try {
      const out = await checkCode(slug, phone, code);
      holdProof(slug, out?.token);
      await onDone();
    } catch (e) { setSaid(e?.message ?? 'That code is not right.'); setBusy(false); }
  };

  return (
    <div className="account">
      <section className="card asignin">
        <h1>Sign in to {shop?.name || 'the shop'}</h1>
        <p>{why === 'heart' ? 'Sign in to save pieces you like. ' : ''}No password: we send a 6-digit code to your WhatsApp. You stay signed in on this phone for 90 days.</p>
        {!canSignIn ? (
          <p className="refused">This shop cannot send codes just now. You can still order without signing in.</p>
        ) : step === 'number' ? (
          <form className="verify" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <label>
              <span>Your WhatsApp number</span>
              <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="98480 11122" />
            </label>
            <button type="submit" className="go" disabled={busy}>{busy ? 'Sending…' : 'Send me a code'}</button>
          </form>
        ) : (
          <form className="verify" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
            <label>
              <span>The code we sent to {phone}</span>
              <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" />
            </label>
            <div className="row">
              <button type="submit" className="go" disabled={busy || code.replace(/\D/g, '').length !== 6}>{busy ? 'Checking…' : 'Sign in'}</button>
              <button type="button" className="again" disabled={busy} onClick={ask}>Send it again</button>
              <button type="button" className="again" disabled={busy} onClick={() => { setStep('number'); setSaid(null); }}>Change number</button>
            </div>
          </form>
        )}
        {said ? <p className="said" role="status">{said}</p> : null}
        <p className="said privacy">Once you sign in, {shop?.name || 'the shop'} can see which pieces you look at and try on here for 30 days, so it can help you when you visit. Pieces you heart stay on your wishlist until you remove them.</p>
        <Link className="drop" to={`/${slug}`}>Keep shopping without signing in</Link>
      </section>
    </div>
  );
}
