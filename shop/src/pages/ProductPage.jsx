import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getProduct, money, askOnWhatsApp } from '../api';
import { Problem, Say } from '../components/States';

/**
 * One piece: its photographs, its colours and sizes, and the way to ask about it.
 *
 * Phase 1 has no basket and no payment. "Ask on WhatsApp" IS the order -- it opens a chat with the
 * shop with the piece and its code already typed, which is how these shops already sell. So that
 * button is the most important thing on the page: it is docked to the bottom of the screen, under
 * the thumb, and it stays useful even when the piece is sold out, because "do you have this in
 * red?" is exactly the conversation a shop wants.
 */

/** A colour name a browser understands, for the little dot; anything else just gets the word. */
const SWATCHES = /^(?:[a-z]+|#[0-9a-f]{3,8})$/i;

/** What is worth saying about the saving: shoppers compare the percentage, not the difference. */
function saving(now, was) {
  const a = Number(now), b = Number(was);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round(((b - a) / b) * 100);
}

/** The photographs, swiped, with the shape reserved before any of them arrive. */
function Gallery({ photos, title }) {
  const strip = useRef(null);
  const [at, setAt] = useState(0);

  // A piece with no photograph is a real state, not a page still loading. A breathing skeleton
  // that never resolves tells a shopper the shop is broken, so it says what is true instead.
  if (!photos.length) {
    return (
      <div className="gallery">
        <div className="swipe">
          <figure style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 13 }}>
            No photograph of this one yet
          </figure>
        </div>
      </div>
    );
  }

  return (
    <div className="gallery">
      <div className="swipe" ref={strip}
        onScroll={e => setAt(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}>
        {photos.map((img, i) => (
          <figure key={img.url}>
            <img src={img.url} alt={i === 0 ? title : ''}
              loading={i === 0 ? 'eager' : 'lazy'} decoding="async" />
          </figure>
        ))}
      </div>
      {photos.length > 1 && (
        <div className="pips" aria-label={`Photo ${at + 1} of ${photos.length}`}>
          {photos.map((_, i) => <i key={i} data-on={i === at} />)}
        </div>
      )}
    </div>
  );
}

