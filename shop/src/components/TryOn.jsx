import React, { useRef, useState } from 'react';
import { tryOn } from '../api';
import { Working } from '../components/Motion';

/**
 * "See it on you."
 *
 * A shopper picks a photograph of themselves and sees the piece on it. Their photograph goes to the
 * shop's server, is used once, and is deleted -- said plainly on the sheet, because asking somebody
 * for a picture of themselves without saying what happens to it is not a reasonable thing to do.
 *
 * THIS IS THE MOMENT THE SHOP IS SELLING. A customer who sees a ₹45,000 saree on themselves has
 * decided something, and the screen they decide it on should not look like a file dialog. So the
 * result gets the whole sheet, on a dark backdrop that takes the shop away, with a hold-to-compare
 * that puts their own photograph back for as long as they press -- which is the thing everybody
 * does anyway, and the thing that makes the difference obvious.
 *
 * Nothing is uploaded until they press the button: choosing a photograph shows it here, on their
 * own phone, and they can change their mind. Every try-on costs the shop a generation from its own
 * allowance, so this is deliberately one photograph at a time rather than a live camera.
 */

const MAX_BYTES = 12 * 1024 * 1024;

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('That photograph could not be read.'));
  r.readAsDataURL(file);
});

/*
 * Whether this device has a camera worth offering.
 *
 * `pointer: coarse` is a better question than sniffing the user agent: it asks whether the thing
 * being used is a finger, which on every phone and tablet also means there is a camera in it. A
 * laptop gets the plain file picker, because "take a photo" on a desktop opens a webcam pointed at
 * somebody's face from forty centimetres away, which is no use for a saree.
 */
const hasCamera = () => {
  try { return window.matchMedia?.('(pointer: coarse)')?.matches === true; }
  catch { return false; }
};

export default function TryOn({ slug, product, onClose }) {
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [onPhone] = useState(hasCamera);
  const [photo, setPhoto] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  /* Held down: their own photograph, for as long as they press. */
  const [comparing, setComparing] = useState(false);

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

  /* Pressed, not toggled: a compare you have to hold is a compare nobody has to undo. */
  const hold = { onPointerDown: () => setComparing(true), onPointerUp: () => setComparing(false),
    onPointerLeave: () => setComparing(false), onPointerCancel: () => setComparing(false) };

  return (
    <div className={`sheet${result ? ' showing' : ''}`} role="dialog" aria-modal="true"
      aria-label={`See ${product.title} on you`}>
      <div className="sheetin">
        <div className="sheethead">
          <h2>{result ? product.title : 'See it on you'}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {result ? (
          <>
            <div className="tryshot big">
              <img src={result} alt={`${product.title}, on you`} />
              {/* Their own photograph, on top, while the compare is held. */}
              <img className="under" src={photo} alt="" data-show={comparing} />
              <button type="button" className="compare" {...hold}
                aria-label="Hold to see your own photograph">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M12 3v18M8 7 4 11l4 4M16 7l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {comparing ? 'Your photo' : 'Hold to compare'}
              </button>
            </div>
            <p className="tiny">
              A picture made by a computer, to give you an idea. The real thing may sit differently.
            </p>
            <div className="sheetrow">
              <button type="button" className="go quiet" onClick={() => { setResult(null); setPhoto(null); }}>
                Another photo
              </button>
              <a className="go" href={result} target="_blank" rel="noopener noreferrer">Open it</a>
            </div>
          </>
        ) : photo ? (
          <>
            <div className="tryshot"><img src={photo} alt="The photograph you chose" /></div>
            {said ? <p className="refused">{said}</p> : null}
            <div className="sheetrow">
              <button type="button" className="go quiet" disabled={busy}
                onClick={() => (onPhone ? cameraRef.current : fileRef.current)?.click()}>
                {onPhone ? 'Retake' : 'Choose another'}
              </button>
              <button type="button" className="go" disabled={busy} onClick={go}>
                {busy ? 'Working…' : 'See it on me'}
              </button>
            </div>
            {busy ? <p className="tiny">Putting it on you <Working /></p> : null}
          </>
        ) : (
          <>
            {/* What to aim for, drawn rather than described -- three words each, and a figure. */}
            <div className="howto">
              <div>
                <svg viewBox="0 0 40 56" fill="none" aria-hidden="true">
                  <rect x="1" y="1" width="38" height="54" rx="5" stroke="currentColor" strokeWidth="1.6" opacity=".35" />
                  <circle cx="20" cy="17" r="6" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M20 24v20M13 30l7-6 7 6M14 52l6-8M26 52l-6-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <span>Head to toe</span>
              </div>
              <div>
                <svg viewBox="0 0 40 56" fill="none" aria-hidden="true">
                  <rect x="1" y="1" width="38" height="54" rx="5" stroke="currentColor" strokeWidth="1.6" opacity=".35" />
                  <path d="M20 8v40" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 4" opacity=".5" />
                  <circle cx="20" cy="18" r="5.5" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M20 24v18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <span>Facing forward</span>
              </div>
              <div>
                <svg viewBox="0 0 40 56" fill="none" aria-hidden="true">
                  <rect x="1" y="1" width="38" height="54" rx="5" stroke="currentColor" strokeWidth="1.6" opacity=".35" />
                  <circle cx="20" cy="18" r="5.5" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M20 24v18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M6 46h28" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity=".45" />
                </svg>
                <span>Plain wall</span>
              </div>
            </div>

            <p className="why">
              Your photograph is used once to make the picture and then deleted. The shop does not
              keep it.
            </p>
            {said ? <p className="refused">{said}</p> : null}

            {/* On a phone the camera comes first, because the photograph does not exist yet --
                somebody deciding about a saree is far more likely to take one than to go hunting
                through a gallery. On a laptop it is only ever the picker. */}
            {onPhone ? (
              <div className="sheetrow">
                <button type="button" className="go quiet" onClick={() => fileRef.current?.click()}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="15" rx="2.5" strokeLinejoin="round" />
                    <path d="m3 16 5-5 4 4 3-3 6 6" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="9" cy="10" r="1.6" />
                  </svg>
                  Gallery
                </button>
                <button type="button" className="go" onClick={() => cameraRef.current?.click()}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
                    <circle cx="12" cy="13.5" r="3.6" />
                  </svg>
                  Take a photo
                </button>
              </div>
            ) : (
              <button type="button" className="go" onClick={() => fileRef.current?.click()}>
                Choose a photograph
              </button>
            )}
          </>
        )}

        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp"
          onChange={choose} style={{ display: 'none' }} aria-label="Choose a photograph of yourself" />
        {/* `capture` with no value lets the device offer whichever camera suits -- a full-length
            try-on is usually somebody else holding the phone, which is the back one. Forcing the
            front camera would make that impossible. */}
        <input ref={cameraRef} type="file" accept="image/jpeg,image/png,image/webp" capture
          onChange={choose} style={{ display: 'none' }} aria-label="Take a photograph" />
      </div>
    </div>
  );
}
