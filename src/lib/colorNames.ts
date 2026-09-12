/**
 * Giving a shade a name a human can act on.
 *
 * A colour in the catalogue carries a list of shades, and until now that list was bare hex
 * strings. The product form turned every one of them into the same label -- "Blue Shade" for
 * all seven blues -- and that label is what travels to the supplier on a purchase order, into
 * the CSV export, and into the SKU. Measured on the live tenant: "Purple Shade" covered three
 * genuinely different purples, "Blue Shade" and "Pink Shade" two each, and three SKUs had to
 * be auto-renamed with a -2 suffix because two shades of one colour produced the same code.
 *
 * So a shade now has a name, and this is where a default one comes from. The server names
 * shades rather than the browser, deliberately: the shade list can be edited in Catalog
 * Settings, seeded from a template, or backfilled by a script, and all three must agree. One
 * authority, the same reason lowStock.ts exists.
 *
 * The names are the CSS colour names, because they are the only widely agreed vocabulary for
 * "which blue" -- Royal Blue, Sky Blue, Powder Blue are all things a person can picture and a
 * supplier can be told. A merchant who wants "Ramar Blue" or "Arakku" instead can type it;
 * this only supplies the default so that nothing is ever nameless.
 */

/** The CSS named colours, written the way a person would say them. */
const CSS_COLOR_NAMES: Record<string, string> = {
  '#f0f8ff': 'Alice Blue',
  '#faebd7': 'Antique White',
  '#00ffff': 'Aqua',
  '#7fffd4': 'Aquamarine',
  '#f0ffff': 'Azure',
  '#f5f5dc': 'Beige',
  '#ffe4c4': 'Bisque',
  '#000000': 'Black',
  '#ffebcd': 'Blanched Almond',
  '#0000ff': 'Blue',
  '#8a2be2': 'Blue Violet',
  '#a52a2a': 'Brown',
  '#deb887': 'Burlywood',
  '#5f9ea0': 'Cadet Blue',
  '#7fff00': 'Chartreuse',
  '#d2691e': 'Chocolate',
  '#ff7f50': 'Coral',
  '#6495ed': 'Cornflower Blue',
  '#fff8dc': 'Cornsilk',
  '#dc143c': 'Crimson',
  '#00008b': 'Dark Blue',
  '#008b8b': 'Dark Cyan',
  '#b8860b': 'Dark Goldenrod',
  '#a9a9a9': 'Dark Grey',
  '#006400': 'Dark Green',
  '#bdb76b': 'Dark Khaki',
  '#8b008b': 'Dark Magenta',
  '#556b2f': 'Dark Olive Green',
  '#ff8c00': 'Dark Orange',
  '#9932cc': 'Dark Orchid',
  '#8b0000': 'Dark Red',
  '#e9967a': 'Dark Salmon',
  '#8fbc8f': 'Dark Sea Green',
  '#483d8b': 'Dark Slate Blue',
  '#2f4f4f': 'Dark Slate Grey',
  '#00ced1': 'Dark Turquoise',
  '#9400d3': 'Dark Violet',
  '#ff1493': 'Deep Pink',
  '#00bfff': 'Deep Sky Blue',
  '#696969': 'Dim Grey',
  '#1e90ff': 'Dodger Blue',
  '#b22222': 'Firebrick',
  '#fffaf0': 'Floral White',
  '#228b22': 'Forest Green',
  '#ff00ff': 'Fuchsia',
  '#dcdcdc': 'Gainsboro',
  '#f8f8ff': 'Ghost White',
  '#ffd700': 'Gold',
  '#daa520': 'Goldenrod',
  '#808080': 'Grey',
  '#008000': 'Green',
  '#adff2f': 'Green Yellow',
  '#f0fff0': 'Honeydew',
  '#ff69b4': 'Hot Pink',
  '#cd5c5c': 'Indian Red',
  '#4b0082': 'Indigo',
  '#fffff0': 'Ivory',
  '#f0e68c': 'Khaki',
  '#e6e6fa': 'Lavender',
  '#fff0f5': 'Lavender Blush',
  '#7cfc00': 'Lawn Green',
  '#fffacd': 'Lemon Chiffon',
  '#add8e6': 'Light Blue',
  '#f08080': 'Light Coral',
  '#e0ffff': 'Light Cyan',
  '#fafad2': 'Light Goldenrod',
  '#d3d3d3': 'Light Grey',
  '#90ee90': 'Light Green',
  '#ffb6c1': 'Light Pink',
  '#ffa07a': 'Light Salmon',
  '#20b2aa': 'Light Sea Green',
  '#87cefa': 'Light Sky Blue',
  '#778899': 'Light Slate Grey',
  '#b0c4de': 'Light Steel Blue',
  '#ffffe0': 'Light Yellow',
  '#00ff00': 'Lime',
  '#32cd32': 'Lime Green',
  '#faf0e6': 'Linen',
  '#800000': 'Maroon',
  '#66cdaa': 'Medium Aquamarine',
  '#0000cd': 'Medium Blue',
  '#ba55d3': 'Medium Orchid',
  '#9370db': 'Medium Purple',
  '#3cb371': 'Medium Sea Green',
  '#7b68ee': 'Medium Slate Blue',
  '#00fa9a': 'Medium Spring Green',
  '#48d1cc': 'Medium Turquoise',
  '#c71585': 'Medium Violet Red',
  '#191970': 'Midnight Blue',
  '#f5fffa': 'Mint Cream',
  '#ffe4e1': 'Misty Rose',
  '#ffe4b5': 'Moccasin',
  '#ffdead': 'Navajo White',
  '#000080': 'Navy',
  '#fdf5e6': 'Old Lace',
  '#808000': 'Olive',
  '#6b8e23': 'Olive Drab',
  '#ffa500': 'Orange',
  '#ff4500': 'Orange Red',
  '#da70d6': 'Orchid',
  '#eee8aa': 'Pale Goldenrod',
  '#98fb98': 'Pale Green',
  '#afeeee': 'Pale Turquoise',
  '#db7093': 'Pale Violet Red',
  '#ffefd5': 'Papaya Whip',
  '#ffdab9': 'Peach Puff',
  '#cd853f': 'Peru',
  '#ffc0cb': 'Pink',
  '#dda0dd': 'Plum',
  '#b0e0e6': 'Powder Blue',
  '#800080': 'Purple',
  '#663399': 'Rebecca Purple',
  '#ff0000': 'Red',
  '#bc8f8f': 'Rosy Brown',
  '#4169e1': 'Royal Blue',
  '#8b4513': 'Saddle Brown',
  '#fa8072': 'Salmon',
  '#f4a460': 'Sandy Brown',
  '#2e8b57': 'Sea Green',
  '#fff5ee': 'Seashell',
  '#a0522d': 'Sienna',
  '#c0c0c0': 'Silver',
  '#87ceeb': 'Sky Blue',
  '#6a5acd': 'Slate Blue',
  '#708090': 'Slate Grey',
  '#fffafa': 'Snow',
  '#00ff7f': 'Spring Green',
  '#4682b4': 'Steel Blue',
  '#d2b48c': 'Tan',
  '#008080': 'Teal',
  '#d8bfd8': 'Thistle',
  '#ff6347': 'Tomato',
  '#40e0d0': 'Turquoise',
  '#ee82ee': 'Violet',
  '#f5deb3': 'Wheat',
  '#ffffff': 'White',
  '#f5f5f5': 'White Smoke',
  '#ffff00': 'Yellow',
  '#9acd32': 'Yellow Green'
};

