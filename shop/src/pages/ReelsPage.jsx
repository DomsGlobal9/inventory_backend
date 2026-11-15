import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getReels } from '../api';
import { Problem, Say, GridSkeleton } from '../components/States';

/**
 * shop.scaleezy.com/<shop>/reels -- the link in the shop's Instagram bio (PLAN-reel-links.md).
 *
 * Instagram does not let a caption link be tapped, so a caption says "link in bio, reel 12" and this page lists every
 * reel link the shop has switched on, newest first. Each tile opens that reel's pieces.
 */
export default function ReelsPage({ slug, shop }) {
  const [state, setState] = useState({ loading: true, error: null, reels: [] });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setState({ loading: true, error: null, reels: [] });
    getReels(slug, { signal: ac.signal })
      .then(d => setState({ loading: false, error: null, reels: d.reels ?? [] }))
      .catch(e => { if (e?.name !== 'AbortError') setState({ loading: false, error: e, reels: [] }); });
    return () => ac.abort();
  }, [slug, nonce]);

  useEffect(() => { document.title = `Shop our reels · ${shop.name}`; }, [shop.name]);

  if (state.loading) return <GridSkeleton count={4} />;
  if (state.error) return <Problem error={state.error} onRetry={() => setNonce(n => n + 1)} shopName={shop.name} />;
  if (!state.reels.length) {
    return <Say title="No reels to shop yet" action={<Link className="go quiet" to={`/${slug}`}>See the whole shop</Link>}>When we post a reel, its pieces appear here.</Say>;
  }

  return (
    <section className="look">
      <h1 className="look-title">Shop our reels</h1>
      <p className="look-sub">Tap a reel to see its pieces</p>
      <div className="reels">
        {state.reels.map(r => (
          <Link key={r.code} className="reel" to={`/${slug}/look/${r.code}`}>
            <span className="reel-shot">
              {r.cover ? <img src={r.cover} alt="" loading="lazy" /> : null}
            </span>
            <span className="reel-name">{r.title}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
