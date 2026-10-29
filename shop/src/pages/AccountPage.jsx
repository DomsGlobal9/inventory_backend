import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { getAccount, sendCode, checkCode, signOutOf, likePiece, removeAddress, saveAddress, heldProof, holdProof, money } from '../api';
import { becomeSignedIn, remember, forget, noteHeart } from '../account';
import { sized, orWhole } from '../photo';

/**
 * The shopper's account at this shop (29 Oct): "Sign in with WhatsApp", no password.
 *
 * Signed out: their number, a code on WhatsApp from the shop's own number, signed in for 90 days on
 * this phone. Signed in: their orders (from any phone), wishlist, saved addresses, and points and
 * store credit where the shop has them -- everything read with the sign-in and nothing else.
 */
const ICONS = {
  orders: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 2.8 20.5 7.4v9.2L12 21.2l-8.5-4.6V7.4Z" /><path d="M3.8 7.6 12 12l8.2-4.4M12 12v9" /><path d="m7.8 5.1 8.4 4.6" /></svg>,
  heart: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 20.3s-7.6-4.6-9-9.4C2 7.6 4.1 4.6 7.3 4.6c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.2 0 5.3 3 4.3 6.3-1.4 4.8-9 9.4-9 9.4Z" /></svg>,
  pin: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.4" /></svg>
};
const shownPhone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : p;
};

/**
 * One component, three pages (owner, 29 Oct): view 'profile' (/account) is who they are, their balances
 * and a short menu; 'wishlist' (/wishlist) the hearted pieces as a grid; 'addresses' (/addresses) the
 * address book. Orders keep their own page (/orders). Signing in is the same on all three.
 */
