import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toJpeg } from '../tryphoto';

/**
 * The camera inside the try-on sheet (13 Nov).
 *
 * "Take a photo" used to hand over to the phone's own camera app. On a phone short of memory Android closes the
 * browser while the camera app is open, and on "OK" the shopper got "memory too low, the operation was not done"
 * and lost everything. Here the camera runs inside the page, so the shop is never put in the background, and the
 * frame is captured straight at 2048 px.
 *
 * Every way it can go wrong ends in something the shopper can do:
 *   - no camera support (an old browser, not https)  -> the phone's own camera, or the Gallery
 *   - permission refused                               -> how to allow it, or the phone's own camera / Gallery
 *   - camera busy (another app) or not found           -> try again, or the phone's own camera / Gallery
 *   - they switch apps                                  -> the camera is let go; "Start the camera" brings it back
 * The shutter fires once: a second tap while the photo is being made does nothing.
 */
const CAN = () => !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');

function why(err) {
  const n = err?.name ?? '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera permission is off for this shop. Allow the camera in your browser settings, or use one of these instead.';
  if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return 'The camera is busy in another app. Close that app and try again, or use one of these instead.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'No camera was found on this device. Use the Gallery instead.';
  return 'The camera could not start. Use one of these instead.';
}

export const cameraWorksHere = CAN;

/** A camera's first frames can be a tiny placeholder (2 x 2): wait (up to 5 s) for a picture of real size. */
const MIN_SIDE = 64;
/** The camera's own picture size: known from the camera itself, painted or not (Android, Chrome). */
const trackSize = (s) => { const st = s?.getVideoTracks?.()[0]?.getSettings?.() ?? {}; return { w: st.width ?? 0, h: st.height ?? 0 }; };
const canGrab = () => typeof window.ImageCapture === 'function';
function realPicture(v, stillMine, s) {
  return new Promise(resolve => {
    const until = Date.now() + 5000;
    const look = () => {
      if (!stillMine()) return resolve(false);
      // The camera stopped by itself (unplugged, taken by another app): no point waiting.
      if (s?.getVideoTracks?.()[0]?.readyState === 'ended') return resolve(false);
      if (v.videoWidth >= MIN_SIDE && v.videoHeight >= MIN_SIDE) return resolve(true);
      // Where the picture can be taken from the camera itself, its own size is enough.
      const t = trackSize(s);
      if (canGrab() && s?.getVideoTracks?.()[0]?.readyState === 'live' && t.w >= MIN_SIDE && t.h >= MIN_SIDE) return resolve(true);
      if (Date.now() > until) return resolve(false);
      setTimeout(look, 60);
    };
    look();
  });
}