/** #abc and #AABBCC both become #aabbcc. Returns null for anything that is not a hex colour. */
export function normaliseHex(value: unknown): string | null {
  const raw = String(value ?? '').trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(raw);
  if (short) {
    const [r, g, b] = short[1]!.split('');
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null;
}

function toRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

/**
 * "Redmean" distance rather than plain Euclidean RGB.
 *
 * Straight RGB distance calls #2f2f2f closer to Dark Green than to Dark Slate Grey, because
 * it treats a unit of blue as mattering exactly as much as a unit of green. Redmean weights
 * the channels by how the eye actually separates them, which is a few lines of arithmetic and
 * gives names that do not make the shopkeeper wonder what we were looking at.
 */
function distance(a: string, b: string): number {
  const [r1, g1, b1] = toRgb(a);
  const [r2, g2, b2] = toRgb(b);
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(
    (((512 + rMean) * dr * dr) / 256) + 4 * dg * dg + (((767 - rMean) * db * db) / 256)
  );
}

/** Hue in degrees, and saturation 0..1. Only these two are needed to tell colours apart. */
function hueAndSaturation(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = toRgb(hex).map(v => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };

  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));

  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = hue * 60;
  if (hue < 0) hue += 360;

  return { hue, saturation };
}

/** Below this a colour is a grey, and naming it by hue would be inventing a colour it has not got. */
const NEUTRAL_SATURATION = 0.12;
/** How far round the wheel a name may sit and still describe the same colour. */
const HUE_TOLERANCE = 40;

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Every agreed name for a colour, closest first.
 *
 * Nearest-by-distance alone is not enough. Measured against the seeded palette it called
 * #c1e1c1 -- a pale green sitting in the GREEN list -- "Light Grey", because the numerically
 * closest entry happened to be a grey, and it called #555555 "Dark Slate Grey" when Dim Grey
 * is the same colour without the invented green tint. So candidates are first narrowed to the
 * same family: a grey is named from the greys, and a coloured shade from names of roughly its
 * own hue. Distance then decides within that family, which is the job it is good at.
 *
 * A list rather than a single answer, because the caller has to skip a name it has already
 * used on a different shade of the same colour.
 */
