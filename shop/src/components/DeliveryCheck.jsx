import React, { useEffect, useState } from 'react';
import { deliversTo } from '../api';

/**
 * "Do you deliver to me?"
 *
 * A shop that only delivers to certain PIN codes already refuses the rest -- at the END of the
 * checkout, after a name, a phone number and a full address have been typed in. Everything asked
 * for is wasted, and the shopper is left reading a red line under a form they have just filled.
 * This asks the one question that decides it, before any of that.
 *
 * Shown ONLY where the shop actually limits delivery. A shop that delivers everywhere gets
 * nothing here: an input that always says yes is a question that should not have been asked.
 *
 * The answer is remembered in this browser, because a shopper looking at six sarees should type
 * their PIN code once, not six times. It is their own PIN code in their own browser and it never
 * leaves it except to ask this one question.
 */
const REMEMBERED = 'scaleezy:shop:pincode';

export default function DeliveryCheck({ slug, deliversEverywhere }) {
  const [pincode, setPincode] = useState('');
  const [state, setState] = useState(null);   // null | 'asking' | 'yes' | 'no' | 'bad'
  const [checkedFor, setCheckedFor] = useState('');

  // Their last answer, so the question is asked once per shopper rather than once per piece.
  useEffect(() => {
    if (deliversEverywhere) return;
    try {
      const saved = localStorage.getItem(REMEMBERED);
      if (saved) { setPincode(saved); check(saved); }
    } catch { /* private window, or storage refused -- the box simply starts empty */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, deliversEverywhere]);

  if (deliversEverywhere) return null;

  async function check(raw) {
    const code = String(raw || '').replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) { setState('bad'); return; }
    setState('asking');
    try {
      const answer = await deliversTo(slug, code);
      setCheckedFor(code);
      setState(answer?.delivers ? 'yes' : 'no');
      try { localStorage.setItem(REMEMBERED, code); } catch { /* not important enough to fail on */ }
    } catch {
      // A shop that cannot be asked must not be reported as "does not deliver" -- that would
      // turn a moment of bad network into a lost customer. Say nothing and let them carry on;
      // the checkout still checks properly.
      setState(null);
    }
  }

  return (
    <div className="pincheck">
      <label htmlFor="pincheck-input"><b>Do we deliver to you?</b></label>
      <form
        onSubmit={(e) => { e.preventDefault(); check(pincode); }}
        style={{ display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}
      >
        <input
          id="pincheck-input"
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="PIN code"
          value={pincode}
          maxLength={6}
          onChange={(e) => { setPincode(e.target.value.replace(/\D/g, '').slice(0, 6)); setState(null); }}
          aria-describedby="pincheck-answer"
        />
        <button type="submit" disabled={state === 'asking' || pincode.length !== 6}>
          {state === 'asking' ? 'Checking…' : 'Check'}
        </button>
      </form>

      <p id="pincheck-answer" role="status" className={`ans ${state ?? ''}`}>
        {state === 'yes' && <>Yes &mdash; we deliver to {checkedFor}.</>}
        {state === 'no' && <>We do not deliver to {checkedFor} just now. Ask us on WhatsApp &mdash; we may still be able to help.</>}
        {state === 'bad' && <>A PIN code is six digits.</>}
      </p>
    </div>
  );
}
