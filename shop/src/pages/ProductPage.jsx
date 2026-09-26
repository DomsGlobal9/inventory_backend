import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getProduct, money, askOnWhatsApp, shareThis , offerWords } from '../api';
import DeliveryCheck from '../components/DeliveryCheck';
import TellTheShop from '../components/TellTheShop';
import { addToBag, useBag } from '../bag';
import { Problem, Say } from '../components/States';
/* Fetched only when somebody presses the button: most shoppers never do, and it carries a
   file reader and a whole sheet with it. */
const TryOn = lazy(() => import('../components/TryOn'));
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
 * One strip, one shape on every screen: the big photograph, and a rail of small ones lying down
 * underneath it. The rail used to stand upright beside the picture on a laptop and lie down only
 * on a phone, so the same shop looked like two different shops depending on what you opened it
 * on. Sideways everywhere -- dragged with a finger on a phone or a tablet, with the trackpad or
 * the thumbnails themselves on a laptop.
 */
function Gallery({ photos, title }) {
  const strip = useRef(null);
  const rail = useRef(null);
  const [at, setAt] = useState(0);

  // Back to the first photograph whenever the set changes -- choosing green should show the green
  // one, not photograph four of the red.
  useEffect(() => {
    setAt(0);
    if (strip.current) strip.current.scrollLeft = 0;
    if (rail.current) rail.current.scrollLeft = 0;
  }, [photos.map(p => p.url).join('|')]);

  // Swipe to photograph six and the marked thumbnail is off the end of the rail, so the rail is
  // saying nothing. Nudge it back into view -- by hand, with scrollLeft, rather than with
  // scrollIntoView, which is entitled to scroll the whole PAGE to do the same job.
  useEffect(() => {
    const el = rail.current;
    const btn = el?.children?.[at];
    if (!el || !btn) return;
    const left = btn.offsetLeft;
    const right = left + btn.offsetWidth;
    if (left < el.scrollLeft) el.scrollTo({ left: Math.max(0, left - 8), behavior: 'smooth' });
    else if (right > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: right - el.clientWidth + 8, behavior: 'smooth' });
    }
  }, [at]);

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

        {/*
          Where you are in the set.

          Without it the rail reads as though it were repeating the big photograph -- the first
          thumbnail IS the picture on show, and with nothing saying so it just looks like the same
          photograph twice. "1 / 5" makes the rail obviously a position, not a copy.
        */}
        {photos.length > 1 && (
          <div className="photonum" aria-hidden="true">{at + 1} / {photos.length}</div>
        )}
      </div>

      {photos.length > 1 && (
        <div className="rolls" ref={rail} role="tablist" aria-label="Photographs">
          {photos.map((img, i) => (
            <button key={img.url} type="button" role="tab" aria-selected={i === at}
              aria-label={i === at ? `Photograph ${i + 1}, showing now` : `Photograph ${i + 1}`}
              onClick={() => show(i)}>
              <img src={img.url} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
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
   * The photographs OF THE COLOUR ON SCREEN. Not the other colours'.
   *
   * This used to show every photograph the piece had, merely ordering the chosen colour's first
   * -- which was the right call back when a photograph belonged to the product as a whole and
   * hiding any of them meant hiding the only ones there were. Now that each colour has its own,
   * it reads as a mistake: a shopper looking at the green saree scrolled the rail and found
   * yellow ones underneath, as if the shop had muddled its stock.
   *
   * Photographs with no colour at all are kept alongside. Older products still have some, and
   * they are genuinely of the piece rather than of one colour -- the fabric, the border, the weave.
   */
  const all = p.images ?? [];
  const forColour = colour
    ? choices.variants.filter(v => v.colour === colour).map(v => v.variantCode)
    : [];
  const mine = all.filter(img => !img.variantCode || forColour.includes(img.variantCode));

  /*
   * The safety net, and the reason this is a filter with a fallback rather than a plain filter:
   * a colour nobody has photographed yet would otherwise leave the page with no picture on it.
   * Showing another colour is not ideal; showing a shopper an empty grey box is worse.
   */
  const shown = mine.length > 0 ? mine : all;

  const rank = (img) => {
    if (chosen && img.variantCode === chosen.variantCode) return 0;   // this exact size and colour
    if (img.variantCode && forColour.includes(img.variantCode)) return 1; // this colour
    if (!img.variantCode) return 2;                                    // the piece as a whole
    return 3;                                                          // another colour, only ever
  };                                                                   // reached by the fallback
  const photos = [...shown]
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
              {/*
                The shop's offer on THIS size, which is a different thing from the strike-through
                above: that is the list price against the selling price. This comes off in the bag,
                and until now the only way to find out was to put the piece in the bag and look --
                so a shopper comparing two shops never knew this one was cheaper.

                Read from the chosen piece rather than the product, because an offer can cover one
                size and not another, and this is the moment they are choosing.
              */}
              {chosen.offer ? (
                <p className="dealline">{offerWords(chosen.offer, currency)}</p>
              ) : null}
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
                {choices.colours.map(c => {
                  // Why it cannot be pressed, not just that it cannot. Greyed at 0.4 opacity says
                  // "no" to somebody looking at it and nothing at all to somebody listening to it,
                  // and even by eye a dimmed swatch reads as easily "not chosen" as "sold out".
                  const gone = !soldOut && !canBuy(c.name, size) && !canBuy(c.name, null);
                  return (
                  <button key={c.name} type="button" className="opt" aria-pressed={colour === c.name}
                    /*
                     * Shown as gone, NOT switched off.
                     *
                     * Disabling it meant a shopper who came for the rust saree could not select
                     * it, could not see its photographs, and could not tell the shop they wanted
                     * it -- the one moment a shop learns about demand it has no other way to
                     * see. Buying is still refused; looking and asking are not.
                     */
                    data-gone={gone ? 'true' : undefined}
                    title={gone ? `${c.name} — sold out` : undefined}
                    aria-label={gone ? `${c.name}, sold out` : undefined}
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
                  );
                })}
              </div>
            </div>
          )}

          {choices.sizes.length > 1 && (
            <div className="pick">
              <p>Size{size ? <>: <b>{size}</b></> : ''}</p>
              <div className="opts">
                {choices.sizes.map(s => {
                  const gone = !soldOut && !canBuy(colour, s);
                  return (
                    <button key={s} type="button" className="opt" aria-pressed={size === s}
                      data-gone={gone ? 'true' : undefined}
                      title={gone ? `${s} — sold out${colour ? ` in ${colour}` : ''}` : undefined}
                      aria-label={gone ? `${s}, sold out${colour ? ` in ${colour}` : ''}` : undefined}
                      onClick={() => setSize(s)}>{s}</button>
                  );
                })}
              </div>
            </div>
          )}

          {/*
            "Only 3 left", when the shop has asked to say it.
            
            Placed under the size and above the buttons, which is where the decision is made. The
            number arrives already capped by the server -- a shop with two hundred sarees sends
            nothing at all -- so this only ever prints a handful, and null means "say nothing"
            rather than "none": sold out is its own state above.
          */}
          {chosen?.fewLeft ? (
            <p className="few">
              {chosen.fewLeft === 1 ? 'Last one left' : `Only ${chosen.fewLeft} left`}
            </p>
          ) : null}

          {/* The buttons where a shop puts them: under the size, not floating over the page. */}
          <div ref={watch} className={`buyrow${canAdd ? '' : ' one'}`}>
            {canAdd ? (
              <>
                <button type="button" className={`go quiet${added ? ' done' : ''}`} onClick={() => add(false)}>
                  {added ? <><Ticked /> Added</> : inBag > 0 ? `In bag · ${inBag}` : 'Add to bag'}
                </button>
                <button type="button" className="go" onClick={() => add(true)}>Buy now</button>
              </>
            ) : buying && chosen && !chosen.sellable ? (
              <>
                <button type="button" className="go" disabled>Sold out</button>
                {ask ? <a className="go quiet" href={ask} target="_blank" rel="noopener noreferrer">Ask the shop</a> : null}
                {/* WhatsApp works and people use it, but it leaves the shop nothing to count.
                    This records who is waiting, for the one moment a shop can learn about
                    demand it otherwise never sees. */}
                <TellTheShop slug={slug} product={p} variantCode={chosen?.variantCode}
                  piece={[p.title, chosen?.colour, chosen?.size].filter(Boolean).join(' · ')} />
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

          {/*
            Under the buttons, not floating above the sizes.
            
            On its own it was an outlined pill with nothing to relate to, and its FREE badge
            outweighed its own label. Here it is what it actually is: the thing to do BEFORE
            deciding, grouped with the deciding, and plainly not a third Buy now.
          */}
          {shop?.tryOn && photos.length > 0 ? (
            <button type="button" className="tryonbtn" onClick={() => setTrying(true)}>
              <span className="mark">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M9 4 5 6v5h2.5v7h9v-7H19V6l-4-2" strokeLinejoin="round" />
                  <path d="M9 4a3 3 0 0 0 6 0" strokeLinecap="round" />
                </svg>
              </span>
              <span className="words">
                See it on you
                <small>Put this piece on your own photo</small>
              </span>
              <em>Free</em>
              <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m9.5 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}

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

          {/* Sending ONE piece to somebody, which is how a great deal of this sells: a customer
              forwards a saree to their mother rather than the whole shop. The product page is
              already rendered with its own title and photograph attached, so what lands in the
              chat is a picture and a name, not a bare address.

              navigator.share where the phone has it -- that is the sheet people already know,
              and it offers WhatsApp among everything else. The plain WhatsApp link is the
              fallback for desktop, where the share sheet does not exist. */}
          <button
            type="button"
            className="sharethis"
            onClick={async () => {
              const s = shareThis(shop?.name ?? 'this shop', p);
              try {
                if (navigator.share) { await navigator.share({ title: p.title, text: s.text, url: s.url }); return; }
              } catch { /* they closed the sheet -- not a failure, and not worth a message */ }
              window.open(s.whatsapp, '_blank', 'noopener,noreferrer');
            }}
          >
            <Wa /> Send this to someone
          </button>

          {/* Asked here rather than at the checkout, where the same refusal already waits after
              a name, a number and a full address have been typed in. Renders nothing at all for
              a shop that delivers everywhere. */}
          <DeliveryCheck slug={slug} deliversEverywhere={shop?.buying?.deliversEverywhere !== false} />

          {/* What it is, as rows. A shopper scanning for "is this real silk" should find it. */}
          <div className="spec">
            <h3>Details</h3>
            <dl>
              {p.fabric ? <><dt>Fabric</dt><dd>{p.fabric}</dd></> : null}
              {p.dressType ? <><dt>Type</dt><dd>{p.dressType}</dd></> : null}
              {/* How it was made -- woven, block printed, embroidered. The shop is asked for it
                  while adding the product and it was shown on their own preview, but it never
                  reached the page: the one person actually choosing between two sarees could not
                  see it. For a saree it says more about the price than the brand does. */}
              {p.craft ? <><dt>Made</dt><dd>{p.craft}</dd></> : null}
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
              {/*
                THE PRICE IS NOT REPEATED HERE.

                The bar used to carry its own price block, so on a short page a shopper saw
                ₹3,500 in the page and ₹3,500 again three centimetres below it, which reads as a
                mistake rather than as help. It also took a third of a 393px bar, which is what
                squeezed the buttons until their labels wrapped and the bar changed height.

                The amount now rides on the button that needs it -- somebody who has scrolled past
                the price and is about to press Buy now is exactly who wants reminding, and it is
                the only place it can be said without saying it twice.
              */}
              {canAdd ? (
                <>
                  <button type="button" className={`go quiet${added ? ' done' : ''}`} onClick={() => add(false)}>
                    {added ? <><Ticked /> Added</> : inBag > 0 ? `In bag · ${inBag}` : 'Add to bag'}
                  </button>
                  <button type="button" className="go" onClick={() => add(true)}>
                    Buy now{chosen ? <span className="amt"> · {money(chosen.price, currency)}</span> : null}
                  </button>
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

      {trying ? (
        <Suspense fallback={null}>
          <TryOn slug={slug} product={p} chosen={chosen} onClose={() => setTrying(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