export default function ProductPage({ slug, shop }) {
  const { code } = useParams();
  const [state, setState] = useState({ loading: true, error: null, product: null });
  const [nonce, setNonce] = useState(0);
  const [colour, setColour] = useState(null);
  const [size, setSize] = useState(null);

  useEffect(() => {
    const ac = new AbortController();
    setState({ loading: true, error: null, product: null });
    setColour(null); setSize(null);
    window.scrollTo({ top: 0 });
    getProduct(slug, code, { signal: ac.signal })
      .then(product => setState({ loading: false, error: null, product }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, product: null }); });
    return () => ac.abort();
  }, [slug, code, nonce]);

  const p = state.product;

  /** The colours and sizes this piece comes in, in the order the shop entered them. */
  const choices = useMemo(() => {
    const variants = p?.variants ?? [];
    const colours = [];
    const sizes = [];
    for (const v of variants) {
      if (v.colour && !colours.includes(v.colour)) colours.push(v.colour);
      if (v.size && !sizes.includes(v.size)) sizes.push(v.size);
    }
    return { variants, colours, sizes };
  }, [p]);

  // Start on something a customer can actually buy, rather than on a sold-out colour that makes
  // the shop look empty.
  useEffect(() => {
    if (!p) return;
    const first = p.variants.find(v => v.sellable) ?? p.variants[0];
    if (first) { setColour(c => c ?? first.colour ?? null); setSize(s => s ?? first.size ?? null); }
  }, [p]);

  const matches = (v, c, s) => (c == null || v.colour === c) && (s == null || v.size === s);
  const chosen = choices.variants.find(v => matches(v, colour, size)) ?? choices.variants[0] ?? null;
  const canBuy = (c, s) => choices.variants.some(v => matches(v, c, s) && v.sellable);

  if (state.loading) {
    return (
      <div className="piece">
        <div className="gallery"><div className="swipe"><figure className="bone" /></div></div>
        <div>
          <div className="bone" style={{ height: 24, width: '72%', margin: '18px 0 12px', borderRadius: 5 }} />
          <div className="bone" style={{ height: 16, width: '40%', borderRadius: 5 }} />
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <>
        <Problem error={state.error} shopName={shop?.name} onRetry={() => setNonce(n => n + 1)} />
        <div style={{ textAlign: 'center', paddingBottom: 40 }}>
          <Link className="go quiet" style={{ display: 'inline-flex' }} to={`/${slug}`}>See the whole shop</Link>
        </div>
      </>
    );
  }

  if (!p) return <Say title="That is no longer in this shop" />;

  const photos = p.images?.length ? p.images : [];
  const currency = chosen?.currency ?? 'INR';
  const ask = askOnWhatsApp(shop?.whatsapp, shop?.name, p);
  const soldOut = !choices.variants.some(v => v.sellable);
  const was = chosen && Number(chosen.compareAtPrice) > Number(chosen.price) ? chosen.compareAtPrice : null;
  const off = was ? saving(chosen.price, was) : null;

  return (
    <>
      <p style={{ margin: '12px 0 0', fontSize: 13 }}>
        <Link to={`/${slug}`} style={{ color: 'var(--muted)' }}>← Everything in the shop</Link>
      </p>

      <div className="piece">
        <Gallery photos={photos} title={p.title} />

        <div>
          <h1>{p.title}</h1>
          <p className="of">{[p.fabric, p.dressType, p.brand].filter(Boolean).join(' · ') || p.productCode}</p>

          {chosen && (
            <>
              <div className="cost">
                <span className="now">{money(chosen.price, currency)}</span>
                {was ? <span className="was">{money(was, currency)}</span> : null}
                {off ? <span className="off">{off}% off</span> : null}
              </div>
              <p className="tax">Inclusive of all taxes</p>
            </>
          )}

          {soldOut ? (
            <p className="tax" style={{ color: 'var(--muted)', marginTop: -12 }}>
              Sold out just now — ask the shop, they may be getting more.
            </p>
          ) : null}

          {choices.colours.length > 1 && (
            <div className="pick">
              <p>Colour{colour ? <>: <b>{colour}</b></> : ''}</p>
              <div className="opts">
                {choices.colours.map(c => (
                  <button key={c} type="button" className="opt" aria-pressed={colour === c}
                    disabled={!soldOut && !canBuy(c, size) && !canBuy(c, null)}
                    onClick={() => {
                      setColour(c);
                      // Moving to a colour that does not come in the chosen size would leave the
                      // page showing a combination nobody can buy: take the size that does exist.
                      if (size != null && !canBuy(c, size)) {
                        const fits = choices.variants.find(v => v.colour === c && v.sellable)
                          ?? choices.variants.find(v => v.colour === c);
                        setSize(fits?.size ?? null);
                      }
                    }}>
                    {SWATCHES.test(c) ? <span className="swatch" style={{ background: c.toLowerCase() }} /> : null}
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {choices.sizes.length > 1 && (
            <div className="pick">
              <p>Size{size ? <>: <b>{size}</b></> : ''}</p>
              <div className="opts">
                {choices.sizes.map(s => (
                  <button key={s} type="button" className="opt" aria-pressed={size === s}
                    disabled={!soldOut && !canBuy(colour, s)}
                    onClick={() => setSize(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {p.description ? (
            <div className="why">
              <h3>About this piece</h3>
              <p>{p.description}</p>
            </div>
          ) : null}

          {/* The quiet promises every shop these customers use already makes on its product page. */}
          <div className="sure">
            <div>✓ Sold by {shop?.name || 'the shop'}</div>
            <div>✓ Ask before you buy</div>
            <div>✓ Code {p.productCode}</div>
          </div>

          {/*
            The whole of Phase 1's selling, in one button, kept under the thumb. The price is
            repeated beside it because by the time a shopper has scrolled to the description the
            figure has gone off the top of the screen.
          */}
          {/* No number to chat on means there is nothing for a docked button to do, so the bar is
              not shown at all -- an empty bar across the bottom of every page would only take up
              the screen and make the shop look broken. The shopper is told instead. */}
          {!ask ? (
            <p className="tax" style={{ marginTop: 18 }}>
              This shop has not given a number to chat on yet. Its details are at the bottom of
              this page.
            </p>
          ) : (
          <div className="dock">
            <div className="in">
              {chosen ? (
                <div className="amt">
                  <b>{money(chosen.price, currency)}</b>
                  {was ? <span>{money(was, currency)} · {off}% off</span> : <span>Inclusive of taxes</span>}
                </div>
              ) : null}
              <a className="go" href={ask} target="_blank" rel="noopener noreferrer">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.13h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.21-8.24 8.21Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.17.24-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.11-.23-.17-.48-.29Z" />
                  </svg>
                  {soldOut ? 'Ask if it is coming back' : 'Ask on WhatsApp'}
              </a>
            </div>
          </div>
          )}
        </div>
      </div>
    </>
  );
}
