import React, { useRef, useState } from 'react';
import { tryOn } from '../api';

/**
 * "See it on you."
 *
 * A shopper picks a photograph of themselves and sees the piece on it. The photograph goes to the
 * shop's server, is used once, and is deleted -- said plainly on the sheet, because asking somebody
 * for a picture of themselves without saying what happens to it is not a reasonable thing to do.
 *
 * Nothing is uploaded until they press the button: choosing a photograph shows it here, on their
 * own phone, and they can change their mind. Every try-on costs the shop a generation from its own
 * allowance, so this is deliberately one button and one photograph rather than a live camera.
 */

const MAX_BYTES = 12 * 1024 * 1024;

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('That photograph could not be read.'));
  r.readAsDataURL(file);
});

export default function TryOn({ slug, product, onClose }) {
  const fileRef = useRef(null);
  const [photo, setPhoto] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);

  const choose = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) { setSaid('That photograph is very large. Choose a smaller one.'); return; }
    if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
      setSaid('This is an iPhone HEIC photo. Share it as a JPEG and choose it again.');
      return;
    }
    try { setPhoto(await readAsDataUrl(file)); setSaid(null); setResult(null); }
    catch (err) { setSaid(err?.message ?? 'That photograph could not be read.'); }
  };

  const go = async () => {
    setBusy(true); setSaid(null);
    try {
      const out = await tryOn(slug, product.productCode, photo);
      setResult(out.imageUrl);
    } catch (err) {
      setSaid(err?.message ?? 'That did not work. Please try another photograph.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={`See ${product.title} on you`}>
      <div className="sheetin">
        <div className="sheethead">
          <h2>See it on you</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {result ? (
          <>
            <div className="tryshot"><img src={result} alt={`${product.title}, on you`} /></div>
            <p className="tiny">
              A picture made by a computer, to give you an idea. The real thing may sit differently.
            </p>
            <div className="sheetrow">
              <button type="button" className="go quiet" onClick={() => { setResult(null); setPhoto(null); }}>
                Try another photo
              </button>
              <a className="go" href={result} target="_blank" rel="noopener noreferrer" download>Save it</a>
            </div>
          </>
        ) : photo ? (
          <>
            <div className="tryshot"><img src={photo} alt="The photograph you chose" /></div>
            {said ? <p className="refused">{said}</p> : null}
            <div className="sheetrow">
              <button type="button" className="go quiet" disabled={busy} onClick={() => fileRef.current?.click()}>
                Choose another
              </button>
              <button type="button" className="go" disabled={busy} onClick={go}>
                {busy ? 'Putting it on you…' : 'See it on me'}
              </button>
            </div>
            {busy ? <p className="tiny">This takes a few seconds.</p> : null}
          </>
        ) : (
          <>
            <p className="why">
              Pick a full-length photograph of yourself, taken straight on, with a plain background
              if you can. It is used once to make the picture and then deleted — the shop does not
              keep it.
            </p>
            {said ? <p className="refused">{said}</p> : null}
            <button type="button" className="go" onClick={() => fileRef.current?.click()}>
              Choose a photograph
            </button>
          </>
        )}

        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp"
          onChange={choose} style={{ display: 'none' }} aria-label="Choose a photograph of yourself" />
      </div>
    </div>
  );
}
