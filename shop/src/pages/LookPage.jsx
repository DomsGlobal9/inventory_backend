import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLook } from '../api';
import { addToBag } from '../bag';
import Tile from '../components/Tile';
import { Problem, Say, GridSkeleton } from '../components/States';

/**
 * shop.scaleezy.com/<shop>/look/<code> -- the pieces from one of the shop's reels (PLAN-reel-links.md).
 *
 * Opened from Instagram's own small browser, so: no sign-in to look, one request, today's prices and stock. A piece
 * opens on the colour worn in the reel. Sold-out pieces come last (the server orders them) and offer WhatsApp, because
 * the shopper just saw them in the reel. A link the shop switched off is never a dead end: it shows new arrivals.
 */

/** The one variant "Add the look" can put in the bag without asking: the reel's colour, buyable, one size. */
function onlyChoice(p) {
  if (p.soldBy && p.soldBy !== 'PIECE' && p.soldBy !== 'PACKET' && p.soldBy !== 'PAIR' && p.soldBy !== 'SET') return null;
  const sellable = (p.variants ?? []).filter(v => v.sellable);
  const ofColour = p.reelColour ? sellable.filter(v => (v.colour ?? '').toLowerCase() === p.reelColour.toLowerCase()) : sellable;
  return ofColour.length === 1 ? ofColour[0] : null;
}

const pieceUrl = (slug, p) =>
  `/${slug}/p/${encodeURIComponent(p.productCode)}${p.reelColour ? `?colour=${encodeURIComponent(p.reelColour)}` : ''}`;

export default function LookPage({ slug, code, shop }) {
  const [state, setState] = useState({ loading: true, error: null, look: null });
  const [nonce, setNonce] = useState(0);
  const [added, setAdded] = useState(null);

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
  const canBuy = (p) => (p.variants ?? []).some(v => v.sellable);
  const ready = look.pieces.filter(p => canBuy(p) && onlyChoice(p));
  const choose = look.pieces.filter(p => canBuy(p) && !onlyChoice(p));

  const addLook = () => {
    for (const p of ready) {
      const v = onlyChoice(p);
      addToBag(slug, v.variantCode, 1, { title: p.title, size: v.size, colour: v.colour, colourHex: v.colourHex });
    }
    setAdded({ count: ready.length, choose });
  };

  // The message is written for them: which reel, which piece, which colour.
  const digits = String(shop.whatsapp || '').replace(/\D/g, '');
  const ask = (p) => (digits.length < 10 ? null : `https://wa.me/${digits}?text=${encodeURIComponent(
    `Hi ${shop.name}, I saw your reel "${look.title}". I would like ${p.title}${p.reelColour ? `, ${p.reelColour.toLowerCase()}` : ''} (${p.productCode}).`)}`);

  return (
    <section className="look">
      <h1 className="look-title">{look.title}</h1>
      <p className="look-sub">{look.pieces.length} {look.pieces.length === 1 ? 'piece' : 'pieces'} from our reel{buying ? '' : '. Message us to order'}</p>

      <div className="grid">
        {look.pieces.map(p => (
          <div key={p.productCode} className="look-piece">
            <Tile slug={slug} p={p} to={pieceUrl(slug, p)} />
            {(!canBuy(p) || !buying) && ask(p) ? (
              <a className="look-wa" href={ask(p)} target="_blank" rel="noreferrer">{canBuy(p) ? 'Order on WhatsApp' : 'Ask on WhatsApp'}</a>
            ) : null}
          </div>
        ))}
      </div>

      <div className="look-actions">
        {buying && ready.length > 0 && !added && (
          <button type="button" className="go" onClick={addLook}>
            Add the look to bag ({ready.length} {ready.length === 1 ? 'piece' : 'pieces'})
          </button>
        )}
        {added && (
          <div className="look-added" role="status">
            <p><b>Added {added.count} {added.count === 1 ? 'piece' : 'pieces'} to your bag.</b></p>
            {added.choose.length > 0 && (
              <p>Choose a size or length for: {added.choose.map((p, i) => (
                <React.Fragment key={p.productCode}>{i ? ', ' : ''}<Link to={pieceUrl(slug, p)}>{p.title}</Link></React.Fragment>
              ))}</p>
            )}
            <Link className="go" to={`/${slug}/bag`}>Go to bag</Link>
          </div>
        )}
        <Link className="go quiet" to={`/${slug}`}>See the whole shop</Link>
      </div>
    </section>
  );
}