export default function AccountPage({ shop, view = 'profile' }) {
  const { slug } = useParams();
  const nav = useNavigate();
  const where = useLocation();
  const back = where.state?.back ?? null;
  const [me, setMe] = useState(null);           // null while loading; { signedIn: false } or the account
  const [said, setSaid] = useState(null);
  // With the other hooks, above the early returns: declared after them, signing in added a hook
  // between two renders and the page went blank.
  const [editing, setEditing] = useState(null);   // null, 'new', or the address being changed

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
  // Links made before the pages were split (/account#wishlist, #addresses) open the page they meant.
  useEffect(() => {
    const to = { '#wishlist': 'wishlist', '#addresses': 'addresses' }[where.hash];
    if (view === 'profile' && to) nav(`/${slug}/${to}`, { replace: true, state: where.state });
  }, [view, where.hash, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  if (shop?.accounts === false) {
    return (
      <div className="account">
        <section className="card asignin">
          <h1>{shop?.name || 'This shop'} does not offer accounts</h1>
          <p>You can still order without signing in. Your order's link, in the WhatsApp the shop sends, is how you check on it.</p>
          <Link className="go quiet" to={`/${slug}/orders`}>Orders from this phone</Link>
        </section>
      </div>
    );
  }
  if (view === 'wishlist' && shop?.wishlist === false) {
    return (
      <div className="account">
        <section className="card asignin">
          <h1>{shop?.name || 'This shop'} does not keep wishlists</h1>
          <p>Have a look around: everything the shop has online is on its front page.</p>
          <Link className="go quiet keepon" to={`/${slug}`}>Continue shopping</Link>
        </section>
      </div>
    );
  }
  if (me === null) return <div className="bone" style={{ height: 320, borderRadius: 14, margin: '20px 0' }} />;
  if (!me.signedIn) {
    return <SignIn slug={slug} shop={shop} canSignIn={me.canSignIn} why={where.state?.why ?? (view === 'wishlist' ? 'heart' : view === 'addresses' ? 'addresses' : undefined)}
      onDone={async () => {
        const account = await becomeSignedIn(slug);
        // Signed in because of a heart: that piece is saved now, then back to it, saying so.
        const heart = where.state?.heart;
        let hearted = null;
        if (account && heart?.productCode) {
          try { await likePiece(slug, heldProof(slug), heart.productCode, true, heart.variantCode ?? undefined); noteHeart(slug, heart.productCode, true); hearted = heart.productCode; }
          catch { /* not saved: the heart is still there to tap */ }
        }
        if (account && back) { nav(back, { replace: true, state: hearted ? { hearted } : null }); return; }
        setMe(account ?? { signedIn: false, canSignIn: true });
      }} />;
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
  // Adding and editing an address here (owner, 29 Oct); the checkout offers whatever is saved.
  const useFirst = async (a) => {
    try { await saveAddress(slug, token, { id: a.id, label: a.label, name: a.name, phone: a.phone, line: a.line, pincode: a.pincode, isDefault: true }); await refresh(); }
    catch (e) { setSaid(e?.message ?? 'That could not be changed. Try again.'); }
  };

  if (view === 'wishlist') {
    return (
      <div className="account apage">
      <p className="acrumb"><Link to={`/${slug}/account`}>Your account</Link> <span aria-hidden="true">›</span></p>
        <h1 className="pagetitle">Wishlist{me.hearts.length ? <span className="acount"> · {me.hearts.length} {me.hearts.length === 1 ? 'piece' : 'pieces'}</span> : null}</h1>
        {said ? <p className="refused" role="alert">{said}</p> : null}
        <section className="card">
        {me.hearts.length === 0 ? (
          <div className="aemptybig"><p className="aempty">Your wishlist is empty. Tap the heart on a piece to save it here.</p><Link className="go quiet keepon" to={`/${slug}`}>Continue shopping</Link></div>
        ) : (
          <ul className="awish">
            {me.hearts.map(h => (
              <li key={h.productCode}>
                <Link to={`/${slug}/p/${encodeURIComponent(h.productCode)}`}>
                  <span className="shot">{h.imageUrl ? <img src={sized(h.imageUrl, 540)} onError={orWhole(h.imageUrl)} alt="" loading="lazy" decoding="async" /> : null}
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
      </div>
    );
  }

  if (view === 'addresses') {
    return (
      <div className="account apage">
      <p className="acrumb"><Link to={`/${slug}/account`}>Your account</Link> <span aria-hidden="true">›</span></p>
        <h1 className="pagetitle">Saved addresses</h1>
        {said ? <p className="refused" role="alert">{said}</p> : null}
        <section className="card" id="addresses">
        {me.addresses.length === 0 && editing !== 'new' ? (
          <p className="aempty">Add an address and it is ready at the checkout. Addresses you order to are saved here too.</p>
        ) : (
          <ul className="aaddr">
            {me.addresses.map(a => editing?.id === a.id ? (
              <li key={a.id} className="aedit">
                <AddressForm slug={slug} token={token} me={me} address={a} onDone={async () => { setEditing(null); await refresh(); }} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <li key={a.id}>
                <span>
                  {a.label || a.isDefault ? <em className="atag">{a.label || 'Address'}{a.isDefault ? ' · Default' : ''}</em> : null}
                  {a.name ? <b>{a.name}</b> : null}
                  <span>{a.line}</span>
                  <small>{a.pincode}{a.phone ? ` · ${a.phone}` : ''}</small>
                </span>
                <span className="aacts">
                  <button type="button" className="drop" onClick={() => setEditing(a)}>Edit</button>
                  {!a.isDefault ? <button type="button" className="drop" onClick={() => useFirst(a)}>Make default</button> : null}
                  <button type="button" className="drop" onClick={() => dropAddress(a)}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {editing === 'new' ? (
          <div className="aedit"><AddressForm slug={slug} token={token} me={me} address={null} first={me.addresses.length === 0} onDone={async () => { setEditing(null); await refresh(); }} onCancel={() => setEditing(null)} /></div>
        ) : editing ? null : me.addresses.length >= MOST_ADDRESSES ? (
          // The limit said before anything is typed, not after a whole address has been written out.
          <p className="aempty">You can keep {MOST_ADDRESSES} addresses. Remove one to add another.</p>
        ) : (
          <button type="button" className="go quiet aadd" onClick={() => setEditing('new')}>+ Add a new address</button>
        )}
        </section>
      </div>
    );
  }

  // The profile: who they are, their balances, and a short menu to everything else.
  const rows = [
    { to: `/${slug}/orders`, title: 'Orders', sub: me.orders.length ? `${me.orders.length} ${me.orders.length === 1 ? 'order' : 'orders'} · track, cancel or check a delivery` : 'Track, cancel or check a delivery', icon: 'orders' },
    ...(shop?.wishlist === false ? [] : [{ to: `/${slug}/wishlist`, title: 'Wishlist', sub: me.hearts.length ? `${me.hearts.length} saved ${me.hearts.length === 1 ? 'piece' : 'pieces'}` : 'The pieces you heart', icon: 'heart' }]),
    { to: `/${slug}/addresses`, title: 'Saved addresses', sub: me.addresses.length ? `${me.addresses.length} saved · used at the checkout` : 'Add one, and it is ready at the checkout', icon: 'pin' }
  ];
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

      <nav className="card amenu" aria-label="Your account">
        {rows.map(r => (
          <Link key={r.to} to={r.to}>
            <span className="amenu-ic" aria-hidden="true">{ICONS[r.icon]}</span>
            <span className="amenu-what"><b>{r.title}</b><small>{r.sub}</small></span>
            <span className="amenu-go" aria-hidden="true">›</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

/**
 * One address, new or changed (owner, 29 Oct). Saved through the same rules as the checkout's (who it
 * is for, a full address, a six-digit PIN), so whatever is saved here is offered there as it is.
 */
const LABELS = ['Home', 'Work', 'Other'];
/** The most a customer may keep (services/online-shop/addresses.ts says the same). */
const MOST_ADDRESSES = 8;
function AddressForm({ slug, token, me, address, first = false, onDone, onCancel }) {
  const [f, setF] = useState(() => ({
    label: address?.label ?? 'Home',
    name: address?.name ?? me?.name ?? '',
    phone: address?.phone ?? me?.phone ?? '',
    line: address?.line ?? '',
    pincode: address?.pincode ?? '',
    isDefault: address ? address.isDefault : first
  }));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setSaid(null);
    try {
      await saveAddress(slug, token, { ...(address ? { id: address.id } : {}), ...f, pincode: f.pincode.replace(/\D/g, '') });
      await onDone();
    } catch (err) {
      setSaid(err?.message ?? 'That address could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <form className="aform" onSubmit={save}>
      <h3>{address ? 'Change this address' : 'Add a new address'}</h3>
      <div className="alabels" role="radiogroup" aria-label="Save it as">
        {LABELS.map(l => (
          <button key={l} type="button" role="radio" aria-checked={f.label === l} className="achip" onClick={() => set('label')(l)}>{l}</button>
        ))}
      </div>
      <label><span>Full name</span><input value={f.name} onChange={set('name')} autoComplete="name" maxLength={80} required /></label>
      <label><span>Phone number</span><input type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" maxLength={20} /></label>
      <label><span>Address (house, street, area, city)</span><textarea rows={3} value={f.line} onChange={set('line')} autoComplete="street-address" maxLength={500} required /></label>
      <label><span>PIN code</span><input inputMode="numeric" value={f.pincode} onChange={set('pincode')} autoComplete="postal-code" maxLength={6} required /></label>
      {/* The default cannot simply be switched off: the checkout would then have nothing chosen. It moves
          when another address is made the default. */}
      <label className="acheck"><input type="checkbox" checked={f.isDefault} onChange={set('isDefault')} disabled={!!address?.isDefault || first} /> Make this my default address</label>
      {address?.isDefault ? <small className="ahint">This is your default. To change it, choose Make default on another address.</small> : first ? <small className="ahint">Your first address is your default.</small> : null}
      {said ? <p className="refused" role="alert">{said}</p> : null}
      <div className="aformbtns">
        <button type="submit" className="go" disabled={busy}>{busy ? 'Saving…' : 'Save address'}</button>
        <button type="button" className="go quiet" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
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
        <p>{why === 'heart' ? 'Sign in to save pieces you like. ' : why === 'addresses' ? 'Sign in to keep your addresses for the checkout. ' : ''}No password: we send a 6-digit code to your WhatsApp. You stay signed in on this phone for 90 days.</p>
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
        {/* The "once you sign in, the shop can see..." paragraph stood here; taken out (owner, 29 Oct). */}
        <Link className="go quiet keepon" to={`/${slug}`}>Continue shopping without signing in</Link>
      </section>
    </div>
  );
}
