import React from 'react';

/**
 * Everything the shop says when it cannot show what the shopper came for.
 *
 * Gathered here rather than written at each call site, because these are the screens a shopper is
 * most likely to see on a bad connection and the ones most likely to be written carelessly. Each
 * one says what happened, and where possible offers the way on -- a blank screen or a spinner that
 * never ends teaches a customer that the shop is broken.
 */

export function Say({ title, children, action, art }) {
  return (
    <div className="say">
      {/* A small drawing above the words, where one helps. Optional on purpose: most of these
          screens are better plain, and an animation on every refusal becomes noise. */}
      {art ? <div className="art">{art}</div> : null}
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export const Retry = ({ onRetry }) => (
  <button className="go quiet" style={{ flex: '0 0 auto' }} onClick={onRetry}>Try again</button>
);

/**
 * What a shopper sees while the shop loads: the shape of what is coming, not a spinner.
 * A spinner says "wait"; this says "photos are on their way", and the page does not jump when
 * they arrive because the space is already reserved.
 */
export const GridSkeleton = ({ count = 8 }) => (
  <div className="grid" aria-hidden="true">
    {Array.from({ length: count }, (_, i) => (
      <div key={i} className="tile">
        {/* The same 3:4 shape a photograph will take, so nothing moves when it arrives. */}
        <div className="shot bone" style={{ aspectRatio: '3 / 4' }} />
        <div style={{ paddingTop: 9 }}>
          <div className="bone" style={{ height: 13, width: '78%', marginBottom: 7, borderRadius: 4 }} />
          <div className="bone" style={{ height: 11, width: '48%', borderRadius: 4 }} />
        </div>
      </div>
    ))}
  </div>
);

/**
 * The one screen that must never be a dead end.
 *
 * `kind` comes from the API layer, so a page never has to know about status codes. An unknown
 * address and a closed shop are deliberately different: somebody who saved a link deserves to be
 * told the shop is shut, not left thinking they mistyped it.
 */
export function Problem({ error, onRetry, shopName }) {
  const kind = error?.kind;

  /*
   * A rule the shop applied, said as the shop said it.
   *
   * "Anarkali Suit Set (L) is not available in the quantity you asked for" is guidance -- the
   * shopper can change the number and carry on. Shown under a heading reading "Something went
   * wrong" it became a fault, and a customer who thinks the shop is broken leaves.
   */
  if (kind === 'RULE') {
    return <Say title={error.message} action={onRetry ? <Retry onRetry={onRetry} /> : null} />;
  }

  if (kind === 'UNKNOWN_SHOP') {
    return (
      <Say title="There is no shop at this address">
        Check the link you were sent. It may have been typed by hand, or the shop may have moved.
      </Say>
    );
  }
  if (kind === 'CLOSED') {
    return (
      <Say title={`${shopName || 'This shop'} is not open just now`}>
        The shop has closed its online shop for the moment. Your link still works — try again later.
      </Say>
    );
  }
  if (kind === 'GONE') {
    return (
      <Say title="That is no longer in this shop" action={<Retry onRetry={onRetry} />}>
        It may have sold, or the shop may have taken it off. Have a look at what else there is.
      </Say>
    );
  }
  if (kind === 'OFFLINE') {
    return (
      <Say title="We could not reach the shop" action={<Retry onRetry={onRetry} />}>
        Check your internet connection and try again.
      </Say>
    );
  }
  return (
    <Say title="Something went wrong" action={<Retry onRetry={onRetry} />}>
      {error?.message || 'Please try again in a moment.'}
    </Say>
  );
}
