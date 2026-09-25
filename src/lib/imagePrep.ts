import sharp from 'sharp';

/**
 * Turning whatever a shopkeeper chose from their phone into a picture we are willing to publish.
 *
 * A shop owner picks a photo; what arrives can be a 48-megapixel camera file, a screenshot with
 * transparency, a CMYK file from a printer, an animated GIF, a sideways photo whose rotation lives
 * only in its metadata, or a small file engineered to unpack into gigabytes. Every one of those
 * has to come out the other side as one plain JPEG, or be refused in a sentence the owner can act
 * on.
 *
 * This lives in lib/ rather than inside one feature because two features now need it -- WhatsApp
 * campaign pictures and online-shop banners -- and the parts that matter (the decompression-bomb
 * guard, stripping GPS out of a photo before it is published) are exactly the parts nobody should
 * be writing twice. What differs between them is only how big the result may be, which is why that
 * is the argument.
 */

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;
const MIN_SIDE = 100;
const READABLE = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff']);

export interface Prepared { jpeg: Buffer; width: number; height: number }

export interface PrepareLimits {
  /** The longest side the result may have. */
  maxSide: number;
  /** How large the file may be when it is done. */
  maxBytes: number;
  /** What to say if it cannot be made to fit; each caller's reason is different. */
  tooBig: string;
}

/**
 * Everything that must be true before a picture is worth decoding, and the sentence to say when
 * it is not. Shared, because the guards that matter -- the decompression-bomb limit, the HEIC
 * message a shop owner can actually act on -- are exactly the ones nobody should write twice.
 */
async function inspect(input: Buffer, minSide = MIN_SIDE): Promise<sharp.Metadata> {
  if (!input?.length) throw badRequest('The picture is empty.');
  if (input.length > MAX_UPLOAD_BYTES) throw badRequest('The picture is larger than 15 MB. Choose a smaller one.');

  let meta: sharp.Metadata;
  try {
    // limitInputPixels makes libvips refuse a "decompression bomb" -- a small file that unpacks to
    // a huge image -- before decoding it, rather than after it has eaten the memory.
    meta = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  } catch (e) {
    if (/pixel limit/i.test(String((e as Error)?.message))) throw badRequest('The picture is too large (more than 40 megapixels). Choose a smaller one.');
    throw badRequest('That file is not a picture ScaleEzy can read. Use a JPEG or PNG photo.');
  }
  if (meta.format === 'heif') throw badRequest('This is an iPhone HEIC photo. Share it as a JPEG (or set the camera to "Most Compatible") and choose it again.');
  if (!meta.format || !READABLE.has(meta.format)) throw badRequest('That file is not a picture ScaleEzy can read. Use a JPEG or PNG photo.');
  if (!meta.width || !meta.height) throw badRequest('That picture could not be read.');
  if (meta.width * meta.height > MAX_PIXELS) throw badRequest('The picture is too large (more than 40 megapixels). Choose a smaller one.');
  if (meta.width < minSide || meta.height < minSide) throw badRequest(`The picture is too small (${meta.width} × ${meta.height}). Use one at least ${minSide} pixels wide and tall.`);
  return meta;
}

/** The side of the square an icon is stored at. One size; browsers scale it down themselves. */
export const ICON_SIDE = 256;
/** Below this an icon is a blur in a bookmark bar, which is worse than the browser's default. */
const ICON_MIN_SIDE = 48;

/**
 * A shop's icon: one square PNG, whatever shape they gave us.
 *
 * Squares, because that is the only shape a browser tab, a bookmark and a phone's home screen
 * have. `fit: contain` rather than `cover`: cropping to a square takes the middle, and the middle
 * of a wordmark is two letters -- so a shop that uploads a wide logo would get a favicon reading
 * "AK". Padded instead, so nothing they chose is thrown away.
 *
 * PNG, not the JPEG the rest of this file makes: an icon is flat colour and lettering, where JPEG
 * puts visible fuzz around every edge at the sizes an icon is actually seen at. It also keeps the
 * padding transparent rather than white, so the icon sits properly on a browser's dark theme
 * instead of in a white box.
 */
export async function prepareIcon(input: Buffer): Promise<{ png: Buffer; side: number }> {
  await inspect(input, ICON_MIN_SIDE);
  try {
    const png = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1 })
      .rotate() // upright by the camera's own note, before that note is dropped
      .resize({
        width: ICON_SIDE, height: ICON_SIDE,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .toColourspace('srgb')
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    return { png, side: ICON_SIDE };
  } catch {
    throw badRequest('That picture is damaged and could not be read. Try another copy of it.');
  }
}

export async function prepareImage(input: Buffer, limits: PrepareLimits): Promise<Prepared> {
  await inspect(input);

  // Smaller and smaller until it fits; a normal photo fits at the first try.
  const steps: Array<[number, number]> = [
    [limits.maxSide, 82], [limits.maxSide, 70],
    [Math.round(limits.maxSide * 0.8), 72],
    [Math.round(limits.maxSide * 0.64), 68],
    [Math.round(limits.maxSide * 0.5), 60]
  ];
  for (const [side, quality] of steps) {
    let out: { data: Buffer; info: sharp.OutputInfo };
    try {
      out = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1 })
        .rotate() // upright by the camera's own note, before that note is dropped
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }) // see-through parts become white, not black
        .toColourspace('srgb') // CMYK print files look right on a phone
        .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw badRequest('That picture is damaged and could not be read. Try another copy of it.');
    }
    // sharp writes no metadata unless asked (withMetadata), so GPS and camera data are gone.
    if (out.data.length <= limits.maxBytes) return { jpeg: out.data, width: out.info.width, height: out.info.height };
  }
  throw badRequest(limits.tooBig);
}
