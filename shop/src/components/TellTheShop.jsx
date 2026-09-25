import React, { useState } from 'react';
import { wantThis } from '../api';

/**
 * "Tell the shop you want this", on a piece that is sold out.
 *
 * The page already offers "Ask if it is coming back", which opens WhatsApp. That works, and
 * plenty of people will use it -- but it leaves the shop nothing to count. Twenty messages over
 * three weeks, and no way to see that eleven of them were for the same saree.
 *
 * The wording is careful on purpose. It says the SHOP will get in touch, not that we will send
 * a message when stock returns -- because nothing is watching stock, and a button promising
 * something nobody is listening for is worse than no button at all: a person hands over their
 * number, waits, and hears nothing.
 */
export default function TellTheShop({ slug, product, variantCode, piece }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState(null);   // null | 'sending' | 'done' | 'error'
  const [problem, setProblem] = useState('');

  if (!variantCode) return null;

  const send = async (e) => {
    e.preventDefault();
    setState('sending');
    setProblem('');
    try {
      await wantThis(slug, {
        productCode: product?.productCode,
        variantCode,
        phone: phone.trim(),
        name: name.trim() || undefined
      });
      setState('done');
    } catch (err) {
      // The shop's own refusals are written for a shopper -- "that number does not look right"
      // -- so those are worth showing. Anything else gets one plain sentence.
      setProblem(err?.message || 'That did not go through. Please try again.');
      setState('error');
    }
  };

  if (state === 'done') {
    return (
      <p className="wanted" role="status">
        Thank you &mdash; the shop has your number and will be in touch about{' '}
        <b>{piece || 'this piece'}</b>.
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" className="go quiet" onClick={() => setOpen(true)}>
        Tell the shop you want this
      </button>
    );
  }

  return (
    <form className="wantit" onSubmit={send}>
      <p>Leave your number and the shop will get in touch about <b>{piece || 'this piece'}</b>.</p>
      <div className="row">
        <input
          type="tel" inputMode="tel" autoComplete="tel" required
          placeholder="Your phone number" value={phone}
          onChange={(e) => { setPhone(e.target.value); setState(null); }}
          aria-label="Your phone number"
        />
        <input
          type="text" autoComplete="name" placeholder="Your name (optional)" value={name}
          onChange={(e) => setName(e.target.value)} aria-label="Your name"
        />
      </div>
      <div className="row">
        <button type="submit" className="go" disabled={state === 'sending' || phone.trim().length < 6}>
          {state === 'sending' ? 'Sending…' : 'Tell the shop'}
        </button>
        <button type="button" className="go quiet" onClick={() => setOpen(false)}>Not now</button>
      </div>
      {state === 'error' && <p className="bad" role="alert">{problem}</p>}
    </form>
  );
}
