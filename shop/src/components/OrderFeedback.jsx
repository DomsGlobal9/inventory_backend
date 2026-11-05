import React, { useEffect, useState } from 'react';
import { sendOrderFeedback } from '../api';

/** Anything the customer wants the store to know about a delivered order. Private: it goes to the store's CRM only. */
export function OrderFeedback({ slug, token, sent }) {
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  useEffect(() => { setSaved(sent ?? null); }, [sent]);

  const send = async (e) => {
    e.preventDefault();
    if (!body.trim()) { setSaid('Type your feedback first.'); return; }
    setBusy(true); setSaid(null);
    try {
      await sendOrderFeedback(slug, token, body);
      setSaved(body.trim()); setEditing(false);
    } catch (err) { setSaid(err?.kind === 'RULE' && err?.message ? err.message : 'Your feedback could not be sent. Please try again.'); }
    finally { setBusy(false); }
  };

  if (saved && !editing) {
    return (
      <section className="card rv-feedback done">
        <h2>Your feedback to the store</h2>
        <p className="rv-feedback-sent">{saved}</p>
        <p className="rv-feedback-note">Thank you. Only the store can see this.</p>
        <button type="button" className="rv-link" onClick={() => { setBody(saved); setEditing(true); }}>Change it</button>
      </section>
    );
  }
  return (
    <form className="card rv-feedback" onSubmit={send}>
      <h2>Anything the store should know?</h2>
      <p className="rv-feedback-note">Private. This goes only to the store and is never shown on the shop.</p>
      <label className="rv-sr" htmlFor="rv-feedback-box">Your feedback</label>
      <textarea id="rv-feedback-box" rows={3} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Delivery, packing, or anything else about this order" />
      {said ? <p className="refused" role="alert">{said}</p> : null}
      <button type="submit" className="go quiet" disabled={busy}>{busy ? 'Sending' : 'Send to the store'}</button>
    </form>
  );
}
