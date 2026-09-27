/**
 * Split an amount across several lines so that the parts add up to EXACTLY the whole.
 *
 * IN ITS OWN FILE ON PURPOSE. This is pure integer arithmetic with no dependency on anything --
 * no Prisma, no clock, no configuration. It lives apart from money.ts, which imports Prisma for
 * its Decimal type, so that `tax.ts`, `bill.ts` and `hsn.ts` can use it and still be a set that
 * carries nothing with it. That portability is the whole point: the POS and the online shop have
 * to price a basket the same way Inventory does, and a round trip cannot do it -- a till reprices
 * on every keystroke, and offline there is nobody to ask.
 *
 * `money.ts` re-exports this, so every existing caller keeps working and there is still exactly
 * one implementation. Two would be the thing worth avoiding: the moment a discount splits
 * differently in two places, a day book stops balancing and nobody can say which one is right.
 *
 * THE METHOD, and why not the obvious one. This is largest-remainder. The obvious implementation
 * is wrong on the very first three-line order: Rs 100 across three equal lines is 33.33 three
 * times, which is Rs 99.99, and a paisa has gone missing. Over a month that is a day book nobody
 * can reconcile.
 *
 * Each line gets the floor of its exact share; the paise left over are handed out one at a time,
 * largest fractional part first. Ties go to the earlier line, so the same input always produces
 * the same output -- an order re-saved must not redistribute its own discount.
 *
 * `weights` are normally the gross line totals. When they are all zero -- a whole order of
 * zero-priced items with a discount typed against it, which should not happen but does -- the
 * amount is spread as evenly as it can be rather than thrown away.
 */
export function allocate(totalMinor: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (totalMinor === 0) return weights.map(() => 0);

  const negative = totalMinor < 0;
  const total = Math.abs(totalMinor);

  const safeWeights = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = safeWeights.reduce((a, b) => a + b, 0);

  // Nothing to weight by. Even split, remainder to the earliest lines.
  if (weightSum === 0) {
    const base = Math.floor(total / weights.length);
    const shares = weights.map(() => base);
    let left = total - base * weights.length;
    for (let i = 0; left > 0; i++, left--) shares[i] += 1;
    return negative ? shares.map(s => -s) : shares;
  }

  const exact = safeWeights.map(w => (total * w) / weightSum);
  const shares = exact.map(v => Math.floor(v));
  let remaining = total - shares.reduce((a, b) => a + b, 0);

  // Largest fractional part first; index ascending on a tie, so this is a total ordering and
  // the result is reproducible.
  const order = exact
    .map((v, index) => ({ index, fraction: v - Math.floor(v) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));

  for (let i = 0; remaining > 0; i = (i + 1) % order.length, remaining--) {
    shares[order[i].index] += 1;
  }

  return negative ? shares.map(s => -s) : shares;
}
