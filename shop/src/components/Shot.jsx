import React, { useState } from 'react';
import { canResize, sized, widths, TILE } from '../photo';

/**
 * A product photograph that arrives rather than appears.
 *
 * Three things, all of which matter on a mid-range phone over mobile data:
 *
 *   THE SPACE IS RESERVED. The box has its shape before the photograph exists, so a grid of
 *   sarees does not shuffle under a thumb as each one lands. This is the difference between a
 *   page that feels solid and one that feels broken.
 *
 *   IT IS NOT FETCHED UNTIL IT IS NEARLY SEEN. `loading="lazy"` is the browser's own, and it is
 *   better at this than anything written here -- it knows the connection, the viewport and how
 *   fast the page is moving.
 *
 *   IT FADES IN. A photograph that pops in at full opacity draws the eye to whatever finished
 *   loading last, which on a slow connection is a page that twitches for several seconds. A
 *   150ms fade turns that into something that settles.
 *
 * A photograph that fails -- a deleted file, a blocked host -- leaves the quiet box rather than a
 * broken-image icon, because a shop with one broken icon looks like a shop that is broken.
 */
export default function Shot({ src, alt = '', ratio = '3 / 4', eager = false, className = '', sizes = '(min-width: 880px) 280px, 50vw', children }) {
  const [state, setState] = useState(src ? 'waiting' : 'none');
  // The small copy first (photo.js); if the storage cannot make one, the original instead.
  const [whole, setWhole] = useState(false);
  const small = !whole && canResize(src);

  return (
    <div className={`shot ${className}`.trim()} style={{ aspectRatio: ratio }} data-state={state}>
      {children}
      {src && state !== 'failed' ? (
        <img
          src={small ? sized(src, 540) : src}
          srcSet={small ? widths(src, TILE) : undefined}
          sizes={small ? sizes : undefined}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
          decoding="async"
          onLoad={() => setState('here')}
          onError={() => (small ? setWhole(true) : setState('failed'))}
        />
      ) : null}
    </div>
  );
}
