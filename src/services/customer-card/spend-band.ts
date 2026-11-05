/** What a bill or an item of theirs usually comes to: the middle half of the amounts, or the one amount. Rupees. */
export function spendBand(totals: number[]): { from: number; to: number } | null {
  const t = totals.filter(x => x > 0).sort((a, b) => a - b);
  if (!t.length) return null;
  const at = (q: number) => t[Math.min(t.length - 1, Math.floor(q * (t.length - 1)))];
  const r = (x: number) => Math.round(x / 100) * 100;     // "₹4,000 – 8,000", not "₹3,987 – 8,123"
  return { from: r(at(0.25)), to: r(at(0.75)) };
}
