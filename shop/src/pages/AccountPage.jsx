import React, { useCallback, useEffect, useState } from 'react';
import { EmptyWishlist } from '../components/Motion';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { getAccount, getProducts, sendCode, checkCode, signOutOf, likePiece, removeAddress, saveAddress, heldProof, holdProof, money } from '../api';
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
  const [confirming, setConfirming] = useState(null); // the id of an address whose Remove asked "are you sure"

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
          <div className="aemptybig"><div className="art"><EmptyWishlist /></div><p className="aempty">Your wishlist is empty. Tap the heart on a piece to save it here.</p><Link className="go quiet keepon" to={`/${slug}`}>Continue shopping</Link></div>
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
              <li key={a.id} className="acard">
                <span className="awhere">
                  <span className="atags">
                    {a.label ? <em className="atag">{a.label}</em> : null}
                    {a.isDefault ? <em className="atag adefault">Default</em> : null}
                  </span>
                  {a.name ? <b>{a.name}</b> : null}
                  <span>{a.line}</span>
                  <small>PIN {a.pincode}{a.phone ? ` · ${shownPhone(a.phone)}` : ''}</small>
                </span>
                {/* Proper buttons along the bottom (owner, 29 Oct), and Remove asks first: one slip of a
                    thumb should not throw away an address somebody typed out. */}
                {confirming === a.id ? (
                  <span className="abtns asure" role="group" aria-label="Remove this address?">
                    <span className="asureq">Remove this address?</span>
                    <button type="button" className="abtn danger" onClick={async () => { setConfirming(null); await dropAddress(a); }}>Yes, remove</button>
                    <button type="button" className="abtn" onClick={() => setConfirming(null)}>Keep it</button>
                  </span>
                ) : (
                  <span className="abtns">
                    <button type="button" className="abtn" onClick={() => setEditing(a)}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>
                      Edit
                    </button>
                    {!a.isDefault ? (
                      <button type="button" className="abtn" onClick={() => useFirst(a)}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z" /></svg>
                        Set default
                      </button>
                    ) : null}
                    <button type="button" className="abtn danger" aria-label={`Remove ${a.label || 'this'} address`} onClick={() => setConfirming(a.id)}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
                      Remove
                    </button>
                  </span>
                )}
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

