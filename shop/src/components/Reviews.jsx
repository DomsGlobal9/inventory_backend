import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { addReviewPhoto, getReviews, heldProof, myReview, removeMyReview, saveReview } from '../api';

/**
 * Ratings and reviews on a product page (5 Nov, owner: "the best UI, outstanding").
 *
 * On a laptop the verdict stays in view at the left while the reviews run down the right; on a phone they stack.
 * The bars are the filter: tap 5 to read only the five-star reviews. Buyers' photographs come first, because a
 * photograph of the real thing, on a real person, is what a shopper trusts most.
 * Who may write, and what the shop may do, is decided by the server (services/shop-reviews).
 */

const WORDS = { 1: 'Poor', 2: 'Below average', 3: 'Average', 4: 'Good', 5: 'Loved it' };
const SORTS = [['NEW', 'Newest'], ['HIGH', 'Highest'], ['LOW', 'Lowest']];
const MAX_PHOTOS = 3, MAX_BODY = 1000;
const STAR = 'M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.5l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95z';

/** Stars, filled to any fraction: 4.6 fills the fifth star six-tenths of the way. */
export function Stars({ value = 0, size = 16 }) {
  return (
    <span className="rv-stars" role="img" aria-label={`${value} out of 5 stars`} style={{ '--sz': `${size}px` }}>
      {[1, 2, 3, 4, 5].map(n => {
        const fill = Math.max(0, Math.min(1, value - (n - 1)));
        return (
          <span key={n} className="rv-star">
            <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d={STAR} /></svg>
            <span className="rv-fill" style={{ width: `${fill * 100}%` }}>
              <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d={STAR} /></svg>
            </span>
          </span>
        );
      })}
    </span>
  );
}

const dayOf = (at) => new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** A phone's photograph, made small enough to send, as a JPEG whatever it started as. */
async function shrunk(file) {
  // A data: address, not an object URL: the shop's security policy allows images from data: and refuses blob:.
  const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('unreadable')); r.readAsDataURL(file); });
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('not a picture')); i.src = url; });
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Photographs, full screen: arrows, Escape, or a tap outside. */
function Lightbox({ photos, at, onClose }) {
  const [i, setI] = useState(at);
  const go = useCallback((d) => setI(n => (n + d + photos.length) % photos.length), [photos.length]);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1); };
    document.addEventListener('keydown', key);
    const was = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = was; };
  }, [go, onClose]);
  return createPortal(
    <div className="rv-light" role="dialog" aria-modal="true" aria-label="Customer photo" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button type="button" className="rv-light-x" onClick={onClose} aria-label="Close">×</button>
      {photos.length > 1 ? <button type="button" className="rv-light-go prev" onClick={() => go(-1)} aria-label="Previous photo">‹</button> : null}
      <img src={photos[i]} alt="" />
      {photos.length > 1 ? <button type="button" className="rv-light-go next" onClick={() => go(1)} aria-label="Next photo">›</button> : null}
      {photos.length > 1 ? <span className="rv-light-n">{i + 1} of {photos.length}</span> : null}
    </div>,
    document.body
  );
}

