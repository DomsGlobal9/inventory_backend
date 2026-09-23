import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getProduct, money, askOnWhatsApp } from '../api';
import { addToBag, useBag } from '../bag';
import { Problem, Say } from '../components/States';
import TryOn from '../components/TryOn';
import { Ticked } from '../components/Motion';
import AlsoIn from '../components/AlsoIn';

/**
 * One piece: its photographs, the colours and sizes it comes in, and the way to buy it.
 *
 * COLOUR IS REAL HERE. The swatch is the shade the shop itself recorded against that variant, and
 * the photographs change with it, because a shop that took a photograph of the green saree meant
 * it to be seen when green is chosen. Where a shop recorded no shade, the word alone is shown --
 * guessing a colour from its name would put a browser's idea of "maroon" next to a photograph of
 * the shop's maroon, and they are not the same colour.
 *
 * Sizes and colours a customer cannot actually buy are struck through rather than hidden: a shop
 * that stocks S, M and L and has sold out of M should look like a shop that stocks three sizes.
 */

/** The WhatsApp mark, used wherever the shop offers a chat. */
const Wa = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.13h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.21-8.24 8.21Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.17.24-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.11-.23-.17-.48-.29Z" />
  </svg>
);

/** What is worth saying about the saving: shoppers compare the percentage, not the difference. */
function saving(now, was) {
  const a = Number(now), b = Number(was);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round(((b - a) / b) * 100);
}

/**
 * The photographs.
 *
 * One strip, read two ways. On a phone it is swiped and the pips say where you are; on a wide
 * screen the same strip gets a column of thumbnails beside it, because a mouse has no thumb and
 * because that vertical space is otherwise wasted next to a tall photograph.
 */
