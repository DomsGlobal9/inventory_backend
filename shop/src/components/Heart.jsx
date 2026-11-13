import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { heldProof, likePiece } from '../api';
import { signedIn, onAccountChange, noteHeart, forget } from '../account';
import { flyHeart } from '../fly';

/**
 * The heart on a piece: saves it to the shopper's wishlist (their account, 29 Oct). Saved only for a
 * signed-in number -- a stranger's heart is not kept anywhere -- so tapping it signed out goes to
 * signing in, and comes back here after.
 */
export default function Heart({ slug, productCode, variantCode, inRow = false }) {
  const nav = useNavigate();
  const where = useLocation();
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  // Saved just now by signing in (AccountPage sends it back with hearted): said here, where it was tapped.
  const [said, setSaid] = useState(where.state?.hearted === productCode ? 'Saved to your wishlist' : null);
  useEffect(() => onAccountChange(() => refresh(n => n + 1)), []);

  const me = signedIn(slug);
  const saved = !!me?.hearts?.includes(productCode);
  // While the save is on its way the button already shows what was asked for, as the big apps do.
  const [asked, setAsked] = useState(null);
  const on = asked ?? saved;
  const button = useRef(null);

  // One save at a time. A ref, not the state: a double-tap fires both taps before the screen redraws, and the
  // second would still see "not busy". The button stays bright meanwhile instead of greying out.
  const saving = useRef(false);
  const tap = async () => {
    if (saving.current) return;
    // Signed out: sign in first, and the piece is saved straight after (AccountPage), not left for a second tap.
    if (!me) { nav(`/${slug}/account`, { state: { back: where.pathname + where.search, why: 'heart', heart: { productCode, variantCode } } }); return; }
    saving.current = true;
    setBusy(true); setSaid(null); setAsked(!on);
    // Saving (never removing): a small heart flies from here into the Wishlist icon at once (fly.js).
    if (!on) void flyHeart(button.current);
    try {
      await likePiece(slug, heldProof(slug), productCode, !on, variantCode);
      noteHeart(slug, productCode, !on);
      setSaid(on ? null : 'Saved to your wishlist');
    } catch (e) {
      // Signed out elsewhere ("sign out on all phones"): sign in again.
      if (e?.kind === 'RULE') { forget(slug); nav(`/${slug}/account`, { state: { back: where.pathname + where.search, why: 'heart', heart: { productCode, variantCode } } }); return; }
      setSaid(e?.message ?? 'That could not be saved.');
    } finally { saving.current = false; setBusy(false); setAsked(null); }
  };

  return (
    <span className={inRow ? 'heartwrap inrow' : 'heartwrap'}>
      <button ref={button} type="button" className={`${inRow ? 'pact' : 'heart'}${on ? ' on' : ''}`} onClick={tap} aria-busy={busy || undefined}
        aria-pressed={on} aria-label={on ? 'Remove from your wishlist' : 'Save to your wishlist'} title={on ? 'In your wishlist' : 'Save to your wishlist'}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2Z" />
        </svg>
      </button>
      {said ? <span className="heartsaid" role="status">{said}</span> : null}
    </span>
  );
}
