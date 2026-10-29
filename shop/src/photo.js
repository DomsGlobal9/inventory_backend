/**
 * Photographs at the size they are shown, not the size they were uploaded (29 Oct).
 *
 * Every tile downloaded the shop's full photograph -- 896x1200, about 550 KB -- to show it 176 px
 * wide, so on a 4G phone the first four sarees took over six seconds to appear. The storage the
 * photographs live in (Supabase) makes a smaller copy on request: the same photograph 420 px wide
 * is about 48 KB. Only addresses in that storage are changed; anything else is used as it is.
 *
 * Each place says how wide it is shown (`sizes`) and is offered a few widths (`srcset`), so a phone
 * with a sharp screen gets enough pixels and a laptop gets more, and nobody downloads the original
 * just to shrink it. A copy that fails to come back falls back to the original (see Shot).
 */
const OBJECT = '/storage/v1/object/public/';
const RENDER = '/storage/v1/render/image/public/';

export const canResize = (url) => typeof url === 'string' && url.includes(OBJECT);

/**
 * The photograph `width` pixels wide (its height follows), or the address unchanged.
 *
 * resize=contain is not optional. Given only a width, the storage keeps the ORIGINAL height and crops
 * the sides to make up the difference: a 2000x667 banner asked for at 1080 came back 1080x667 with
 * its words cut off, and a 896x1200 saree at 540 came back 540x1200, a narrow strip of the saree.
 * contain fits the whole photograph inside that box instead: 1080x360, 540x723.
 */
export function sized(url, width, quality = 72) {
  if (!canResize(url)) return url;
  return `${url.replace(OBJECT, RENDER)}${url.includes('?') ? '&' : '?'}width=${width}&quality=${quality}&resize=contain`;
}

/** A srcset of those widths, or undefined when the address cannot be resized. */
export function widths(url, list, quality) {
  if (!canResize(url)) return undefined;
  return list.map(w => `${sized(url, w, quality)} ${w}w`).join(', ');
}

/** The usual sets. */
export const TILE = [240, 360, 540, 720];
export const THUMB = 160;
export const BANNER = [640, 1080, 1600];
export const GALLERY = [480, 720, 960];

/** onError for a plain <img> given a small copy: once, back to the original photograph. */
export const orWhole = (original) => (e) => {
  const img = e.currentTarget;
  if (img.dataset.whole || !original) return;
  img.dataset.whole = '1';
  img.removeAttribute('srcset');
  img.src = original;
};
