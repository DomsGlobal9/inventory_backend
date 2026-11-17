import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getLook, getReels, money, offerWords } from '../api';
import { addToBag, getBag, useBag, bagCount } from '../bag';
import { wishlistOn } from '../account';
import Tile, { saving } from '../components/Tile';
import Shot from '../components/Shot';
import Heart from '../components/Heart';
import { canResize, sized, widths } from '../photo';
import { shownPrice, perWord, lengthText } from '../units';
import { Problem, Say } from '../components/States';

/**
 * shop.scaleezy.com/<shop>/look/<code> -- the pieces from one of the shop's reels (PLAN-reel-links.md).
 *
 * 17 Nov 2026, the owner's choice "A. Frames" (PLAN-reel-shop-redesign-mockups.html): the page moves like the reel it
 * came from. One piece fills the screen -- its photograph, then everything needed to buy it under the thumb -- and a
 * swipe brings the next. The bars at the top say where you are in the reel. The last frame is the whole look: every
 * piece in a row, what is in the bag, the total, and the shop's other reels.
 *
 * 18 Nov 2026, the owner on the laptop view ("not good": words floating in empty white): a laptop gets "B. Like a
 * shopping site" (PLAN-reel-laptop-mockups.html) -- the shop's light header, the reel's pieces as small pictures down
 * the left, the photograph, and the details from the top of the right-hand side. The phone stays as chosen, with one
 * addition the owner asked for: the first frame SAYS to swipe up, until the shopper has.
 *
 * Opened from Instagram's own small browser, so: no sign-in to look, one request, today's prices and stock. The page
 * scrolls inside its own frame (not the document), so that browser's bars never slide about and a frame is always
 * exactly one screen. Sold-out pieces come last (the server orders them) and offer WhatsApp. A link the shop switched
 * off is never a dead end: it shows new arrivals. Classes are "lk-" only: the shop's stylesheet is one global sheet.
 */

const MEASURED = new Set(['METRE', 'KILOGRAM']);
const sameColour = (a, b) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
const calm = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The widths a full-screen photograph is offered at (a tile's four are too small for a whole phone screen). */
const FRAME = [540, 720, 1080, 1440];

/** The piece's colours in the shop's order, each with its shade and whether any of it can still be bought. */
function coloursOf(p) {
  const out = [];
  for (const v of p.variants ?? []) {
    if (!v.colour) continue;
    const have = out.find(c => sameColour(c.name, v.colour));
    if (have) { have.sellable = have.sellable || !!v.sellable; have.hex = have.hex ?? v.colourHex ?? null; }
    else out.push({ name: v.colour, hex: v.colourHex ?? null, sellable: !!v.sellable });
  }
  return out;
}

/** The colour a frame opens on: the one worn in the reel while it can be bought, else the first that can. */
function startColour(p) {
  const all = coloursOf(p);
  if (!all.length) return null;
  const worn = p.reelColour ? all.find(c => sameColour(c.name, p.reelColour)) : null;
  if (worn?.sellable) return worn.name;
  return (all.find(c => c.sellable) ?? worn ?? all[0]).name;
}

/** Everything a frame says about one piece in one colour, worked out once. */
function describe(p, colour) {
  const variants = p.variants ?? [];
  const mine = colour ? variants.filter(v => sameColour(v.colour, colour)) : variants;
  const shown = mine.length ? mine : variants;
  const buyable = shown.filter(v => v.sellable);
  const priced = shown.map(v => Number(v.price)).filter(Number.isFinite);
  const from = priced.length ? Math.min(...priced) : null;
  const was = Math.max(-Infinity, ...shown.map(v => Number(v.compareAtPrice)).filter(Number.isFinite));
  const off = Number.isFinite(was) ? saving(from, was) : null;
  const measured = MEASURED.has(p.soldBy);
  // "Only 2 left" is said of ONE thing: the single size this colour comes in, or a length of cloth. With several sizes
  // (five S, two M) it would be true of one of them and read as true of all.
  const few = buyable.length === 1 || measured ? buyable.map(v => v.fewLeft).filter(n => n != null) : [];
  // The shop's own live offer, said only when every size of this colour that can be bought gets the very same one
  // (an offer that covers only the large would be a promise the small cannot keep).
  const deals = buyable.map(v => v.offer).filter(Boolean);
  const same = (a, b) => a.kind === b.kind && Number(a.value) === Number(b.value) && (a.name ?? '') === (b.name ?? '');
  const deal = !measured && buyable.length > 0 && deals.length === buyable.length && deals.every(o => same(o, deals[0])) ? deals[0] : null;
  // This colour's photograph, else one of the piece as a whole, else the shop's first (the same rule as the strip).
  const images = p.images ?? [];
  const codes = new Set(mine.map(v => v.variantCode));
  const photo = (mine.length && colour ? images.find(i => i.variantCode && codes.has(i.variantCode)) ?? images.find(i => !i.variantCode) : null) ?? images[0] ?? null;
  return {
    shown, buyable, from, off, deal,
    spread: priced.length > 1 && Math.min(...priced) !== Math.max(...priced),
    was: off ? was : null,
    fewLeft: few.length ? Math.min(...few) : null,
    currency: variants[0]?.currency ?? 'INR',
    photo, measured,
    soldOut: !variants.some(v => v.sellable),
    /*
     * The one variant a tap can put in the bag without asking: this colour, buyable, and the only size it comes in.
     * A colour that comes in S, M and L with only M left is NOT this: the shopper is asked, so nobody gets an M by
     * pressing a button that never mentioned a size.
     */
    only: !measured && buyable.length === 1 && shown.filter(v => v.size).length <= 1 ? buyable[0] : null
  };
}

const pieceUrl = (slug, p, colour) =>
  `/${slug}/p/${encodeURIComponent(p.productCode)}${colour ? `?colour=${encodeURIComponent(colour)}` : ''}`;

/** "Tissue silk saree": what it is, as one would say it. */
const kindOf = (p) => {
  const words = [p.fabric, p.dressType].filter(Boolean).map(w => String(w).trim()).filter(Boolean);
  if (!words.length) return '';
  return [words[0], ...words.slice(1).map(w => w.toLowerCase())].join(' ');
};

const Tick = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
const Down = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);

