import React from 'react';
import { Link } from 'react-router-dom';
import { money, offerWords } from '../api';
import Shot from './Shot';

/**
 * One piece in a grid: the shop's home page and the endless "You may also like" under a product
 * share it, so a piece looks the same wherever a shopper meets it.
 */

/** What is worth saying about the saving: shoppers compare the percentage, not the difference. */
export function saving(now, was) {
  const a = Number(now), b = Number(was);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round(((b - a) / b) * 100);
}

export default function Tile({ slug, p }) {
  const photo = p.images?.find(i => i.isPrimary) ?? p.images?.[0] ?? null;
  const sellable = (p.variants ?? []).some(v => v.sellable);

  const prices = (p.variants ?? []).map(v => Number(v.price)).filter(Number.isFinite);
  const from = prices.length ? Math.min(...prices) : null;
  const spread = prices.length > 1 && Math.min(...prices) !== Math.max(...prices);
  const wasList = (p.variants ?? []).map(v => Number(v.compareAtPrice)).filter(Number.isFinite);
  const was = wasList.length ? Math.max(...wasList) : null;
  const off = saving(from, was);
  const currency = p.variants?.[0]?.currency ?? 'INR';

  /* The shop's own shades, so the dots under a piece are its colours and not a browser's idea. */
  const colours = [];
  for (const v of p.variants ?? []) {
    if (!v.colour || colours.some(c => c.name === v.colour)) continue;
    colours.push({ name: v.colour, hex: v.colourHex ?? null });
  }

  return (
    <Link className={`tile${sellable ? '' : ' gone'}`} to={`/${slug}/p/${encodeURIComponent(p.productCode)}`}>
      <Shot src={photo?.url} alt={p.title}>
        {/*
          Stacked rather than laid on top of each other. A piece can be marked down AND carry an
          offer AND be sold out, and each .tag pinned itself to the same corner -- which was fine
          while only one of them could ever be true at a time.
        */}
        <span className="tags">
          {off ? <span className="tag">{off}% off</span> : null}
          {/*
            The shop's own offer, a different thing from the tag above it: that one is the list
            price against the selling price, typed on the piece. This one comes off in the BAG,
            and used to be invisible until the shopper got there -- so a sale ran and only the
            people who had already decided to buy ever found out.
          */}
          {p.offer ? <span className="tag deal">{offerWords(p.offer, currency)}</span> : null}
          {!sellable ? <span className="tag out">Sold out</span> : null}
        </span>
      </Shot>
      <h2>{p.title}</h2>
      <p className="sub">{[p.fabric, p.dressType].filter(Boolean).join(' · ') || ' '}</p>
      {from != null && (
        <div className="row">
          <span className="now">{spread ? 'From ' : ''}{money(from, currency)}</span>
          {was && off ? <><span className="was">{money(was, currency)}</span><span className="off">{off}% off</span></> : null}
        </div>
      )}
      {colours.length > 1 && (
        <div className="dots" aria-label={`${colours.length} colours`}>
          {colours.slice(0, 5).map(c => (
            <i key={c.name} title={c.name}
              style={c.hex ? { background: c.hex } : { background: 'transparent' }}
              data-noshade={c.hex ? undefined : true} />
          ))}
          {colours.length > 5 ? <span className="sub" style={{ margin: 0 }}>+{colours.length - 5}</span> : null}
        </div>
      )}
    </Link>
  );
}

