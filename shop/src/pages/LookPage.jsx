import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getLook, money } from '../api';
import { addToBag, getBag, useBag } from '../bag';
import { wishlistOn } from '../account';
import Tile, { saving } from '../components/Tile';
import Shot from '../components/Shot';
import Heart from '../components/Heart';
import Picker from '../components/Picker';
import { Problem, Say, GridSkeleton } from '../components/States';

/**
 * shop.scaleezy.com/<shop>/look/<code> -- the pieces from one of the shop's reels (PLAN-reel-links.md).
 *
 * 16 Nov 2026, the owner's choice "A. Product grid" (PLAN-reel-look-mockups-2.html): a shopping-app listing -- two
 * cards a row on a phone, four on a laptop, each with its photo, wishlist heart, price, the shop's own MRP and saving
 * when it has one, "Only N left" when the shop shows that, and ADD TO BAG. A piece with one buyable choice in the
 * reel's colour goes straight in; one with more (colours, sizes) opens a small sheet; cloth by the metre opens its
 * page to choose the length. A bar keeps the bag from this reel in view.
 *
 * Opened from Instagram's own small browser, so: no sign-in to look, one request, today's prices and stock. Sold-out
 * pieces come last (the server orders them) and offer WhatsApp. A link the shop switched off is never a dead end: it
 * shows new arrivals. Classes are "lk-" only: the shop's stylesheet is one global sheet (the 16 Nov .reel clash).
 */

const MEASURED = new Set(['METRE', 'KILOGRAM']);
const sameColour = (a, b) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** The one variant a tap can put in the bag without asking: the reel's colour, buyable, one size. */
function onlyChoice(p) {
  if (MEASURED.has(p.soldBy)) return null;
  const sellable = (p.variants ?? []).filter(v => v.sellable);
  const ofColour = p.reelColour ? sellable.filter(v => sameColour(v.colour, p.reelColour)) : sellable;
  if (ofColour.length === 1) return ofColour[0];
  return !p.reelColour && sellable.length === 1 ? sellable[0] : null;
}

const pieceUrl = (slug, p) =>
  `/${slug}/p/${encodeURIComponent(p.productCode)}${p.reelColour ? `?colour=${encodeURIComponent(p.reelColour)}` : ''}`;

/** Everything one card says, worked out once. */
function describe(p) {
  const variants = p.variants ?? [];
  const sellable = variants.filter(v => v.sellable);
  const shown = p.reelColour ? variants.filter(v => sameColour(v.colour, p.reelColour)) : variants;
  const priced = (shown.length ? shown : variants).map(v => Number(v.price)).filter(Number.isFinite);
  const from = priced.length ? Math.min(...priced) : null;
  const spread = priced.length > 1 && Math.min(...priced) !== Math.max(...priced);
  const was = Math.max(...(shown.length ? shown : variants).map(v => Number(v.compareAtPrice)).filter(Number.isFinite), -Infinity);
  const off = Number.isFinite(was) ? saving(from, was) : null;
  const colours = [];
  for (const v of variants) if (v.colour && !colours.some(c => sameColour(c, v.colour))) colours.push(v.colour);
  const reelGone = !!p.reelColour && sellable.length > 0 && !sellable.some(v => sameColour(v.colour, p.reelColour));
  const few = (p.reelColour ? sellable.filter(v => sameColour(v.colour, p.reelColour)) : sellable).map(v => v.fewLeft).filter(n => n != null);
  return {
    sellable, from, spread, was: off ? was : null, off, colours, reelGone,
    fewLeft: few.length ? Math.min(...few) : null,
    currency: variants[0]?.currency ?? 'INR',
    photo: p.images?.find(i => i.isPrimary) ?? p.images?.[0] ?? null,
    measured: MEASURED.has(p.soldBy),
    // Shown per metre / kg, kept per cm / g.
    per: p.soldBy === 'METRE' ? 100 : p.soldBy === 'KILOGRAM' ? 1000 : 1,
    unitWord: p.soldBy === 'METRE' ? ' / m' : p.soldBy === 'KILOGRAM' ? ' / kg' : ''
  };
}