/**
 * The band at the top of every frame: where you are in the reel, whose shop this is, the reel itself, the bag.
 * Each frame carries its own, so it travels with its photograph and never sits over the next frame's words.
 */
function Band({ slug, shop, total = 0, lit = 0, onGo, reelUrl, reelName, solid, flow }) {
  const n = bagCount(slug);
  return (
    <div className={`lk-band${solid ? ' solid' : ''}${flow ? ' flow' : ''}`}>
      {total > 1 ? (
        // A picture of the place in the reel; the words "2 of 3 in this reel" say it to a screen reader.
        <div className="lk-segs" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <button key={i} type="button" tabIndex={-1} className={i < lit ? 'on' : ''} onClick={() => onGo?.(i)} />
          ))}
        </div>
      ) : null}
      <div className="lk-bandrow">
        <Link className="lk-shopname" to={`/${slug}`}>{shop.name}</Link>
        {/* On a laptop the band is the shop's header, with room to say which reel this is. */}
        {reelName ? <span className="lk-reelname">{reelName}</span> : null}
        {/* The reel on Instagram itself (17 Nov, the owner: a link, not a pop-up, for shoppers). */}
        {reelUrl ? <a className="lk-watch" href={reelUrl} target="_blank" rel="noreferrer"><i aria-hidden="true" />Watch reel</a> : null}
        <Link className="lk-bag" to={`/${slug}/bag`} aria-label={n > 0 ? `Your bag, ${n} ${n === 1 ? 'item' : 'items'}` : 'Your bag'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M5.3 8.2h13.4l1.2 11.4a1.7 1.7 0 0 1-1.7 1.9H5.8a1.7 1.7 0 0 1-1.7-1.9Z" strokeLinejoin="round" />
            <path d="M8.7 8.2V6.6a3.3 3.3 0 0 1 6.6 0v1.6" strokeLinecap="round" />
          </svg>
          {n > 0 ? <em aria-hidden="true">{n > 9 ? '9+' : n}</em> : null}
        </Link>
      </div>
    </div>
  );
}

/**
 * A frame's photograph, filling it. The small copy first; if the storage cannot make one, the original; if that
 * cannot be had either, the same quiet words a piece with no photograph gets -- never a broken-picture icon.
 */
function FramePhoto({ src, alt, eager }) {
  const [state, setState] = useState(src ? 'waiting' : 'none');
  const [whole, setWhole] = useState(false);
  const small = !whole && canResize(src);
  if (!src || state === 'failed') {
    return (
      <span className="lk-nophoto">
        <svg width="46" height="46" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20.6 11.4a3.6 3.6 0 1 1 5.2 3.2c-1.1.6-1.8 1.4-1.8 2.6v1" />
          <path d="M24 18.2 6.9 30.6c-1.7 1.2-.8 3.9 1.3 3.9h31.6c2.1 0 3-2.7 1.3-3.9L24 18.2Z" />
        </svg>
        Photo coming soon
      </span>
    );
  }
  return (
    <img className="lk-img" data-state={state} alt={alt}
      src={small ? sized(src, 1080) : src}
      srcSet={small ? widths(src, FRAME) : undefined}
      sizes={small ? '(min-width: 900px) 70vh, 100vw' : undefined}
      loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : 'auto'} decoding="async"
      onLoad={() => setState('here')}
      onError={() => (small ? setWhole(true) : setState('failed'))} />
  );
}

