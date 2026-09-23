import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getProducts, money } from '../api';

/**
 * More of the shop, under the piece being looked at.
 *
 * A product page that ends at the description is a dead end: a shopper who does not want THIS
 * saree has nowhere to go but Back. This is the shop's own catalogue -- the same kind of thing,
 * from the same shop -- so the page carries on being a shop rather than stopping.
 *
 * Asked for the same category first, and if the shop sells only one kind of thing that is simply
 * the rest of the shop, which is the right answer for a saree shop with sixty sarees.
 */
export default function AlsoIn({ slug, product, shop }) {
  const [rows, setRows] = useState(null);

  const dressType = product?.dressType ?? '';
  const category = product?.category ?? '';

  /* What was actually asked for in the end, so the heading matches what is underneath it. */
  const [narrow, setNarrow] = useState(Boolean(dressType));

  useEffect(() => {
    const ac = new AbortController();
    setRows(null);
    setNarrow(Boolean(dressType));

    const mine = (page) => (page.products ?? []).filter(p => p.productCode !== product.productCode);

    /*
     * The same kind of thing first, and the rest of the shop when there is not enough of it.
     *
     * A shop with one salwar suit would otherwise lose this section entirely and end its product
     * page at the description -- which is exactly the dead end it exists to prevent. Three is the
     * point below which a row looks like a mistake rather than a selection.
     */
    getProducts(slug, { dressType, category, limit: 12, sort: 'NEW' }, { signal: ac.signal })
      .then(async page => {
        const close = mine(page);
        if (close.length >= 3 || !dressType) { setRows(close.slice(0, 10)); return; }
        const wider = await getProducts(slug, { limit: 12, sort: 'NEW' }, { signal: ac.signal });
        setNarrow(false);
        setRows(mine(wider).slice(0, 10));
      })
      .catch(() => setRows([]));
    return () => ac.abort();
  }, [slug, dressType, category, product?.productCode]);

  if (rows !== null && rows.length === 0) return null;

  const what = narrow && dressType ? `More ${dressType.toLowerCase()}s` : `More from ${shop?.name ?? 'this shop'}`;

  return (
    <section className="alsoin">
      <div className="head">
        <h2>{what}</h2>
        <Link to={narrow && dressType ? `/${slug}?dressType=${encodeURIComponent(dressType)}` : `/${slug}`}>See all</Link>
      </div>

      <div className="reel">
        {rows === null
          ? Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="small">
              <div className="shot bone" style={{ aspectRatio: '3 / 4' }} />
            </div>
          ))
          : rows.map(p => {
            const photo = p.images?.find(i => i.isPrimary) ?? p.images?.[0] ?? null;
            const prices = (p.variants ?? []).map(v => Number(v.price)).filter(Number.isFinite);
            const from = prices.length ? Math.min(...prices) : null;
            const sellable = (p.variants ?? []).some(v => v.sellable);
            return (
              <Link key={p.productCode} className={`small${sellable ? '' : ' gone'}`}
                to={`/${slug}/p/${encodeURIComponent(p.productCode)}`}>
                <div className="shot">
                  {photo ? <img src={photo.url} alt={p.title} loading="lazy" decoding="async" /> : null}
                  {!sellable ? <span className="tag out">Sold out</span> : null}
                </div>
                <h3>{p.title}</h3>
                {from != null ? <p className="now">{money(from, p.variants?.[0]?.currency ?? 'INR')}</p> : null}
              </Link>
            );
          })}
      </div>
    </section>
  );
}
