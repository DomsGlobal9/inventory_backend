/**
 * Getting a try-on photograph small enough to be safe on any phone (13 Nov).
 *
 * A phone camera photograph is 12 to 50 megapixels. Held as a full-size picture, as text for the upload, and as
 * the picture on screen, that is a few hundred megabytes on a phone with 3 GB -- and a low-memory Android then
 * closes the tab or refuses ("memory too low, the operation was not done"). The try-on needs at most 2048 px on
 * the long side, so the photograph is brought down to that the moment it arrives, and the full-size copy is let
 * go at once.
 *
 * createImageBitmap reads the file without a blob: address (the shop's page rules allow data: images, not blob:),
 * and turns the photograph upright from its EXIF on the way.
 */
export const LONG_SIDE = 2048;
export const QUALITY = 0.9;
/** Bigger than any phone photograph; past this it is not a photograph of a person. */
export const MAX_BYTES = 40 * 1024 * 1024;

const COULD_NOT = 'This phone could not prepare the photograph. Please try the Gallery instead.';

/** Draw a picture (bitmap, video frame) into a JPEG data URL no larger than LONG_SIDE. */
export function toJpeg(source, width, height) {
  if (!width || !height) throw new Error(COULD_NOT);
  const scale = Math.min(1, LONG_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(COULD_NOT);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  const url = canvas.toDataURL('image/jpeg', QUALITY);
  // Let the canvas's memory go now rather than whenever the browser gets round to it.
  canvas.width = 0; canvas.height = 0;
  if (!url.startsWith('data:image/jpeg')) throw new Error(COULD_NOT);
  return url;
}

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('That photograph could not be read.'));
  r.readAsDataURL(file);
});

/** A chosen or captured file, as a JPEG data URL of at most LONG_SIDE px. */
export async function shrinkFile(file) {
  if (typeof window.createImageBitmap !== 'function') return readAsDataUrl(file); // very old browsers: as before
  let bitmap;
  try {
    bitmap = await window.createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('That photograph could not be opened. Please choose a JPEG or PNG photo.');
  }
  try {
    return toJpeg(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close?.();
  }
}