function Gallery({ photos, title }) {
  const strip = useRef(null);
  const [at, setAt] = useState(0);

  // Back to the first photograph whenever the set changes -- choosing green should show the green
  // one, not photograph four of the red.
  useEffect(() => {
    setAt(0);
    if (strip.current) strip.current.scrollLeft = 0;
  }, [photos.map(p => p.url).join('|')]);

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

  const show = (i) => {
    const el = strip.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  return (
    <div className="gallery" data-many={photos.length > 1}>
      {photos.length > 1 && (
        <div className="rolls" role="tablist" aria-label="Photographs">
          {photos.map((img, i) => (
            <button key={img.url} type="button" role="tab" aria-selected={i === at}
              aria-label={`Photograph ${i + 1}`} onClick={() => show(i)}>
              <img src={img.url} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}

      <div className="frame">
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
    </div>
  );
}

export default function ProductPage({ slug, shop }) {
  const { code } = useParams();
  const nav = useNavigate();
  const bag = useBag(slug);
  const [state, setState] = useState({ loading: true, error: null, product: null });
  const [nonce, setNonce] = useState(0);
  const [colour, setColour] = useState(null);
  const [size, setSize] = useState(null);
  const [added, setAdded] = useState(false);
  const [trying, setTrying] = useState(false);

  /*
   * The sticky bar exists for the shopper who has scrolled past the buttons, and for nobody else.
   * Shown always, it repeated the price three centimetres below where the page already said it,
   * which on a short page reads as a mistake rather than as help.
   */
  const buttons = useRef(null);
  const [dock, setDock] = useState(false);
  const watch = useCallback((node) => {
    buttons.current = node;
    if (!node || typeof IntersectionObserver !== 'function') return;
    const eye = new IntersectionObserver(([e]) => setDock(!e.isIntersecting), { rootMargin: '-70px 0px 0px 0px' });
    eye.observe(node);
    return () => eye.disconnect();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setState({ loading: true, error: null, product: null });
    setColour(null); setSize(null); setAdded(false); setTrying(false);
    window.scrollTo({ top: 0 });
    getProduct(slug, code, { signal: ac.signal })
      .then(product => setState({ loading: false, error: null, product }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, product: null }); });
    return () => ac.abort();
  }, [slug, code, nonce]);

  const p = state.product;

  /**
   * The colours and sizes this piece comes in, in the order the shop entered them.
   *
   * A colour carries the shop's own shade, taken from the first variant of that colour that has
   * one -- a shop usually records it once and leaves the other sizes blank.
   */
  const choices = useMemo(() => {
    const variants = p?.variants ?? [];
    const colours = [];
    const sizes = [];
    for (const v of variants) {
      if (v.colour && !colours.some(c => c.name === v.colour)) colours.push({ name: v.colour, hex: v.colourHex ?? null });
      else if (v.colour && v.colourHex) {
        const found = colours.find(c => c.name === v.colour);
        if (found && !found.hex) found.hex = v.colourHex;
      }
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

  /*
   * EVERY photograph the shop took, with the ones of the chosen colour first.
   *
   * This used to pick one group and show only that, which meant a piece with five photographs
   * showed ONE of them the moment a single photograph happened to be attached to the chosen
   * variant -- the other four simply vanished, with no way for the shopper to reach them. A shop
   * that photographs each colour still gets a gallery that follows the choice, because those
   * photographs come first; nothing is hidden to achieve it.
   */
  const all = p.images ?? [];
  const forColour = colour
    ? choices.variants.filter(v => v.colour === colour).map(v => v.variantCode)
    : [];
  const rank = (img) => {
    if (chosen && img.variantCode === chosen.variantCode) return 0;   // this exact size and colour
    if (img.variantCode && forColour.includes(img.variantCode)) return 1; // this colour
    if (!img.variantCode) return 2;                                    // the piece as a whole
    return 3;                                                          // another colour
  };
  const photos = [...all]
    .map((img, i) => ({ img, i, r: rank(img) }))
    // Stable inside each group, so the shop's own ordering is kept.
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.img);

  const currency = chosen?.currency ?? 'INR';
  const ask = askOnWhatsApp(shop?.whatsapp, shop?.name, p);
  const soldOut = !choices.variants.some(v => v.sellable);
  const was = chosen && Number(chosen.compareAtPrice) > Number(chosen.price) ? chosen.compareAtPrice : null;
  const off = was ? saving(chosen.price, was) : null;

  const buying = shop?.buying?.open === true;
  const inBag = chosen ? bag.find(l => l.variantCode === chosen.variantCode)?.quantity ?? 0 : 0;
  const canAdd = buying && chosen && chosen.sellable;

  const add = (thenGo) => {
    if (!canAdd) return;
    addToBag(slug, chosen.variantCode, 1, {
      title: p.title, size: chosen.size, colour: chosen.colour, colourHex: chosen.colourHex
    });
    if (thenGo) nav(`/${slug}/bag`);
    else { setAdded(true); window.setTimeout(() => setAdded(false), 2200); }
  };

  return (
    <>
      <p className="crumbs">
        <Link to={`/${slug}`}>Everything in the shop</Link>
        {p.category ? <> <span>›</span> <Link to={`/${slug}?category=${encodeURIComponent(p.category)}`}>
          {p.category.charAt(0) + p.category.slice(1).toLowerCase()}</Link></> : null}
      </p>

      <div className="piece">
        <Gallery photos={photos} title={p.title} />

        <div>
          <h1>{p.title}</h1>
          <p className="of">{[p.fabric, p.dressType, p.brand].filter(Boolean).join(' · ') || p.productCode}</p>

          {chosen && (
            <>
              <div className="pricebox">
                <span className="now">{money(chosen.price, currency)}</span>
                {was ? <span className="was">{money(was, currency)}</span> : null}
                {off ? <span className="cut">{off}% OFF</span> : null}
              </div>
              <p className="tax">Inclusive of all taxes</p>
            </>
          )}

          {soldOut ? (
            <p className="tax" style={{ color: 'var(--muted)', marginTop: -12 }}>
              Sold out just now — ask the shop, they may be getting more.
            </p>
          ) : null}

          {/* Offered only where the shop switched it on and the platform can do it, so the button
              never exists unless pressing it would work. */}
          {shop?.tryOn && photos.length > 0 ? (
            <button type="button" className="tryonbtn" onClick={() => setTrying(true)}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M9 4 5 6v5h2.5v7h9v-7H19V6l-4-2" strokeLinejoin="round" />
                <path d="M9 4a3 3 0 0 0 6 0" strokeLinecap="round" />
              </svg>
              See it on you
              <em>free</em>
            </button>
          ) : null}

          {choices.colours.length > 1 && (
            <div className="pick">
              <p>Colour{colour ? <>: <b>{colour}</b></> : ''}</p>
              <div className="opts">
                {choices.colours.map(c => (
                  <button key={c.name} type="button" className="opt" aria-pressed={colour === c.name}
                    disabled={!soldOut && !canBuy(c.name, size) && !canBuy(c.name, null)}
                    onClick={() => {
                      setColour(c.name);
                      // Moving to a colour that does not come in the chosen size would leave the
                      // page showing a combination nobody can buy: take the size that does exist.
                      if (size != null && !canBuy(c.name, size)) {
                        const fits = choices.variants.find(v => v.colour === c.name && v.sellable)
                          ?? choices.variants.find(v => v.colour === c.name);
                        setSize(fits?.size ?? null);
                      }
                    }}>
                    {/* The shop's own shade, or nothing at all rather than a guess. */}
                    {c.hex ? <span className="swatch" style={{ background: c.hex }} /> : null}
                    {c.name}
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

          {/* The buttons where a shop puts them: under the size, not floating over the page. */}
          <div ref={watch} className={`buyrow${canAdd ? '' : ' one'}`}>
            {canAdd ? (
              <>
                <button type="button" className={`go quiet${added ? ' done' : ''}`} onClick={() => add(false)}>
                  {added ? <><Ticked /> Added</> : inBag > 0 ? `In your bag (${inBag})` : 'Add to bag'}
                </button>
                <button type="button" className="go" onClick={() => add(true)}>Buy now</button>
              </>
            ) : buying && chosen && !chosen.sellable ? (
              <>
                <button type="button" className="go" disabled>Sold out</button>
                {ask ? <a className="go quiet" href={ask} target="_blank" rel="noopener noreferrer">Ask the shop</a> : null}
              </>
            ) : ask ? (
              <a className="go" href={ask} target="_blank" rel="noopener noreferrer">
                <Wa /> {soldOut ? 'Ask if it is coming back' : 'Ask on WhatsApp'}
              </a>
            ) : (
              <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
                This shop has not given a number to chat on yet.
              </p>
            )}
          </div>

          {/* What the shop promises about getting it there -- its own terms, read from its own
              settings, so a shop that changes them changes this. */}
          <div className="promise">
            {buying ? (
              <div>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" strokeLinejoin="round" />
                  <circle cx="7" cy="18" r="1.6" /><circle cx="17.5" cy="18" r="1.6" />
                </svg>
                <div style={{ display: 'block' }}>
                  <b>{shop.buying.deliveryFee > 0 ? `Delivery ${money(shop.buying.deliveryFee, currency)}` : 'Free delivery'}</b>
                  <span>
                    {shop.buying.deliveryFee > 0 && shop.buying.freeDeliveryAbove
                      ? `Free on orders over ${money(shop.buying.freeDeliveryAbove, currency)}`
                      : 'Delivered to your address'}
                    {shop.buying.payWays?.includes('ON_DELIVERY') ? ' · Pay when it arrives' : ''}
                  </span>
                </div>
              </div>
            ) : null}
            <div>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M12 3l7 3v5.5c0 4-3 7.5-7 8.5-4-1-7-4.5-7-8.5V6l7-3Z" strokeLinejoin="round" />
              </svg>
              <div style={{ display: 'block' }}>
                <b>Sold by {shop?.seller?.name || shop?.name}</b>
                <span>{shop?.returnPolicy ? 'Returns as set out at the bottom of this page' : 'Ask the shop before you buy'}</span>
              </div>
            </div>
          </div>

          {/* What it is, as rows. A shopper scanning for "is this real silk" should find it. */}
          <div className="spec">
            <h3>Details</h3>
            <dl>
              {p.fabric ? <><dt>Fabric</dt><dd>{p.fabric}</dd></> : null}
              {p.dressType ? <><dt>Type</dt><dd>{p.dressType}</dd></> : null}
              {p.brand ? <><dt>Brand</dt><dd>{p.brand}</dd></> : null}
              {chosen?.colour ? <><dt>Colour</dt><dd>{chosen.colour}</dd></> : null}
              {chosen?.size ? <><dt>Size</dt><dd>{chosen.size}</dd></> : null}
              <dt>Code</dt><dd>{p.productCode}</dd>
            </dl>
            {p.description ? <p>{p.description}</p> : null}
          </div>

          {/*
            The bar under the thumb. What it offers depends on the shop: one that takes orders gets
            a real Add to bag and Buy now; one that does not gets the WhatsApp chat that Phase 1
            sold with, because for that shop the chat IS the order.
          */}
          <div className="dock" data-show={dock}>
            <div className="in">
              {chosen ? (
                <div className="amt">
                  <b>{money(chosen.price, currency)}</b>
                  {was ? <span>{money(was, currency)} · {off}% off</span> : <span>Inclusive of taxes</span>}
                </div>
              ) : null}

              {canAdd ? (
                <>
                  <button type="button" className={`go quiet${added ? ' done' : ''}`} onClick={() => add(false)}>
                    {added ? <><Ticked /> Added</> : inBag > 0 ? `In your bag (${inBag})` : 'Add to bag'}
                  </button>
                  <button type="button" className="go" onClick={() => add(true)}>Buy now</button>
                </>
              ) : buying && chosen && !chosen.sellable ? (
                <>
                  <button type="button" className="go" disabled>Sold out</button>
                  {ask ? <a className="go quiet" href={ask} target="_blank" rel="noopener noreferrer">Ask the shop</a> : null}
                </>
              ) : ask ? (
                <a className="go" href={ask} target="_blank" rel="noopener noreferrer">
                  <Wa /> {soldOut ? 'Ask if it is coming back' : 'Ask on WhatsApp'}
                </a>
              ) : (
                <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
                  This shop has not given a number to chat on yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The page carries on being a shop rather than stopping at the description. */}
      <AlsoIn slug={slug} product={p} shop={shop} />

      {trying ? <TryOn slug={slug} product={p} onClose={() => setTrying(false)} /> : null}
    </>
  );
}