/** Choose a colour and size for one piece, from the bottom of the screen, as the big shopping apps do. */
function ChooseSheet({ slug, p, onClose, onAdded }) {
  const variants = (p.variants ?? []);
  const colours = [...new Set(variants.map(v => v.colour).filter(Boolean))];
  const startColour = colours.find(c => sameColour(c, p.reelColour) && variants.some(v => sameColour(v.colour, c) && v.sellable))
    ?? colours.find(c => variants.some(v => sameColour(v.colour, c) && v.sellable)) ?? colours[0] ?? null;
  const [colour, setColour] = useState(startColour);
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
  const d = describe(p);

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
            <div className="lk-price">{money(Number(chosen?.price ?? d.from) * d.per, d.currency)}{d.unitWord}</div>
          </div>
          <button type="button" className="lk-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        {colours.length > 1 && (
          <>
            <div className="lk-label">Colour: {colour}</div>
            <div className="lk-chips" role="radiogroup" aria-label="Colour">
              {colours.map(c => {
                const any = variants.some(v => sameColour(v.colour, c) && v.sellable);
                const hex = variants.find(v => sameColour(v.colour, c))?.colourHex;
                return (
                  <button key={c} type="button" role="radio" aria-checked={sameColour(c, colour)} className={`lk-chip${sameColour(c, colour) ? ' on' : ''}${any ? '' : ' x'}`}
                    onClick={() => pickColour(c)}>
                    {hex ? <i style={{ background: hex }} aria-hidden="true" /> : null}{c}{any ? '' : ', sold out'}
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

export default function LookPage({ slug, code, shop }) {
  const nav = useNavigate();
  const [state, setState] = useState({ loading: true, error: null, look: null });
  const [nonce, setNonce] = useState(0);
  const [sort, setSort] = useState('REEL');
  const [choosing, setChoosing] = useState(null);
  const [said, setSaid] = useState('');
  const bag = useBag(slug);

  useEffect(() => {
    const ac = new AbortController();
    setState({ loading: true, error: null, look: null });
    getLook(slug, code, { signal: ac.signal })
      .then(look => setState({ loading: false, error: null, look }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, look: null }); });
    return () => ac.abort();
  }, [slug, code, nonce]);

  useEffect(() => {
    if (state.look?.available && state.look.title) document.title = `${state.look.title} · ${shop.name}`;
  }, [state.look, shop.name]);

  const pieces = state.look?.pieces ?? [];
  const sorted = useMemo(() => {
    const order = pieces.map((p, i) => ({ p, i, d: describe(p) }));
    if (sort === 'REEL') return order;
    const dir = sort === 'LOW' ? 1 : -1;
    // Sold out stays last whatever the order: the shopper came to buy.
    return [...order].sort((a, b) => (a.d.sellable.length ? 0 : 1) - (b.d.sellable.length ? 0 : 1) || dir * ((a.d.from ?? 0) - (b.d.from ?? 0)));
  }, [pieces, sort]);

  if (state.loading) return <GridSkeleton count={4} />;
  if (state.error) {
    if (state.error.kind === 'GONE') {
      return <Say title="This link is not available" action={<Link className="go quiet" to={`/${slug}`}>See the whole shop</Link>}>It may have been typed wrongly. Everything else in the shop is still here.</Say>;
    }
    return <Problem error={state.error} onRetry={() => setNonce(n => n + 1)} shopName={shop.name} />;
  }

  const look = state.look;
  if (!look.available) {
    return (
      <section className="look">
        <Say title="This look is no longer available">Here is what is new in the shop.</Say>
        {look.newArrivals?.length ? <div className="grid">{look.newArrivals.map(p => <Tile key={p.productCode} slug={slug} p={p} />)}</div> : null}
        <div className="look-actions"><Link className="go quiet" to={`/${slug}`}>See the whole shop</Link></div>
      </section>
    );
  }

  const buying = shop?.buying?.open === true;
  const hearts = wishlistOn(shop);
  const codesHere = new Map(pieces.flatMap(p => (p.variants ?? []).map(v => [v.variantCode, { p, v }])));
  const inBag = bag.filter(l => codesHere.has(l.variantCode));
  const inBagTotal = inBag.reduce((a, l) => {
    // Price per base unit x quantity in base units: right for pieces and for cloth (cm x price per cm) alike.
    const { v } = codesHere.get(l.variantCode);
    return a + Number(v.price) * Number(l.quantity);
  }, 0);
  const inBagCodes = new Set(bag.map(l => l.variantCode));
  const addable = pieces.filter(p => { const v = onlyChoice(p); return v && !inBagCodes.has(v.variantCode); });
  const currency = pieces[0]?.variants?.[0]?.currency ?? 'INR';

  const digits = String(shop.whatsapp || '').replace(/\D/g, '');
  const ask = (p) => (digits.length < 10 ? null : `https://wa.me/${digits}?text=${encodeURIComponent(
    `Hi ${shop.name}, I saw your reel "${look.title}". I would like ${p.title}${p.reelColour ? `, ${p.reelColour.toLowerCase()}` : ''} (${p.productCode}).`)}`);

  const added = (p) => { setChoosing(null); setSaid(`${p.title} is in your bag.`); };
  const addOne = (p) => {
    const v = onlyChoice(p);
    if (v) { addToBag(slug, v.variantCode, 1, { title: p.title, size: v.size, colour: v.colour, colourHex: v.colourHex }); added(p); }
    else setChoosing(p);
  };
  // A piece already in the bag stays as it is: pressing this again must not turn one saree into two.
  const addAll = () => {
    const have = new Set(getBag(slug).map(l => l.variantCode));
    let n = 0;
    for (const p of addable) {
      const v = onlyChoice(p);
      if (have.has(v.variantCode)) continue;
      addToBag(slug, v.variantCode, 1, { title: p.title, size: v.size, colour: v.colour, colourHex: v.colourHex });
      n++;
    }
    setSaid(n ? `${n} ${n === 1 ? 'piece' : 'pieces'} added to your bag.` : 'Already in your bag.');
  };

  const action = (p, d) => {
    if (!d.sellable.length) {
      return ask(p) ? <a className="lk-add" href={ask(p)} target="_blank" rel="noreferrer">Ask on WhatsApp</a> : <button type="button" className="lk-add" disabled>Sold out</button>;
    }
    if (!buying) return ask(p) ? <a className="lk-add" href={ask(p)} target="_blank" rel="noreferrer">Order on WhatsApp</a> : null;
    if (d.measured) return <Link className="lk-add" to={pieceUrl(slug, p)}>Choose length</Link>;
    const v = onlyChoice(p);
    if (v && inBagCodes.has(v.variantCode)) return <Link className="lk-add on" to={`/${slug}/bag`} aria-label={`${p.title} is in your bag. Go to bag`}>Added to bag ✓</Link>;
    return <button type="button" className="lk-add" onClick={() => addOne(p)}>{d.reelGone ? 'Choose colour' : 'Add to bag'}</button>;
  };

  return (
    <section className="lk">
      <div className="lk-head">
        <div className="lk-thumb"><Shot src={describe(pieces[0] ?? {}).photo?.url} alt="" ratio="3 / 4" sizes="64px" /></div>
        <div className="lk-headtext">
          <span className="lk-kicker">Shop the reel</span>
          <h1 className="lk-title">{look.title}</h1>
          <span className="lk-sub">{pieces.length} {pieces.length === 1 ? 'piece' : 'pieces'} seen in this reel{buying ? '' : ' · message us to order'}</span>
        </div>
      </div>

      {pieces.length > 1 && (
        <div className="lk-sortbar">
          <span>{pieces.length} items</span>
          <Picker label="Sort" value={sort} onChange={setSort}
            options={[['REEL', 'As in the reel'], ['LOW', 'Price: low to high'], ['HIGH', 'Price: high to low']]} />
        </div>
      )}

      <div className="lk-wrap">
        <div className="lk-grid">
          {sorted.map(({ p, i, d }) => (
            <article key={p.productCode} className={`lk-card${d.sellable.length ? '' : ' gone'}`}>
              <div className="lk-photo">
                <Link to={pieceUrl(slug, p)} aria-label={p.title}>
                  <Shot src={d.photo?.url} alt={p.title} ratio="3 / 4" eager={i < 2} sizes="(min-width: 940px) 25vw, 50vw" />
                </Link>
                <span className="lk-num" aria-label={`Number ${i + 1} in the reel`}>{i + 1}</span>
                {hearts ? <span className="lk-heart"><Heart slug={slug} productCode={p.productCode} variantCode={onlyChoice(p)?.variantCode} /></span> : null}
                {!d.sellable.length ? <span className="lk-band">Sold out</span>
                  : d.reelGone ? <span className="lk-band">Sold out in {p.reelColour.toLowerCase()}</span> : null}
              </div>
              <div className="lk-info">
                <Link to={pieceUrl(slug, p)} className="lk-name">{p.title}</Link>
                <div className="lk-meta">{[p.fabric, p.dressType].filter(Boolean).join(' · ') || ' '}</div>
                {d.from != null && (
                  <div className="lk-price">
                    {/* Cloth: the price is kept per cm (Rs 4.50), shown per metre (Rs 450 / m) as a shopper reads it. */}
                    <b>{d.spread ? 'From ' : ''}{money(d.from * d.per, d.currency)}{d.unitWord}</b>
                    {d.was ? <><s>{money(d.was * d.per, d.currency)}</s><span className="lk-off">({d.off}% off)</span></> : null}
                  </div>
                )}
                {d.fewLeft != null ? <div className="lk-few">Only {d.fewLeft} left</div>
                  : d.colours.length > 1 ? <div className="lk-meta">{d.colours.length} colours{p.reelColour && !d.reelGone ? ` · ${p.reelColour} as in the reel` : ''}</div> : null}
                {/* At the foot of the card, so the buttons in a row line up whatever is written above them. */}
                <div className="lk-act">{action(p, d)}</div>
              </div>
            </article>
          ))}
        </div>

        {buying && (inBag.length > 0 || addable.length > 1) && (
          <aside className="lk-bar" aria-label="Your bag from this reel">
            <div className="lk-bartext">
              {inBag.length > 0
                ? <><span>{inBag.length} {inBag.length === 1 ? 'item' : 'items'} in bag</span><b>{money(inBagTotal, currency)}</b></>
                : <><span>{addable.length} ready to add</span><b>{money(addable.reduce((a, p) => a + Number(onlyChoice(p).price), 0), currency)}</b></>}
            </div>
            {/* "Ready to add": the pieces with one choice in the reel's colour. One needing a colour or size, or sold out,
                is not counted, so the button never says "all" while leaving some out. */}
            {inBag.length > 0
              ? <button type="button" className="go" onClick={() => nav(`/${slug}/bag`)}>Go to bag</button>
              : <button type="button" className="go" onClick={addAll}>Add {addable.length} to bag</button>}
          </aside>
        )}
      </div>

      <p className="lk-said" role="status" aria-live="polite">{said}</p>
      <div className="lk-more"><Link className="go quiet" to={`/${slug}`}>See the whole shop</Link></div>

      {choosing && <ChooseSheet slug={slug} p={choosing} onClose={() => setChoosing(null)} onAdded={added} />}
    </section>
  );
}