export function rankedNames(hex: string): string[] {
  return rankedCandidates(hex).map(c => c.name);
}

/**
 * How far a name may sit from the colour it is put on.
 *
 * In redmean units, where 0 is the same colour: a pale green named "Pale Green" scores about
 * 105, a near-white named "Gainsboro" about 48, and #555555 named "Light Grey" -- which is
 * what displacement produced before this limit existed -- scores 378. Somewhere past 200 the
 * name stops describing the thing, and a supplier reading "Light Grey" on a purchase order
 * for a dark charcoal sends back the wrong cloth. Past the limit the shade takes a numbered
 * version of its own nearest name instead: "Grey 2" is honest where "Light Grey" is not.
 */
const NAME_TOLERANCE = 200;

export function rankedCandidates(hex: string): { name: string; d: number }[] {
  const normalised = normaliseHex(hex);
  if (!normalised) return [];

  const exact = CSS_COLOR_NAMES[normalised];
  const { hue, saturation } = hueAndSaturation(normalised);
  const isNeutral = saturation < NEUTRAL_SATURATION;

  const entries = Object.entries(CSS_COLOR_NAMES).map(([candidateHex, name]) => {
    const candidate = hueAndSaturation(candidateHex);
    const candidateNeutral = candidate.saturation < NEUTRAL_SATURATION;
    const sameFamily = isNeutral
      ? candidateNeutral
      : !candidateNeutral && hueGap(hue, candidate.hue) <= HUE_TOLERANCE;
    return { name, sameFamily, d: distance(normalised, candidateHex) };
  });

  // Family first, then everything else as a fallback -- a hue with no named colour anywhere
  // near it should still get a name rather than nothing. Sorted in one pass on both keys:
  // comparing only within a group and returning 0 across them is not a total order, and
  // leaves the two groups interleaved.
  const ordered = entries
    .sort((a, b) => (a.sameFamily === b.sameFamily ? a.d - b.d : a.sameFamily ? -1 : 1))
    .map(({ name, d }) => ({ name, d }));

  return exact ? [{ name: exact, d: 0 }, ...ordered.filter(c => c.name !== exact)] : ordered;
}

/** The agreed name for this exact colour, if it has one. */
export function exactNameFor(hex: string): string | null {
  const normalised = normaliseHex(hex);
  return normalised ? (CSS_COLOR_NAMES[normalised] ?? null) : null;
}