/** Writing or changing a review: a sheet from the foot of a phone, a dialog on a laptop. */
function Composer({ slug, product, variantCode, tagsOffered, existing, onClose, onSaved, onRemoved }) {
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState(existing?.body ?? '');
  const [tags, setTags] = useState(existing?.tags ?? []);
  const [photos, setPhotos] = useState(existing?.photos ?? []);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [sure, setSure] = useState(false);
  const picker = useRef(null);
  const first = useRef(null);
  const shown = hover || rating;
  const refusal = useRef(null);
  // Taps faster than the page redraws: "disabled" only arrives with the next draw, this is at once.
  const working = useRef(false);
  useEffect(() => { if (said) refusal.current?.scrollIntoView({ block: 'nearest' }); }, [said]);

  useEffect(() => {
    first.current?.focus();
    const esc = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', esc);
    const was = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = was; };
  }, [busy, onClose]);

  const addPhotos = async (files) => {
    setSaid(null);
    const room = MAX_PHOTOS - photos.length;
    const list = [...files].slice(0, room);
    if (files.length > room) setSaid(`You can add up to ${MAX_PHOTOS} photos.`);
    for (const file of list) {
      setUploading(n => n + 1);
      try {
        const out = await addReviewPhoto(slug, heldProof(slug), product.productCode, await shrunk(file));
        setPhotos(p => [...p, out.url]);
      } catch (e) {
        // Our own "not a picture" is not a sentence for a customer; the shop's refusals are.
        setSaid(e?.kind === 'RULE' && e?.message ? e.message : 'That photo could not be added. Choose a JPG or PNG.');
      } finally { setUploading(n => n - 1); }
    }
    if (picker.current) picker.current.value = '';
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!rating) { setSaid('Choose a star rating first.'); return; }
    if (working.current) return;
    working.current = true;
    setBusy(true); setSaid(null);
    try {
      const out = await saveReview(slug, heldProof(slug), product.productCode, { rating, body, tags, photos, variantCode });
      onSaved(out);
    } catch (err) {
      working.current = false;
      setSaid(err?.kind === 'RULE' && err?.message ? err.message : 'Your review could not be saved. Please try again.');
      setBusy(false);
    }
  };

  const remove = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true); setSaid(null);
    try { onRemoved(await removeMyReview(slug, heldProof(slug), product.productCode)); }
    catch (err) { working.current = false; setSaid(err?.kind === 'RULE' && err?.message ? err.message : 'Your review could not be removed. Please try again.'); setBusy(false); setSure(false); }
  };

  return createPortal(
    <div className="rv-veil" onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="rv-sheet" role="dialog" aria-modal="true" aria-labelledby="rv-h" onSubmit={submit}>
        <header className="rv-sheet-head">
          <div>
            <h2 id="rv-h">{existing ? 'Edit your review' : 'Write a review'}</h2>
            <p>{product.title}</p>
          </div>
          <button type="button" className="rv-x" onClick={onClose} aria-label="Close" disabled={busy}>×</button>
        </header>

        <div className="rv-sheet-body">
          <fieldset className="rv-pick" onMouseLeave={() => setHover(0)}>
            <legend>Your rating</legend>
            <div className="rv-pick-row">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} type="button" ref={n === 1 ? first : null} className={`rv-pick-star${n <= shown ? ' on' : ''}${n === rating ? ' just' : ''}`}
                  aria-label={`${n} ${n === 1 ? 'star' : 'stars'}: ${WORDS[n]}`} aria-pressed={n === rating}
                  onMouseEnter={() => setHover(n)} onClick={() => { setRating(n); setSaid(null); }}>
                  <svg viewBox="0 0 24 24" width="38" height="38" aria-hidden="true"><path d={STAR} /></svg>
                </button>
              ))}
            </div>
            <span className="rv-pick-word" aria-live="polite">{shown ? WORDS[shown] : 'Tap a star'}</span>
          </fieldset>

          <div className="rv-field">
            <span className="rv-label">What stood out?</span>
            <div className="rv-chips">
              {tagsOffered.map(t => {
                const on = tags.includes(t);
                return <button key={t} type="button" className={`rv-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setTags(x => on ? x.filter(v => v !== t) : [...x, t])}>{t}</button>;
              })}
            </div>
          </div>

          <div className="rv-field">
            <label className="rv-label" htmlFor="rv-body">Your review <em>Optional</em></label>
            <textarea id="rv-body" rows={4} maxLength={MAX_BODY} value={body} onChange={(e) => setBody(e.target.value)} placeholder="The fabric, the colour, the fit. What would you tell a friend?" />
            {body.length > MAX_BODY - 100 ? <small className="rv-count">{MAX_BODY - body.length} characters left</small> : null}
          </div>

          <div className="rv-field">
            <span className="rv-label">Photos <em>Up to {MAX_PHOTOS}</em></span>
            <div className="rv-tiles">
              {photos.map(u => (
                <span key={u} className="rv-tile">
                  <img src={u} alt="" />
                  <button type="button" onClick={() => setPhotos(p => p.filter(x => x !== u))} aria-label="Remove this photo">×</button>
                </span>
              ))}
              {Array.from({ length: uploading }).map((_, i) => <span key={i} className="rv-tile rv-uploading" role="status" aria-label="Adding photo" />)}
              {photos.length + uploading < MAX_PHOTOS ? (
                <button type="button" className="rv-tile rv-add" onClick={() => picker.current?.click()} aria-label="Add a photo">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.4-2h5.2L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.500z" /><circle cx="12" cy="12.8" r="3.3" /></svg>
                  <span>Add</span>
                </button>
              ) : null}
              <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
            </div>
            <small className="rv-hint">Location details are removed from your photos.</small>
          </div>

          {said ? <p ref={refusal} className="refused" role="alert">{said}</p> : null}
        </div>

        <footer className="rv-sheet-foot">
          {existing ? (
            sure ? (
              <span className="rv-sure">
                <span>Remove your review?</span>
                <button type="button" className="rv-link danger" disabled={busy} onClick={remove}>Yes, remove</button>
                <button type="button" className="rv-link" disabled={busy} onClick={() => setSure(false)}>Keep it</button>
              </span>
            ) : <button type="button" className="rv-link danger" disabled={busy} onClick={() => setSure(true)}>Remove review</button>
          ) : <span className="rv-note">Shown with your first name. Your number is never shown.</span>}
          <button type="submit" className="go rv-submit" disabled={busy || uploading > 0}>
            {busy ? 'Saving' : uploading ? 'Adding photo' : existing ? 'Save changes' : 'Submit review'}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}

function ReviewCard({ r, onPhoto }) {
  const [open, setOpen] = useState(false);
  const long = (r.body?.length ?? 0) > 280;
  return (
    <article className="rv-card">
      <header>
        <Stars value={r.rating} size={15} />
        <span className="rv-word">{WORDS[r.rating]}</span>
        <time dateTime={r.at}>{dayOf(r.at)}</time>
      </header>
      {r.body ? (
        <p className={`rv-body${long && !open ? ' clipped' : ''}`}>{r.body}</p>
      ) : null}
      {long ? <button type="button" className="rv-more" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Show less' : 'Read more'}</button> : null}
      {r.tags?.length ? <div className="rv-tags">{r.tags.map(t => <span key={t}>{t}</span>)}</div> : null}
      {r.photos?.length ? (
        <div className="rv-card-photos">
          {r.photos.map((u, i) => (
            <button key={u} type="button" onClick={() => onPhoto(r.photos, i)} aria-label={`Open photo ${i + 1} of ${r.photos.length}`}>
              <img src={u} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      ) : null}
      <footer>
        <span className="rv-who">{r.name || 'Customer'}</span>
        <span className="rv-verified">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.500" /></svg>
          Verified buyer
        </span>
        {r.variant ? <span className="rv-variant">{r.variant}</span> : null}
        {r.edited ? <span className="rv-variant">Edited</span> : null}
      </footer>
      {r.reply ? (
        <blockquote className="rv-reply">
          <b>Reply from the store</b>
          <p>{r.reply.text}</p>
        </blockquote>
      ) : null}
    </article>
  );
}

export default function Reviews({ slug, shop, product, variantCode, onSummary }) {
  const code = product.productCode;
  const where = useLocation();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState({ loading: true, data: null, error: false });
  const [reviews, setReviews] = useState([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('NEW');
  const [rating, setRating] = useState(null);
  const [more, setMore] = useState(false);
  const [me, setMe] = useState(null);
  const [writing, setWriting] = useState(false);
  const [thanks, setThanks] = useState(null);
  const [light, setLight] = useState(null);
  const section = useRef(null);
  const asked = params.get('review') === '1';

  const load = useCallback(async (n, append, signal) => {
    if (append) setMore(true);
    try {
      const data = await getReviews(slug, code, { page: n, sort, rating }, { signal });
      setState({ loading: false, data, error: false });
      setReviews(was => (append ? [...was, ...data.reviews.filter(r => !was.some(x => x.id === r.id))] : data.reviews));
      setPage(n);
      onSummary?.(data.summary);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      setState(s => ({ ...s, loading: false, error: !s.data }));
    } finally { if (append) setMore(false); }
  }, [slug, code, sort, rating, onSummary]);

  useEffect(() => { const ac = new AbortController(); void load(1, false, ac.signal); return () => ac.abort(); }, [load]);

  const readMine = useCallback(async () => {
    const token = heldProof(slug);
    if (!token) { setMe({ signedIn: false, canReview: false, review: null }); return null; }
    const out = await myReview(slug, token, code).catch(() => ({ signedIn: false, canReview: false, review: null }));
    setMe(out);
    return out;
  }, [slug, code]);
  useEffect(() => { void readMine(); }, [readMine]);

  // Arriving from "Rate this item" on an order: straight to the section, with the form open once we know they may.
  useEffect(() => {
    if (!asked || !me) return;
    // Signed out: straight to signing in, and back here with the form open.
    if (!me.signedIn && shop?.accounts !== false) { nav(`/${slug}/account`, { replace: true, state: { back: where.pathname + where.search, why: 'review' } }); return; }
    section.current?.scrollIntoView({ block: 'start' });
    if (me.canReview) setWriting(true);
    const next = new URLSearchParams(params); next.delete('review'); setParams(next, { replace: true, preventScrollReset: true });
  }, [asked, me]); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = async (out) => {
    await Promise.all([load(1, false), readMine()]);
    setWriting(false);
    setThanks(out.hidden ? 'Your changes are saved. This review is not showing on the shop just now.' : 'Thank you. Your review is on the shop now.');
  };
  const removed = async () => {
    await Promise.all([load(1, false), readMine()]);
    setWriting(false);
    setThanks('Your review has been removed.');
  };

  if (state.error) return null;    // The reviews failing to load must never get in the way of buying.
  const s = state.data?.summary;
  const none = !state.loading && !s?.count;
  const allPhotos = reviews.flatMap(r => r.photos ?? []);
  const signInState = { back: where.pathname + where.search + (where.search ? '&' : '?') + 'review=1', why: 'review' };

  // Nothing to read and nothing they can do: no section at all. An empty "Ratings and reviews" box and
  // "Bought this?" are noise to somebody looking at a saree (owner, 5 Nov). It appears with the first
  // review, or for the one person who received this item, once we know that is who they are.
  if (state.loading) return null;
  if (none && !me?.canReview && !me?.review && !thanks) return null;

  const cta = me?.review ? (
    <button type="button" className="rv-cta quiet" onClick={() => setWriting(true)}>Edit your review</button>
  ) : me?.canReview ? (
    <button type="button" className="rv-cta" onClick={() => setWriting(true)}>Write a review</button>
  ) : me && !me.signedIn && shop?.accounts !== false ? (
    <Link className="rv-cta quiet" to={`/${slug}/account`} state={signInState}>Bought this? Sign in to review</Link>
  ) : null;

  return (
    <section className="rv" id="reviews" ref={section} aria-labelledby="rv-title">
      <div className="rv-verdict">
        <h2 id="rv-title">Ratings and reviews</h2>
        {none ? (
          <div className="rv-first">
            <Stars value={0} size={26} />
            <p>Be the first to review this item.</p>
          </div>
        ) : (
          <>
            <div className="rv-score">
              <b>{Number(s.average).toFixed(1)}</b>
              <div>
                <Stars value={s.average} size={20} />
                <span>{s.count === 1 ? '1 verified buyer' : `${s.count} verified buyers`}</span>
              </div>
            </div>
            <div className="rv-bars" role="group" aria-label="Filter by rating">
              {[5, 4, 3, 2, 1].map(n => {
                const c = s.counts[n] ?? 0;
                const on = rating === n;
                return (
                  <button key={n} type="button" className={`rv-bar${on ? ' on' : ''}`} aria-pressed={on} disabled={!c}
                    aria-label={`${n} star: ${c} ${c === 1 ? 'review' : 'reviews'}`} onClick={() => setRating(on ? null : n)}>
                    <span className="rv-bar-n">{n}<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d={STAR} /></svg></span>
                    <span className="rv-track"><i style={{ width: `${s.count ? (c / s.count) * 100 : 0}%` }} /></span>
                    <span className="rv-bar-c">{c}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {cta}
        {me?.review?.hidden ? <p className="rv-cta-note">Your review is not showing on the shop just now. The store hid it.</p> : null}
      </div>

      <div className="rv-list">
        {thanks ? <p className="rv-thanks" role="status">{thanks}</p> : null}
        {allPhotos.length ? (
          <div className="rv-gallery" aria-label="Photos from customers">
            {allPhotos.slice(0, 8).map((u, i) => (
              <button key={u} type="button" onClick={() => setLight({ photos: allPhotos, at: i })} aria-label={`Open customer photo ${i + 1}`}>
                <img src={u} alt="" loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        ) : null}
        {!none && !state.loading ? (
          <div className="rv-tools">
            <span aria-live="polite">{rating ? `Showing ${rating}-star reviews` : 'All reviews'}{rating ? <button type="button" onClick={() => setRating(null)}>Clear</button> : null}</span>
            <div className="rv-sorts" role="group" aria-label="Sort reviews">
              {SORTS.map(([k, label]) => <button key={k} type="button" className={sort === k ? 'on' : ''} aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>)}
            </div>
          </div>
        ) : null}
        {reviews.map(r => <ReviewCard key={r.id} r={r} onPhoto={(photos, at) => setLight({ photos, at })} />)}
        {state.data?.hasMore ? (
          <button type="button" className="rv-loadmore" disabled={more} onClick={() => load(page + 1, true)}>{more ? 'Loading' : 'Show more reviews'}</button>
        ) : null}
      </div>

      {writing ? (
        <Composer slug={slug} product={product} variantCode={variantCode} tagsOffered={state.data?.tagsOffered ?? []}
          existing={me?.review} onClose={() => setWriting(false)} onSaved={saved} onRemoved={removed} />
      ) : null}
      {light ? <Lightbox photos={light.photos} at={light.at} onClose={() => setLight(null)} /> : null}
    </section>
  );
}
