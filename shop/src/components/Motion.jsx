import React from 'react';

/**
 * The drawings, and the way they move.
 *
 * WHY THESE ARE DRAWN HERE RATHER THAN LOADED AS LOTTIE FILES. Two reasons, both about this shop's
 * customers rather than about taste. The page is served with `default-src 'self'`, so a Lottie
 * fetched from anywhere is blocked before it starts; and bundling the player costs about 70 KB
 * gzipped on a 98 KB page whose shoppers are on mid-range Androids over mobile data. These are a
 * few hundred bytes each, animate on the compositor, and start instantly.
 *
 * They are built the way a Lottie would be: several parts, each with its own timing, moving
 * against each other. A single element rocking back and forth reads as a loading spinner; a bag
 * that swings while its shadow shortens, its handle lags behind and two things drift down past it
 * reads as a drawing. The stagger is the whole difference, and it costs nothing.
 *
 * Every one of them holds still for anyone who has asked their device for less motion.
 */

/**
 * An empty bag: swinging, with its shadow shortening as it lifts and two pieces drifting past --
 * the shape of "nothing in here yet" rather than "loading".
 */
export const EmptyBag = () => (
  <svg className="art-bag" width="128" height="128" viewBox="0 0 128 128" fill="none" aria-hidden="true">
    {/* The floor it swings over. Shortening as the bag lifts is what sells the weight. */}
    <ellipse className="shadow" cx="64" cy="112" rx="26" ry="4" fill="currentColor" opacity=".16" />

    {/* Things that could be in it, drifting down past and fading. */}
    <g className="drift">
      <rect className="d1" x="38" y="16" width="13" height="16" rx="2.5" fill="currentColor" opacity=".22" />
      <circle className="d2" cx="86" cy="22" r="6" fill="currentColor" opacity=".18" />
      <rect className="d3" x="66" y="10" width="9" height="9" rx="2" fill="currentColor" opacity=".2" />
    </g>

    <g className="swing">
      {/* The handle lags a touch behind the body, the way a real one would. */}
      <path className="handle" d="M52 48a12 12 0 0 1 24 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path className="body" d="M40 48h48l-4.5 50h-39L40 48Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <path className="seam" d="M52 62h24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity=".3" />
    </g>
  </svg>
);

/**
 * No orders yet: a parcel that has not gone anywhere, over a route that draws itself and clears.
 * The parcel stays still and the road moves, which is the honest way round.
 */
export const EmptyOrders = () => (
  <svg className="art-parcel" width="132" height="120" viewBox="0 0 132 120" fill="none" aria-hidden="true">
    {/* The journey it has not made. Drawn, held, then rubbed out again. */}
    <path className="road" d="M12 96c22 0 22-22 44-22s22 22 44 22" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeDasharray="7 9" opacity=".32" />
    <circle className="pip" r="3.5" fill="currentColor" opacity=".55">
      <animateMotion dur="3.4s" repeatCount="indefinite" path="M12 96c22 0 22-22 44-22s22 22 44 22" />
    </circle>

    <g className="parcel">
      <path className="lid" d="M28 40l38-16 38 16-38 15-38-15Z" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round" />
      <path d="M28 40v30l38 16V55L28 40Z" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round" />
      <path d="M104 40v30L66 86V55l38-15Z" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round" opacity=".55" />
      {/* The tape, drawn once each time round. */}
      <path className="tape" d="M66 55v31" stroke="currentColor" strokeWidth="2.5" opacity=".4" />
    </g>
  </svg>
);

/**
 * An order placed: the ring settles, the tick draws, and six sparks go out and fade.
 * The one screen in the shop where a little celebration is the right thing.
 */
/**
 * The moment an order lands: the disc blooms, the ring closes round it, the tick is drawn, and
 * the sparks go out.
 *
 * THE DISC IS DRAWN IN HERE, not behind in CSS. It used to be a 54px CSS circle with this 76px
 * drawing centred on top of it and nudged down ten pixels by an unrelated margin -- so the tick
 * sat high and left of its own background, and the sparks landed on the rim instead of flying off
 * it. Two boxes of different sizes will always drift. One coordinate system cannot.
 *
 * The order of it is the point: the ring CLOSES (a thing being sealed), then the tick is written
 * inside it, and only then does anything celebrate. A tick that appears at the same moment as its
 * ring is a picture; drawn in that order it is an event.
 */
export const Landed = () => (
  <svg className="art-landed" width="76" height="76" viewBox="0 0 76 76" fill="none" aria-hidden="true">
    <circle className="disc" cx="38" cy="38" r="30" fill="currentColor" opacity=".13" />
    <g className="sparks" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M38 8v-6" /><path d="M58 16l4-4" /><path d="M68 38h6" />
      <path d="M18 16l-4-4" /><path d="M8 38H2" /><path d="M38 68v6" />
    </g>
    <circle className="halo" cx="38" cy="38" r="30" stroke="currentColor" strokeWidth="2" opacity="0" />
    {/* Rotated so the ring starts closing from the top, the way a clock hand leaves twelve. */}
    <circle className="ring" cx="38" cy="38" r="26" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" transform="rotate(-90 38 38)" />
    <path className="draw" d="m24 39 9.5 9.5L53 29" stroke="currentColor" strokeWidth="4.5"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * A search that found nothing: the glass sweeps across, its glint travelling with it, over three
 * lines that stay stubbornly empty.
 */
export const NoMatch = () => (
  <svg className="art-look" width="120" height="96" viewBox="0 0 120 96" fill="none" aria-hidden="true">
    <g className="lines" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity=".18">
      <path className="l1" d="M18 70h34" /><path className="l2" d="M18 80h58" /><path className="l3" d="M18 60h22" />
    </g>
    <g className="glass">
      <circle cx="52" cy="34" r="20" stroke="currentColor" strokeWidth="3" />
      <path d="m67 49 14 14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path className="glint" d="M43 28a11 11 0 0 1 9-7" stroke="currentColor" strokeWidth="3"
        strokeLinecap="round" opacity=".45" />
    </g>
  </svg>
);

/** A tick small enough to live inside a button, drawn once. */
export const Ticked = () => (
  <svg className="motion tick" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path className="draw" d="m3 8.5 3.2 3.2L13 4.6" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** How close a bag is to the shop's free-delivery figure. */
export const Toward = ({ done }) => (
  <span className="toward" aria-hidden="true">
    <i style={{ width: `${Math.max(4, Math.min(100, Math.round(done * 100)))}%` }} />
  </span>
);

/** Three dots, for the seconds a try-on takes. */
export const Working = () => (
  <span className="motion dots" aria-hidden="true"><i /><i /><i /></span>
);