export default function Camera({ onShot, onCancel, onPhoneCamera, onGallery }) {
  const video = useRef(null);
  const stream = useRef(null);
  const taking = useRef(false);
  const [facing, setFacing] = useState('environment');
  const [state, setState] = useState('starting'); // starting | live | paused | failed | taking
  const [problem, setProblem] = useState(null);
  // The screen state as of now, for handlers that must not read a stale one.
  const shown = useRef(state);
  shown.current = state;

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  /*
   * Only the newest start may keep a camera. Opening a camera takes a moment; if the sheet closed, the camera was
   * flipped, or the screen redrew meanwhile, an older start finishing late would otherwise leave a camera running
   * that nothing can switch off -- the phone's camera light stays on and the memory stays taken.
   */
  const turn = useRef(0);
  const start = useCallback(async (which) => {
    const mine = ++turn.current;
    stop();
    setState('starting'); setProblem(null);
    if (!CAN()) { setState('failed'); setProblem('This browser cannot open the camera here. Use one of these instead.'); return; }
    try {
      const ask = () => navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: which }, width: { ideal: 1920 }, height: { ideal: 1920 } }
      });
      // The camera just let go (a flip, Retake, coming back) is not always free again at once: some phones answer
      // "busy" or "not found" for a moment. Asked again twice, a little later; a refused permission never is.
      let s;
      for (let attempt = 0; ; attempt++) {
        try { s = await ask(); break; }
        catch (err) {
          const again = attempt < 2 && ['NotFoundError', 'NotReadableError', 'AbortError', 'TrackStartError'].includes(err?.name);
          if (!again || mine !== turn.current) throw err;
          await new Promise(r => setTimeout(r, attempt === 0 ? 350 : 900));
          if (mine !== turn.current) return;
        }
      }
      if (mine !== turn.current || !video.current) { s.getTracks().forEach(t => t.stop()); return; }
      stream.current = s;
      // The camera stopped by itself (a phone call, another app took it): say so, with a way to start it again.
      s.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (mine !== turn.current || stream.current !== s) return;
        turn.current++; stop(); taking.current = false;
        setProblem('The camera stopped. Start it again to take the photo.'); setState('paused');
      });
      video.current.srcObject = s;
      // Not awaited: playback can stall (a phone saving power, a browser holding video back) and must never
      // hold the camera on "Opening"; readiness is judged from the picture itself, below.
      video.current.play().catch(() => undefined);
      const shows = await realPicture(video.current, () => mine === turn.current && !!video.current, s);
      if (mine !== turn.current) return;
      if (!shows) { stop(); setState('failed'); setProblem('The camera opened but shows no picture. Try the camera again, or use one of these instead.'); return; }
      setState('live');
    } catch (err) {
      if (mine !== turn.current) return;
      stop();
      setState('failed'); setProblem(why(err));
    }
  }, [stop]);

  // Closing (or a newer start) moves the turn on, so a camera still opening switches itself off when it arrives.
  // Asked a moment later, not at once: a mount that is undone straight away (React does this in development, and a
  // fast flip does it on a phone) then never asks at all. Two camera requests at the same moment can leave the
  // camera unusable on some phones ("not found" or "busy" on the next ask).
  useEffect(() => {
    const t = window.setTimeout(() => { void start(facing); }, 0);
    return () => { window.clearTimeout(t); turn.current++; stop(); };
  }, [facing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switched to another app: let the camera go (it is the phone's, not ours), and offer to start it again.
  useEffect(() => {
    const away = () => { if (document.hidden && shown.current !== 'failed') { turn.current++; stop(); setProblem(null); setState('paused'); } };
    document.addEventListener('visibilitychange', away);
    return () => document.removeEventListener('visibilitychange', away);
  }, [stop]);

  const shoot = () => {
    const v = video.current;
    const grabbable = canGrab() && stream.current?.getVideoTracks?.()[0]?.readyState === 'live';
    if (taking.current || state !== 'live' || !v || (!grabbable && (v.videoWidth < MIN_SIDE || v.videoHeight < MIN_SIDE))) return;
    taking.current = true;
    setState('taking');
    const fromVideo = () => toJpeg(v, v.videoWidth, v.videoHeight);
    const take = async () => {
      const track = stream.current?.getVideoTracks?.()[0];
      if (track && canGrab()) {
        try { const bmp = await new window.ImageCapture(track).grabFrame(); try { return toJpeg(bmp, bmp.width, bmp.height); } finally { bmp.close?.(); } }
        catch { /* the video, below */ }
      }
      if (v.videoWidth < MIN_SIDE || v.videoHeight < MIN_SIDE) throw new Error('The camera shows no picture yet. Please try again.');
      return fromVideo();
    };
    void (async () => { try {
      const shot = await take();
      stop();
      onShot(shot);
    } catch (err) {
      taking.current = false;
      setState('failed'); setProblem(err?.message ?? 'The photo could not be taken. Please try again.');
    } })();
  };

  const cancel = () => { turn.current++; stop(); onCancel(); };

  return (
    <div className="camera" data-state={state}>
      <div className="viewfinder" data-front={facing === 'user'}>
        <video ref={video} playsInline muted autoPlay aria-label="Camera" />
        {/* Where to stand: a head-to-toe outline to fill. */}
        {state === 'live' ? <span className="guide" aria-hidden="true" /> : null}
        {state === 'starting' ? <p className="camsay" role="status">Opening the camera…</p> : null}
        {state === 'paused' ? (
          <div className="camsay">
            <p>{problem ?? 'The camera was paused while you were away.'}</p>
            <button type="button" className="go" onClick={() => start(facing)}>Start the camera</button>
          </div>
        ) : null}
        {state === 'failed' ? (
          <div className="camsay" role="alert">
            <p>{problem}</p>
            <div className="sheetrow">
              {onPhoneCamera ? <button type="button" className="go quiet" onClick={() => { stop(); onPhoneCamera(); }}>Phone camera</button> : null}
              <button type="button" className="go quiet" onClick={() => { stop(); onGallery(); }}>Gallery</button>
            </div>
            {CAN() ? <button type="button" className="again" onClick={() => start(facing)}>Try the camera again</button> : null}
          </div>
        ) : null}
      </div>
      <div className="camrow">
        <button type="button" className="again" onClick={cancel}>Cancel</button>
        <button type="button" className="shutter" onClick={shoot} disabled={state !== 'live'}
          aria-label="Take the photo"><i aria-hidden="true" /></button>
        <button type="button" className="flip" disabled={state !== 'live'}
          onClick={() => setFacing(f => (f === 'user' ? 'environment' : 'user'))}
          aria-label={facing === 'user' ? 'Use the back camera' : 'Use the front camera'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
            <path d="M9 13.5a3 3 0 0 1 5.2-2M15 13.5a3 3 0 0 1-5.2 2" /><path d="M14.4 9.6v1.9h-1.9M9.6 17.4v-1.9h1.9" />
          </svg>
        </button>
      </div>
    </div>
  );
}