/** Choose a colour and size for one piece, from the bottom of the screen, as the big shopping apps do. */
function ChooseSheet({ slug, p, start, onClose, onAdded }) {
  const variants = (p.variants ?? []);
  const colours = [...new Set(variants.map(v => v.colour).filter(Boolean))];
  const can = (c) => variants.some(v => sameColour(v.colour, c) && v.sellable);
  const startColourHere = colours.find(c => sameColour(c, start) && can(c)) ?? colours.find(can) ?? colours[0] ?? null;
  const [colour, setColour] = useState(startColourHere);
  const ofColour = variants.filter(v => !colours.length || sameColour(v.colour, colour));
  const sizes = ofColour.filter(v => v.size);
  /* What is chosen for the shopper when they open the sheet or change colour: the only buyable size if there is just
     one ("Free"), so nobody has to tap the one choice there is; with several sizes, none until they pick. */
  const startFor = (of) => {
    const buyable = of.filter(v => v.sellable);
    if (!of.some(v => v.size)) return buyable[0]?.variantCode ?? null;
    return of.filter(v => v.size).length === 1 && buyable.length === 1 ? buyable[0].variantCode : null;
  };
  const [variantCode, setVariantCode] = useState(() => startFor(ofColour));
  const chosen = variants.find(v => v.variantCode === variantCode) ?? null;
  const box = useRef(null);
  const d = describe(p, colour);

  useEffect(() => {
    const was = document.activeElement;
    box.current?.focus();
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); was?.focus?.(); };
  }, [onClose]);

  const pickColour = (c) => {
    setColour(c);
    setVariantCode(startFor(variants.filter(v => sameColour(v.colour, c))));
  };
  const add = () => {
    if (!chosen?.sellable) return;
    addToBag(slug, chosen.variantCode, 1, { title: p.title, size: chosen.size, colour: chosen.colour, colourHex: chosen.colourHex });
    onAdded(p);
  };

  return (
    <div className="lk-sheetwrap" onClick={onClose}>
      <div className="lk-sheet" role="dialog" aria-modal="true" aria-label={`Choose for ${p.title}`} tabIndex={-1} ref={box} onClick={e => e.stopPropagation()}>
        <div className="lk-grab" aria-hidden="true" />
        <div className="lk-sheethead">
          <Shot src={d.photo?.url} alt="" ratio="3 / 4" className="lk-sheetshot" sizes="60px" />
          <div>
            <b>{p.title}</b>
            <div className="lk-sheetprice">{money(shownPrice(Number(chosen?.price ?? d.from), p.soldBy), d.currency)}{perWord(p.soldBy)}</div>
          </div>
          <button type="button" className="lk-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        {colours.length > 1 && (
          <>
            <div className="lk-label">Colour: {colour}</div>
            <div className="lk-chips" role="radiogroup" aria-label="Colour">
              {colours.map(c => {
                const hex = variants.find(v => sameColour(v.colour, c))?.colourHex;
                return (
                  <button key={c} type="button" role="radio" aria-checked={sameColour(c, colour)} className={`lk-chip${sameColour(c, colour) ? ' on' : ''}${can(c) ? '' : ' x'}`}
                    onClick={() => pickColour(c)}>
                    {hex ? <i style={{ background: hex }} aria-hidden="true" /> : null}{c}{can(c) ? '' : ', sold out'}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {sizes.length > 0 && (
          <>
            <div className="lk-label">Size</div>
            <div className="lk-chips" role="radiogroup" aria-label="Size">
              {sizes.map(v => (
                <button key={v.variantCode} type="button" role="radio" aria-checked={v.variantCode === variantCode} disabled={!v.sellable}
                  className={`lk-chip${v.variantCode === variantCode ? ' on' : ''}${v.sellable ? '' : ' x'}`} onClick={() => setVariantCode(v.variantCode)}>
                  {v.size}{v.sellable ? '' : ', sold out'}
                </button>
              ))}
            </div>
          </>
        )}
        <button type="button" className="go lk-sheetgo" disabled={!chosen?.sellable} onClick={add}>
          {chosen?.sellable ? 'Add to bag' : sizes.length && !chosen ? 'Choose a size' : 'Sold out in this colour'}
        </button>
      </div>
    </div>
  );
}

/** One piece, one screen. */
function Frame({ slug, shop, look, p, index, total, colour, onColour, next, onGo, buying, hearts, inBagCodes, ask, onAdd, tooSoon, eager, setRef, all, reelName, cue }) {
  const d = describe(p, colour);
  // A long reel's column of pictures scrolls inside itself; each frame's column opens with its own piece in view.
  const rail = useRef(null);
  useEffect(() => {
    const el = rail.current, cur = el?.querySelector('.cur');
    if (el && cur) el.scrollTop = Math.max(0, cur.offsetTop - (el.clientHeight - cur.offsetHeight) / 2);
  }, [index, total]);
  const sizes = [...new Set(d.shown.map(v => v.size).filter(Boolean))];
  const colours = coloursOf(p);
  const worn = p.reelColour ? colours.find(c => sameColour(c.name, p.reelColour)) : null;
  const isWorn = !!worn && sameColour(worn.name, colour);
  const here = d.shown.some(v => inBagCodes.has(v.variantCode));
  const kind = kindOf(p);
  // Shades for every colour: circles. A colour the shop never gave a shade: its name on a chip, for all of them.
  const circles = colours.length > 0 && colours.every(c => c.hex);
  const said = !colour ? null
    : isWorn ? 'As in the reel'
    : worn && !worn.sellable ? `${worn.name}, as in the reel, is sold out` : null;

  /*
   * The colours are one choice, so the keyboard treats them as one: Tab stops on the chosen colour, the arrow keys
   * move to the next and choose it (as round choices do everywhere), and the frame behind stays where it is.
   */
  const colourKeys = (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || colours.length < 2) return;
    e.preventDefault();
    const now = Math.max(0, colours.findIndex(c => sameColour(c.name, colour)));
    const group = e.currentTarget;
    onColour(p, colours[(now + step + colours.length) % colours.length].name);
    window.setTimeout(() => group.querySelector('[aria-checked="true"]')?.focus(), 0);
  };

  const wa = ask(p, colour);
  let action;
  if (d.soldOut) {
    action = wa ? <a className="lk-btn line" href={wa} target="_blank" rel="noreferrer">Ask on WhatsApp</a>
      : <button type="button" className="lk-btn line" disabled>Sold out</button>;
  } else if (!buying) {
    action = wa ? <a className="lk-btn line" href={wa} target="_blank" rel="noreferrer">Order on WhatsApp</a> : null;
  } else if (d.measured) {
    action = <Link className="go lk-btn" to={pieceUrl(slug, p, colour)}>Choose length</Link>;
  } else if (d.buyable.length === 0) {
    action = <button type="button" className="lk-btn line" disabled>Sold out in {String(colour).toLowerCase()}</button>;
  } else if (d.only && inBagCodes.has(d.only.variantCode)) {
    action = <Link className="lk-btn line" to={`/${slug}/bag`} onClick={tooSoon} aria-label={`${p.title} is in your bag. Go to bag`}><Tick />Go to bag</Link>;
  } else {
    action = <button type="button" className="go lk-btn" onClick={() => onAdd(p)}>{d.only ? 'Add to bag' : 'Choose size'}</button>;
  }

  const nextD = next ? describe(next.p, next.colour) : null;
  return (
    <section className={`lk-frame${d.soldOut ? ' gone' : ''}`} ref={setRef} data-piece={p.productCode} aria-label={`${index + 1} of ${total}: ${p.title}`}>
      <Band slug={slug} shop={shop} total={total} lit={index + 1} onGo={onGo} reelUrl={look.reel?.url} reelName={reelName} solid={!d.photo} />
      <div className="lk-stage">
        {total > 1 ? (
          <nav className="lk-rail" aria-label="Pieces in this reel" ref={rail}>
            {all.map((s, i) => (
              <button key={s.p.productCode} type="button" className={`lk-railpic${i === index ? ' cur' : ''}`} onClick={() => onGo(i)}
                aria-label={`${i + 1}: ${s.p.title}`} aria-current={i === index ? 'true' : undefined}>
                {s.d.photo ? <img src={sized(s.d.photo.url, 240)} alt="" loading="lazy" decoding="async" /> : <span>Photo coming soon</span>}
                <em aria-hidden="true">{i + 1}</em>
              </button>
            ))}
            <button type="button" className="lk-railall" onClick={() => onGo(total)}>The whole look</button>
          </nav>
        ) : null}
        <div className="lk-shot">
          <Link to={pieceUrl(slug, p, colour)} aria-label={`${p.title}: photos and details`}>
            <FramePhoto key={d.photo?.url ?? 'none'} src={d.photo?.url} alt={`${p.title}${colour ? `, ${colour}` : ''}`} eager={eager} />
          </Link>
          {d.soldOut ? <span className="lk-flag">Sold out</span> : null}
          {/* A small "scroll down" on the first frame, until the shopper has scrolled once (18 Nov, the owner: small, and
              in the words people use). The button below says where it goes to a screen reader. */}
          {cue ? (
            <span className="lk-swipe" aria-hidden="true">
              Scroll down
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </span>
          ) : null}
        </div>
        <div className="lk-panel">
          <div className="lk-count">
            <span>{total > 1 ? `${index + 1} of ${total} in this reel` : 'From our reel'}</span>
            {here ? <span className="lk-in"><Tick />In your bag</span> : null}
          </div>
          <h2 className="lk-name"><Link to={pieceUrl(slug, p, colour)}>{p.title}</Link></h2>
          {kind ? <div className="lk-meta">{kind}</div> : null}
          {d.from != null && (
            <div className="lk-price">
              {/* Cloth: the price is kept per cm (Rs 4.50), shown per metre (Rs 450 / m) as a shopper reads it. */}
              <b>{d.spread ? 'From ' : ''}{money(shownPrice(d.from, p.soldBy), d.currency)}{perWord(p.soldBy)}</b>
              {d.was ? <><s>{money(shownPrice(d.was, p.soldBy), d.currency)}</s><span className="lk-off">{d.off}% off</span></> : null}
            </div>
          )}
          {/* The shop's offer is taken off in the bag, so it is said only where there is a bag to put this in. */}
          {d.deal && buying ? <div className="lk-deal">{d.deal.name ? <b>{d.deal.name}: </b> : null}{offerWords(d.deal, d.currency)}</div> : null}
          {d.fewLeft != null ? <div className="lk-few">Only {p.soldBy === 'METRE' ? lengthText(d.fewLeft) : d.fewLeft} left</div> : null}
          {colours.length > 0 && (
            <div className={`lk-colours${circles ? '' : ' words'}`}>
              {colours.length > 1 ? (
                <div className="lk-sws" role="radiogroup" aria-label="Colour" onKeyDown={colourKeys}>
                  {colours.map(c => (
                    <button key={c.name} type="button" role="radio" aria-checked={sameColour(c.name, colour)} tabIndex={sameColour(c.name, colour) ? 0 : -1} aria-label={`${c.name}${c.sellable ? '' : ', sold out'}`}
                      className={`${circles ? 'lk-sw' : 'lk-chip'}${sameColour(c.name, colour) ? ' on' : ''}${c.sellable ? '' : ' x'}`}
                      style={circles ? { background: c.hex } : undefined} onClick={() => onColour(p, c.name)}>
                      {circles ? null : c.name}
                    </button>
                  ))}
                </div>
              ) : circles ? <span className="lk-sw still" style={{ background: colours[0].hex }} aria-hidden="true" /> : null}
              {/* Named chips already say the colour; circles need its name beside them. */}
              {circles || colours.length === 1 || said
                ? <span className="lk-swtext">{circles || colours.length === 1 ? colour : null}{said ? <small>{said}</small> : null}</span>
                : null}
            </div>
          )}
          <div className="lk-btns">
            {action}
            {hearts ? <span className="lk-heart"><Heart slug={slug} productCode={p.productCode} variantCode={d.only?.variantCode} /></span> : null}
          </div>
          {/* A laptop has the room for a few plain facts and the way to the piece's own page. */}
          <dl className="lk-facts">
            {p.fabric ? <div><dt>Fabric</dt><dd>{p.fabric}</dd></div> : null}
            {colours.length > 1 ? <div><dt>Colours</dt><dd>{colours.map(c => c.name).join(', ')}</dd></div> : null}
            {sizes.length > 1 ? <div><dt>Sizes</dt><dd>{sizes.join(', ')}</dd></div> : null}
            <div><dt>Photos and details</dt><dd><Link to={pieceUrl(slug, p, colour)}>Open the piece</Link></dd></div>
          </dl>
          <button type="button" className="lk-next" onClick={() => onGo(index + 1)}>
            {next ? (
              <>
                <span className="lk-nextshot">{nextD.photo ? <img src={sized(nextD.photo.url, 240)} alt="" loading="lazy" decoding="async" /> : null}</span>
                <span className="lk-nexttext">
                  <small>Next in the reel</small>
                  <b>{next.p.title}{nextD.from != null ? `, ${nextD.spread ? 'from ' : ''}${money(shownPrice(nextD.from, next.p.soldBy), nextD.currency)}${perWord(next.p.soldBy)}` : ''}</b>
                </span>
              </>
            ) : (
              <span className="lk-nexttext">
                <small>{total > 1 ? 'End of the reel' : 'After this'}</small>
                <b>{total > 1 ? 'See the whole look' : `More from ${shop.name}`}</b>
              </span>
            )}
            <Down />
          </button>
        </div>
      </div>
    </section>
  );
}

/** The page in its plain form: a reel that has gone, or one that could not be fetched. Never a dead end. */
const Plain = ({ slug, shop, footer, announcement, children }) => (
  <div className="lk-plain">
    <Band slug={slug} shop={shop} solid flow />
    {announcement}
    <div className="wrap lk-plainin">{children}</div>
    {footer}
  </div>
);

export default function LookPage({ slug, code, shop, footer, announcement }) {
  const nav = useNavigate();
  const [state, setState] = useState({ loading: true, error: null, look: null });
  const [nonce, setNonce] = useState(0);
  // The colour the shopper chose for a piece (until they do, the one worn in the reel).
  const [picked, setPicked] = useState({});
  const [choosing, setChoosing] = useState(null);
  const [said, setSaid] = useState('');
  const [others, setOthers] = useState([]);
  // Which frame is on screen: 0..pieces-1, and pieces.length for the last one (the whole look).
  const [current, setCurrent] = useState(0);
  const bag = useBag(slug);
  const reel = useRef(null);
  const frames = useRef([]);
  const tick = useRef(0);
  const addedAt = useRef(0);
  // The "swipe up" words on the first frame go once the shopper has moved, and do not come back.
  const [moved, setMoved] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setState({ loading: true, error: null, look: null });
    getLook(slug, code, { signal: ac.signal })
      .then(look => {
        // "?piece=<code>" opens the reel AT that piece (a tile on the reels page; Back from a piece's own page).
        const want = new URLSearchParams(window.location.search).get('piece');
        const list = look.available ? look.pieces ?? [] : [];
        const at = want ? list.findIndex(p => p.productCode === want) : -1;
        setCurrent(at >= 0 ? at : want === 'all' ? list.length : 0);
        setState({ loading: false, error: null, look });
      })
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, look: null }); });
    return () => ac.abort();
  }, [slug, code, nonce]);

  const pieces = state.look?.available ? state.look.pieces ?? [] : [];
  const open = pieces.length > 0;

  useEffect(() => {
    if (state.look?.available && state.look.title) document.title = `${state.look.title} · ${shop.name}`;
  }, [state.look, shop.name]);

  // The shop's other reels, for the last frame. Not waited for, and nothing is said if they cannot be read.
  useEffect(() => {
    if (!open) return undefined;
    const ac = new AbortController();
    getReels(slug, { signal: ac.signal })
      .then(d => setOthers((d.reels ?? []).filter(r => r.code !== code).slice(0, 3)))
      .catch(() => {});
    return () => ac.abort();
  }, [slug, code, open]);

  // Start at the frame the address asks for, before anything is painted.
  useLayoutEffect(() => {
    const el = reel.current, f = frames.current[current];
    if (open && el && f && current > 0) el.scrollTop = f.offsetTop;
    if (open) el?.focus({ preventScroll: true });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The address follows the frame, so Back from a piece's own page (or the bag) returns to the same frame.
  useEffect(() => {
    if (!open) return;
    const q = new URLSearchParams(window.location.search);
    const want = current >= pieces.length ? 'all' : current > 0 ? pieces[current].productCode : null;
    if ((q.get('piece') ?? null) === want) return;
    if (want) q.set('piece', want); else q.delete('piece');
    const text = q.toString();
    // Safari allows only so many of these a minute; the frame still moves if one is refused.
    try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${text ? `?${text}` : ''}${window.location.hash}`); } catch { /* the address stays as it was */ }
  }, [current, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = (i) => {
    const el = reel.current, f = frames.current[Math.max(0, Math.min(i, pieces.length))];
    if (el && f) el.scrollTo({ top: f.offsetTop, behavior: calm() ? 'auto' : 'smooth' });
  };

  const onScroll = () => {
    if (tick.current) return;
    tick.current = window.requestAnimationFrame(() => {
      tick.current = 0;
      const el = reel.current;
      if (!el) return;
      if (el.scrollTop > 24) setMoved(true);
      const mid = el.scrollTop + el.clientHeight / 2;
      let at = 0;
      frames.current.forEach((f, n) => { if (f && f.offsetTop <= mid) at = n; });
      setCurrent(at);
    });
  };
  useEffect(() => () => { if (tick.current) window.cancelAnimationFrame(tick.current); }, []);

  // The keys a keyboard moves a page with move one frame. Inside the last frame (a long list) they scroll as usual.
  useEffect(() => {
    if (!open) return undefined;
    const key = (e) => {
      if (choosing || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target?.closest?.('input, textarea, select, [role="radiogroup"], [contenteditable="true"]')) return;
      if (current >= pieces.length) return;
      const move = e.key === 'ArrowDown' || e.key === 'PageDown' ? 1 : e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 0;
      if (!move || (move < 0 && current === 0)) return;
      e.preventDefault();
      goTo(current + move);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, current, choosing, pieces.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.loading) {
    return (
      <div className="lk-reel" aria-busy="true">
        <section className="lk-frame">
          <Band slug={slug} shop={shop} solid />
          <div className="lk-stage" aria-hidden="true">
            <div className="lk-shot bone" />
            <div className="lk-panel">
              <div className="bone" style={{ height: 12, width: 110, borderRadius: 4 }} />
              <div className="bone" style={{ height: 26, width: '78%', borderRadius: 6, marginTop: 12 }} />
              <div className="bone" style={{ height: 22, width: 96, borderRadius: 5, marginTop: 16 }} />
              <div className="bone" style={{ height: 52, borderRadius: 14, marginTop: 22 }} />
            </div>
          </div>
        </section>
      </div>
    );
  }
  if (state.error) {
    return (
      <Plain slug={slug} shop={shop} footer={footer} announcement={announcement}>
        {state.error.kind === 'GONE'
          ? <Say title="This link is not available" action={<Link className="go quiet" to={`/${slug}`}>See the whole shop</Link>}>It may have been typed wrongly. Everything else in the shop is still here.</Say>
          : <Problem error={state.error} onRetry={() => setNonce(n => n + 1)} shopName={shop.name} />}
      </Plain>
    );
  }

  const look = state.look;
  if (!open) {
    return (
      <Plain slug={slug} shop={shop} footer={footer} announcement={announcement}>
        <Say title="This look is no longer available">Here is what is new in the shop.</Say>
        {look.newArrivals?.length ? <div className="grid">{look.newArrivals.map(p => <Tile key={p.productCode} slug={slug} p={p} />)}</div> : null}
        <div className="lk-plainmore"><Link className="go quiet" to={`/${slug}`}>See the whole shop</Link></div>
      </Plain>
    );
  }

  const buying = shop?.buying?.open === true;
  const hearts = wishlistOn(shop);
  const total = pieces.length;
  const colourFor = (p) => picked[p.productCode] ?? startColour(p);
  const inBagCodes = new Set(bag.map(l => l.variantCode));
  const codesHere = new Map(pieces.flatMap(p => (p.variants ?? []).map(v => [v.variantCode, { p, v }])));
  const inBag = bag.filter(l => codesHere.has(l.variantCode));
  // Price per base unit x quantity in base units: right for pieces and for cloth (cm x price per cm) alike.
  const inBagTotal = inBag.reduce((a, l) => a + Number(codesHere.get(l.variantCode).v.price) * Number(l.quantity), 0);
  const seen = pieces.map(p => ({ p, colour: colourFor(p), d: describe(p, colourFor(p)) }));
  // "Ready to add": the pieces with one choice in the colour showing. One needing a size, cloth, or sold out is not
  // counted, so the button never says a number it does not add.
  const addable = buying ? seen.filter(s => s.d.only && !inBagCodes.has(s.d.only.variantCode)) : [];
  const currency = pieces[0]?.variants?.[0]?.currency ?? 'INR';

  const digits = String(shop.whatsapp || '').replace(/\D/g, '');
  const ask = (p, colour) => (digits.length < 10 ? null : `https://wa.me/${digits}?text=${encodeURIComponent(
    `Hi ${shop.name}, I saw your reel "${look.title}". I would like ${p.title}${colour ? `, ${String(colour).toLowerCase()}` : ''} (${p.productCode}).`)}`);

  const put = (p, v) => addToBag(slug, v.variantCode, 1, { title: p.title, size: v.size, colour: v.colour, colourHex: v.colourHex });
  const added = (p) => { addedAt.current = Date.now(); setChoosing(null); setSaid(`${p.title} is in your bag.`); };
  /* "Add to bag" turns into "Go to bag" in the same place. The second tap of a double tap would land on it and carry
     the shopper off to the bag they never asked for, so for a moment after adding it does nothing. */
  const tooSoon = (e) => { if (Date.now() - addedAt.current < 700) e.preventDefault(); };
  const addOne = (p) => {
    const d = describe(p, colourFor(p));
    // A piece already in the bag stays as it is: a second press must not turn one saree into two.
    if (d.only) { if (!getBag(slug).some(l => l.variantCode === d.only.variantCode)) put(p, d.only); added(p); }
    else setChoosing(p);
  };
  const addAll = () => {
    const have = new Set(getBag(slug).map(l => l.variantCode));
    let n = 0;
    for (const s of addable) {
      if (have.has(s.d.only.variantCode)) continue;
      put(s.p, s.d.only);
      n++;
    }
    addedAt.current = Date.now();
    setSaid(n ? `${n} ${n === 1 ? 'piece' : 'pieces'} added to your bag.` : 'Already in your bag.');
  };
  const pickColour = (p, colour) => setPicked(was => ({ ...was, [p.productCode]: colour }));
  const reelName = `${look.title}, ${total} ${total === 1 ? 'piece' : 'pieces'}`;

  /** What a row of the whole look offers at its right-hand end. */
  const rowAction = ({ p, colour, d }) => {
    if (d.soldOut) return <span className="lk-rowsaid">Sold out</span>;
    if (!buying) return null;
    if (d.shown.some(v => inBagCodes.has(v.variantCode))) return <span className="lk-in"><Tick />In your bag</span>;
    // One short word in a row (the smallest phones leave a name 60px beside "Choose length"); the frame says it in full.
    if (d.measured) return <Link className="lk-small" to={pieceUrl(slug, p, colour)} aria-label={`Choose length for ${p.title}`}>Choose</Link>;
    if (d.buyable.length === 0) return <span className="lk-rowsaid">Sold out</span>;
    return <button type="button" className="lk-small" onClick={() => addOne(p)} aria-label={`${d.only ? 'Add' : 'Choose size for'} ${p.title}`}>{d.only ? 'Add' : 'Choose'}</button>;
  };

  return (
    <>
      <div className="lk-reel" ref={reel} onScroll={onScroll} tabIndex={-1}>
        {seen.map(({ p, colour }, i) => (
          <Frame key={p.productCode} slug={slug} shop={shop} look={look} p={p} index={i} total={total}
            colour={colour} onColour={pickColour} next={seen[i + 1] ?? null} onGo={goTo}
            buying={buying} hearts={hearts} inBagCodes={inBagCodes} ask={ask} onAdd={addOne} tooSoon={tooSoon}
            eager={i === current || (current >= total && i === 0)}
            all={seen} reelName={reelName} cue={i === 0 && current === 0 && !moved}
            setRef={el => { frames.current[i] = el; }} />
        ))}

        <section className="lk-end" ref={el => { frames.current[total] = el; }} aria-label={total > 1 ? 'The whole look' : `More from ${shop.name}`}>
          <Band slug={slug} shop={shop} total={total} lit={total} onGo={goTo} reelUrl={look.reel?.url} reelName={reelName} solid flow />
          {/* The shop's one line ("Diwali sale till 5 Nov"): on the frame where the buying is summed up, not over every photograph. */}
          {announcement}
          <div className="lk-endin">
            {total > 1 ? (
              <>
                <h2 className="lk-endtitle">The whole look</h2>
                <p className="lk-endsub">{total} pieces from {look.title}</p>
                <ul className="lk-rows">
                  {seen.map((s, i) => (
                    <li key={s.p.productCode} className={`lk-row${s.d.soldOut ? ' gone' : ''}`}>
                      <button type="button" className="lk-rowshot" onClick={() => goTo(i)} aria-label={`Go to ${s.p.title}`}>
                        {s.d.photo ? <img src={sized(s.d.photo.url, 240)} alt="" loading="lazy" decoding="async" /> : <span>Photo coming soon</span>}
                      </button>
                      <div className="lk-rowtext">
                        <b>{s.p.title}</b>
                        {s.colour ? <span>{s.colour}{s.p.reelColour && sameColour(s.p.reelColour, s.colour) ? ', as in the reel' : ''}</span> : null}
                        {s.d.from != null ? <em>{s.d.spread ? 'From ' : ''}{money(shownPrice(s.d.from, s.p.soldBy), s.d.currency)}{perWord(s.p.soldBy)}</em> : null}
                      </div>
                      {rowAction(s)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {buying && (inBag.length > 0 || addable.length > 1) ? (
              <div className="lk-sum">
                <div className="lk-total">
                  {inBag.length > 0
                    ? <><span>{inBag.length} {inBag.length === 1 ? 'piece' : 'pieces'} in your bag</span><b>{money(inBagTotal, currency)}</b></>
                    : <><span>{addable.length} ready to add</span><b>{money(addable.reduce((a, s) => a + Number(s.d.only.price), 0), currency)}</b></>}
                </div>
                {inBag.length > 0
                  ? <button type="button" className="go lk-endgo" onClick={() => { if (Date.now() - addedAt.current >= 700) nav(`/${slug}/bag`); }}>Go to bag</button>
                  : <button type="button" className="go lk-endgo" onClick={addAll}>Add {addable.length} to bag</button>}
              </div>
            ) : null}

            {others.length ? (
              <div className="lk-others">
                <h3>More reels from {shop.name}</h3>
                <div className="lk-othergrid">
                  {others.map(r => (
                    <Link key={r.code} className="lk-other" to={`/${slug}/look/${encodeURIComponent(r.code)}`}>
                      <Shot src={r.cover} alt="" ratio="4 / 5" className="lk-othershot" sizes="(min-width: 900px) 170px, 30vw">
                        {r.cover ? null : <span className="lk-nophoto">Photo coming soon</span>}
                      </Shot>
                      <b>{r.title}</b>
                      {r.count ? <span>{r.count} {r.count === 1 ? 'piece' : 'pieces'}</span> : null}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="lk-endlinks">
              {others.length ? <Link className="go quiet" to={`/${slug}/reels`}>All our reels</Link> : null}
              <Link className="go quiet" to={`/${slug}`}>See the whole shop</Link>
            </div>
          </div>
          {footer}
        </section>
      </div>

      <p className="lk-said" role="status" aria-live="polite">{said}</p>
      {choosing && <ChooseSheet slug={slug} p={choosing} start={colourFor(choosing)} onClose={() => setChoosing(null)} onAdded={added} />}
    </>
  );
}