/** The single best agreed name for a colour. */
export function nameForHex(hex: string): string {
  return rankedNames(hex)[0] ?? 'Custom';
}

/** One shade of a catalogue colour. */
export interface Shade {
  hex: string;
  name: string;
}

const MAX_SHADE_NAME = 40;
const MAX_SHADES = 24;

/**
 * Turn whatever is stored (or posted) into a clean, named, duplicate-free shade list.
 *
 * Accepts the old shape too -- every shade in the database today is a bare hex string -- so
 * reading never has to care which generation of the data it found. Two shades that resolve to
 * the same name get numbered, because two rows both called "Goldenrod" would recreate exactly
 * the problem this is here to fix. Two shades with the SAME hex are one shade: the duplicate
 * is dropped rather than renamed, since keeping it could only ever produce two variants of an
 * identical colour.
 */
export function normaliseShades(raw: unknown, baseLabel?: string): Shade[] {
  if (!Array.isArray(raw)) return [];

  const out: (Shade & { index: number })[] = [];
  const seenHex = new Set<string>();
  const usedNames = new Set<string>();

  const entries = raw.slice(0, MAX_SHADES).map((entry, index) => ({
    index,
    hex: normaliseHex(typeof entry === 'string' ? entry : (entry as any)?.hex),
    given: typeof entry === 'object' && entry !== null
      ? String((entry as any).name ?? '').trim().slice(0, MAX_SHADE_NAME)
      : ''
  }));

  /**
   * Who gets first claim on a name. A name the shopkeeper typed always wins it. Then a shade
   * that IS that colour exactly, before one that is merely nearest -- without this, #555555
   * took "Grey" and pushed #808080, which is Grey, onto "Dark Grey", which in turn displaced
   * #a9a9a9. One approximate match at the top of the list shunted every exact one below it.
   * Among the approximate ones, the best fit chooses first, so the shade that most deserves
   * a name is not left with someone else's leftovers.
   */
  const nearest = new Map<number, { name: string; d: number } | undefined>();
  for (const e of entries) nearest.set(e.index, e.hex ? rankedCandidates(e.hex)[0] : undefined);

  const claimOrder = (e: typeof entries[number]) =>
    e.given ? -1 : (e.hex && exactNameFor(e.hex) ? 0 : 1);

  for (const entry of [...entries].sort((a, b) =>
    claimOrder(a) - claimOrder(b) || (nearest.get(a.index)?.d ?? Infinity) - (nearest.get(b.index)?.d ?? Infinity)
  )) {
    if (!entry.hex || seenHex.has(entry.hex)) continue;
    seenHex.add(entry.hex);

    let name = entry.given;
    if (!name) {
      // Walk outwards until a name is both free and still true. Two shades of one colour
      // sharing a label is the exact fault this whole change exists to remove, so a taken
      // name is not an option -- and the second-closest real name ("Gainsboro") reads better
      // than a numbered first one ("White Smoke 2"). But only while it still fits: past
      // NAME_TOLERANCE the honest answer is a numbered version of the nearest name.
      name = rankedCandidates(entry.hex)
        .find(c => c.d <= NAME_TOLERANCE && !usedNames.has(c.name.toLowerCase()))?.name
        ?? nearest.get(entry.index)?.name
        ?? '';
      // A hex the table cannot place at all: fall back to the colour it belongs to, which is
      // at least true. "Custom" on its own tells the shopkeeper nothing.
      if (!name) name = baseLabel ? `${baseLabel} Shade` : 'Custom';
    }

    // A name the shopkeeper typed twice is still theirs; number it rather than refuse it.
    if (usedNames.has(name.toLowerCase())) {
      let n = 2;
      while (usedNames.has(`${name} ${n}`.toLowerCase())) n++;
      name = `${name} ${n}`;
    }

    usedNames.add(name.toLowerCase());
    out.push({ index: entry.index, hex: entry.hex, name });
  }

  // Back into the order they were given in: the picker shows shades in palette order, and
  // sorting named-first above was only ever about who gets first claim on a name.
  return out
    .sort((a, b) => a.index - b.index)
    .map(({ hex, name }) => ({ hex, name }));
}
