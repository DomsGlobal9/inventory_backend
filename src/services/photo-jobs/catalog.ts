/**
 * The rules about what the photo studio can photograph, on this side.
 *
 * These four things -- which garments have a model, which model to ask for, what the far end
 * calls each view, and what order a set goes in -- were written in the browser
 * (frontend/src/lib/catalogGeneration.js) because that is where generation used to happen.
 *
 * They are repeated here rather than imported because the two runtimes cannot share a file, and
 * because the worker has to be able to answer these questions with no browser present at all:
 * a job resumed after a redeploy has nobody to ask. Where they must agree, they are marked.
 */

/** The order a set of photographs is shown in. Must match VIEW_ORDER in the browser. */
export const VIEW_ORDER = ['front', 'left', 'right', 'back'];

/** The far end's view names are not ours 1:1. Must match API_VIEW_TO_LOCAL in the browser. */
export const API_VIEW_TO_LOCAL: Record<string, string> = {
  front: 'front',
  sitting: 'left',
  side: 'right',
  back: 'back'
};

/**
 * Which model family a garment belongs to, or nothing.
 *
 * The Try-On API supports these five and no others. Menswear, kids' sets, western wear and the
 * catch-all types like "Wedding" have no matching model, and the old behaviour of quietly
 * defaulting them to KURTI produced nonsense for garments that were nothing like a kurti.
 * Nothing here means the shop is told plainly rather than charged for a picture of the
 * wrong thing.
 */
export function resolveTryOnCategory(dressType?: string | null): string | null {
  const dt = (dressType || '').toLowerCase();
  if (dt.includes('saree')) return 'SAREE';
  if (dt.includes('anarkali')) return 'ANARKALI';
  if (dt.includes('lehanga') || dt.includes('lehenga')) return 'LEHANGA';
  if (dt.includes('sharara')) return 'SHARARA';
  if (dt.includes('kurti') || dt.includes('kurta')) return 'KURTI';
  return null;
}

/**
 * One of the four standard models for a family.
 *
 * There is no preview imagery for them, so there is nothing to offer a shop to choose between --
 * it is picked at random. Chosen ONCE, when the job is made, and then kept on the row: a job
 * retried after a restart has to ask for the same model as the views it already saved, or the
 * shop ends up with a front view on one woman and a back view on another.
 */
export function pickRandomModelId(category: string): string {
  return `${category.toLowerCase()}${Math.floor(Math.random() * 4) + 1}`;
}
