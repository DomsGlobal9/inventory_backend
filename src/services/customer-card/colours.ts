/**
 * Colour families, so a customer who buys Navy, Indigo and Peacock is seen as someone who loves blue.
 *
 * The catalogue mixes shop words ("Maroon", "Rani", "Mehendi") with web colour names ("Firebrick",
 * "Medium Violet Red", "Goldenrod"). Rules are checked in order and the first match wins, so the
 * two-word names that would otherwise land in the wrong family come first ("Blue Violet" is a
 * purple, "Medium Violet Red" a pink, "Rose Gold" a pink). A name no rule knows stays as typed.
 */
const PHRASES: [string, string][] = [
  ['blue violet', 'Purple'], ['violet red', 'Pink'], ['rose gold', 'Pink'], ['off white', 'White'], ['sea green', 'Green'], ['orange red', 'Orange']
];
const WORDS: [string, string[]][] = [
  ['Pink', ['pink', 'magenta', 'fuchsia', 'rani', 'rose', 'blush']],
  ['Orange', ['orange', 'peach', 'coral', 'salmon', 'rust', 'saffron', 'apricot', 'tangerine']],
  ['Red', ['red', 'maroon', 'crimson', 'firebrick', 'wine', 'burgundy', 'tomato', 'cherry', 'scarlet', 'ruby']],
  ['Gold', ['gold', 'golden', 'zari', 'copper', 'bronze', 'champagne']],
  ['Yellow', ['yellow', 'mustard', 'lemon', 'haldi']],
  ['Green', ['green', 'olive', 'mint', 'emerald', 'parrot', 'mehendi', 'mehndi', 'lime', 'sage', 'pista', 'pistachio']],
  ['Blue', ['blue', 'navy', 'indigo', 'teal', 'peacock', 'turquoise', 'aqua', 'cyan', 'sky', 'denim', 'cobalt', 'navyblue']],
  ['Purple', ['purple', 'violet', 'lavender', 'lilac', 'mauve', 'orchid', 'plum', 'rebecca']],
  ['Brown', ['brown', 'beige', 'tan', 'khaki', 'coffee', 'chocolate', 'camel', 'chikoo', 'sand', 'nude', 'fawn']],
  ['White', ['white', 'cream', 'ivory', 'offwhite', 'pearl']],
  ['Grey', ['grey', 'gray', 'silver', 'charcoal', 'ash', 'smoke']],
  ['Black', ['black', 'jet']],
  ['Multicolour', ['multi', 'multicolor', 'multicolour', 'multicoloured']]
];

/** The family a colour name belongs to ("Dodger Blue" → "Blue"), or the name itself when no rule knows it. */
export function colourFamily(name: string | null | undefined): string | null {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const tokens = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const joined = tokens.join(' ');
  for (const [phrase, family] of PHRASES) if (` ${joined} `.includes(` ${phrase} `)) return family;
  // A whole word, or the start of a long one ("Goldenrod" is gold); short words only whole, so "tan" is not "tangerine".
  const hit = (t: string, w: string) => t === w || (w.length >= 4 && t.startsWith(w));
  for (const [family, words] of WORDS) if (tokens.some(t => words.some(w => hit(t, w)))) return family;
  // Then names written as one word ("skyblue", "lightpink"): a long colour word anywhere inside one.
  for (const [family, words] of WORDS) if (tokens.some(t => words.some(w => w.length >= 4 && t.includes(w)))) return family;
  return raw;
}
