import React from 'react';
import { lengthText, toCut, lineMax } from '../units';

/**
 * How much cloth (13 Nov 2026, PLAN-fabrics.md; mockup 5). − and + step by the smallest cut; the quick lengths the
 * shop chose (1 m, 2.5 m for a blouse, 5.5 m for a saree) are one tap, rounded up to the cut. Never above what is
 * in stock (when the shop shows it) or 100 m. Centimetres in, centimetres out.
 */
export default function LengthPicker({ cut, value, onChange, quick = [], available = null }) {
  const most = Math.min(lineMax('METRE'), available ?? Infinity);
  const set = (cm) => onChange(Math.max(cut, Math.min(cm, Math.floor(most / cut) * cut || cut)));
  const choices = [...new Set(quick.map(q => toCut(q, cut)))].filter(q => q <= most);
  return (
    <div className="lengthpick" role="group" aria-label="Length">
      <div className="lp-row">
        <button type="button" className="lp-step" onClick={() => set(value - cut)} disabled={value <= cut} aria-label={`${lengthText(cut)} less`}>−</button>
        <output className="lp-value" aria-live="polite">{lengthText(value)}</output>
        <button type="button" className="lp-step" onClick={() => set(value + cut)} disabled={value + cut > most} aria-label={`${lengthText(cut)} more`}>+</button>
      </div>
      {choices.length ? (
        <div className="lp-quick">
          {choices.map(q => (
            <button key={q} type="button" className={`lp-chip${q === value ? ' on' : ''}`} aria-pressed={q === value} onClick={() => set(q)}>{lengthText(q)}</button>
          ))}
        </div>
      ) : null}
      <p className="lp-note">Sold in steps of {lengthText(cut)}</p>
    </div>
  );
}
