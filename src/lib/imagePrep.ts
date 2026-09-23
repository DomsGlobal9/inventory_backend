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

export async function prepareImage(input: Buffer, limits: PrepareLimits): Promise<Prepared> {
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
  if (meta.width < MIN_SIDE || meta.height < MIN_SIDE) throw badRequest(`The picture is too small (${meta.width} × ${meta.height}). Use one at least ${MIN_SIDE} pixels wide and tall.`);

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