/** The four things an account gives a shopper, said once and the same on every shop. */
const PERKS = [
  { key: 'wish', title: 'Wishlist', line: 'Keep the pieces you love in one place.', d: 'M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2Z' },
  { key: 'orders', title: 'Order tracking', line: 'Follow every order to your doorstep.', d: 'M12 2.8 20.5 7.4v9.2L12 21.2l-8.5-4.6V7.4ZM3.8 7.6 12 12l8.2-4.4M12 12v9' },
  { key: 'addr', title: 'Saved addresses', line: 'Ready and waiting at checkout.', d: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11ZM12 12.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z' },
  { key: 'fast', title: 'Faster checkout', line: 'Your details, filled in for you.', d: 'M13 2 4 14h7l-1 8 9-12h-7Z' }
];
const WA = 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.6-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2.1 1-2.4c.3-.3.6-.3.8-.3h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.2.1.6-.1 1.1Z';

/** Ten digits from whatever was typed: "+91 98480 11122", "098480 11122" and "9848011122" are one number. */
const tenDigits = (typed) => {
  const d = String(typed ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  return d;
};
const spaced = (ten) => (ten.length === 10 ? `${ten.slice(0, 5)} ${ten.slice(5)}` : ten);

/**
 * Signing in (redesigned 3 Nov, owner's option C): the reasons to have an account and a few of the shop's
 * own pieces beside a sign-in card. On a phone the card comes straight after the heading, so nobody scrolls
 * to sign in; the reasons and the pieces follow. The number, then the one-time code on WhatsApp.
 */
function SignIn({ slug, shop, canSignIn, why, onDone }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('number');   // 'number' -> 'code'
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [picks, setPicks] = useState([]);
  const name = shop?.name || 'the shop';

  // A few of the shop's own pieces, newest first. Nothing shown while they load, or if there are none.
  useEffect(() => {
    const ac = new AbortController();
    getProducts(slug, { limit: 8 }, { signal: ac.signal })
      .then(res => setPicks((res?.products ?? []).filter(p => p.images?.[0]?.url).slice(0, 4)))
      .catch(() => {});
    return () => ac.abort();
  }, [slug]);

  const ask = async () => {
    setSaid(null);
    const ten = tenDigits(phone);
    if (ten.length !== 10) { setSaid('Enter your 10-digit mobile number.'); return; }
    setBusy(true);
    try {
      await sendCode(slug, ten, undefined, 'SIGNIN');
      setPhone(ten); setStep('code'); setCode('');
    } catch (e) { setSaid(e?.message ?? 'We could not send the OTP. Please try again.'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setSaid(null); setBusy(true);
    try {
      const out = await checkCode(slug, phone, code);
      holdProof(slug, out?.token);
      await onDone();
    } catch (e) { setSaid(e?.message ?? 'That OTP is not correct.'); setBusy(false); }
  };
  const lede = why === 'heart' ? 'Sign in to save this piece to your wishlist.'
    : why === 'addresses' ? 'Sign in to keep your addresses ready for checkout.'
    : 'Your wishlist, orders and saved addresses, together in one place.';

  return (
    <div className="account si">
      <header className="si-intro">
        {shop?.logoUrl ? <span className="si-mark"><img src={shop.logoUrl} alt="" /></span> : null}
        <h1>Sign in to {name}</h1>
        <p className="si-lede">{lede}</p>
      </header>

      <section className="si-card asignin" aria-label="Sign in">
        {!canSignIn ? (
          <p className="refused">Sign-in is unavailable at the moment. You can still place your order as a guest.</p>
        ) : step === 'number' ? (
          <form className="verify" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <h2>Sign in</h2>
            <p className="si-sub">Secure, password-free sign-in with a one-time code on WhatsApp.</p>
            <label className="si-field">
              <span>Mobile number</span>
              <span className="si-phone">
                <b aria-hidden="true">+91</b>
                <input type="tel" inputMode="tel" autoComplete="tel-national" value={phone} onChange={e => setPhone(e.target.value)} placeholder="98480 11122" aria-label="Mobile number" />
              </span>
            </label>
            <button type="submit" className="go" disabled={busy}>{busy ? 'Sending OTP…' : 'Get OTP on WhatsApp'}</button>
          </form>
        ) : (
          <form className="verify" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
            <h2>Verify your number</h2>
            <p className="si-sub">Enter the 6-digit OTP sent to WhatsApp on <b>+91 {spaced(phone)}</b>.</p>
            <label className="si-field">
              <span>OTP</span>
              <input className="si-otp" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="• • • • • •" aria-label="OTP" />
            </label>
            <button type="submit" className="go" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify and sign in'}</button>
            <div className="si-links">
              <button type="button" className="again" disabled={busy} onClick={ask}>Resend OTP</button>
              <button type="button" className="again" disabled={busy} onClick={() => { setStep('number'); setSaid(null); }}>Change number</button>
            </div>
          </form>
        )}
        {said ? <p className="said" role="status">{said}</p> : null}
        <p className="si-note">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="#25D366" aria-hidden="true"><path d={WA} /></svg>
          You stay signed in on this device for 90 days.
        </p>
        <Link className="go quiet keepon" to={`/${slug}`}>Continue as guest</Link>
      </section>

      <ul className="si-perks" aria-label="With an account">
        {PERKS.map(k => (
          <li key={k.key}>
            <span className="si-ico" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d={k.d} /></svg>
            </span>
            <span><b>{k.title}</b>{k.line}</span>
          </li>
        ))}
      </ul>

      {picks.length >= 2 ? (
        <section className="si-picks" aria-label="Curated for you">
          <h2>Curated for you</h2>
          <div className="si-row">
            {picks.map(p => (
              <Link key={p.productCode} to={`/${slug}/p/${encodeURIComponent(p.productCode)}`} className="si-pick">
                <img src={sized(p.images[0].url, 360)} onError={orWhole(p.images[0].url)} alt={p.title} loading="lazy" decoding="async" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
