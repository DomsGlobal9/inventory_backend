import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A dropdown the shop draws itself.
 *
 * A native <select> can be dressed down to look like the pills around it -- its arrow removed, its
 * font inherited -- but the LIST it opens belongs to the operating system: a square white box with
 * a blue bar across the chosen row, in the system font, at the system size. Nothing in CSS reaches
 * it. On the one page where a shop is meant to look like its own shop, that is the one thing that
 * looks like Windows.
 *
 * So the list is ours. What is NOT given up:
 *
 *   - it is still reachable by keyboard, and behaves the way a listbox is expected to: arrows to
 *     move, Enter or Space to take, Escape to leave it alone, Home and End for the ends;
 *   - a screen reader still meets a button that says what it is and a listbox with one option
 *     marked as chosen (aria-activedescendant follows the arrows);
 *   - a finger still gets rows it can hit -- 44px, the same as everything else here.
 *
 * FIXED AND PORTALLED, and it needs to be both. The trigger sits inside `.rail`, which scrolls
 * sideways and clips what overflows it, so an absolutely positioned menu opened inside that
 * scroller and was cut off at its edge. Fixed escapes the clip -- but not the stacking, and the
 * menu then opened BEHIND the product cards, where its own rows could not even be clicked:
 * whatever the pointer landed on, it was not the menu. Rendering it onto <body> leaves it with no
 * ancestor at all to be clipped or buried by. It follows the trigger on scroll rather than closing.
 */
export default function Picker({ value, options, onChange, label }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(null);
  const indexOf = useCallback(
    (v) => Math.max(0, options.findIndex(([o]) => o === v)),
    [options]
  );
  const [active, setActive] = useState(() => indexOf(value));

  const root = useRef(null);
  const trigger = useRef(null);
  const list = useRef(null);
  const id = useRef(`picker-${Math.random().toString(36).slice(2, 8)}`);

  const chosen = options.find(([o]) => o === value) ?? options[0];

  const place = useCallback(() => {
    const b = trigger.current?.getBoundingClientRect();
    if (b) setAt({ top: Math.round(b.bottom + 6), left: Math.round(b.left), width: Math.round(b.width) });
  }, []);

  const show = () => { place(); setActive(indexOf(value)); setOpen(true); };
  const hide = (giveFocusBack = true) => {
    setOpen(false);
    if (giveFocusBack) trigger.current?.focus();
  };
  const choose = (v) => { onChange(v); hide(); };

  /* Anywhere else, and it goes away. pointerdown rather than click, so it closes on the press. */
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (!root.current?.contains(e.target) && !list.current?.contains(e.target)) setOpen(false);
    };
    /*
     * The page moving under a fixed menu leaves it stranded, so it FOLLOWS rather than closes.
     * Closing on any scroll shut it the moment its own list scrolled a row into view.
     */
    const moved = (e) => {
      if (e?.target && list.current?.contains(e.target)) return;
      place();
    };
    document.addEventListener('pointerdown', away);
    // Capture, because the rail scrolls sideways and a scroll event does not bubble.
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open, place]);

  /* Arrowing past the end of a short menu should still bring the row into view. */
  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKey = (e) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        show();
      }
      return;
    }
    const last = options.length - 1;
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i === last ? 0 : i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i === 0 ? last : i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(last); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(options[active][0]); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="picker" ref={root}>
      <button
        type="button" ref={trigger} className="pill sorter" onKeyDown={onKey}
        onClick={() => (open ? hide(false) : show())}
        aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        aria-controls={open ? id.current : undefined}
        aria-activedescendant={open ? `${id.current}-${active}` : undefined}
      >
        <span>{chosen[1]}</span>
        <svg className="caret" width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" aria-hidden="true" data-open={open || undefined}>
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/*
        ONTO THE BODY, not left where it sits in the markup.

        `position: fixed` escapes the rail's sideways CLIP, but it does not escape a stacking
        context, and the menu opened BEHIND the product cards underneath it -- z-index 60 counts
        for nothing against an ancestor that has already been flattened into a layer of its own.
        Chasing which ancestor did it would fix today's layout and break on the next one. As a
        child of <body> the menu has no ancestor left to be trapped by.
      */}
      {open && at && createPortal(
        <ul
          className="menu" role="listbox" id={id.current} ref={list} aria-label={label}
          style={{ top: at.top, left: at.left, minWidth: at.width }}
        >
          {options.map(([v, l], i) => (
            <li
              key={v} id={`${id.current}-${i}`} role="option"
              aria-selected={v === value} data-active={i === active || undefined}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(v)}
            >
              <span>{l}</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" aria-hidden="true" className="mark">
                <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </li>
          ))}
        </ul>,
        document.body
      )}
    </div>
  );
}
