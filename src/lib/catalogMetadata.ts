import { normaliseHex, normaliseShades, Shade } from './colorNames';
import { badRequest } from '../utils/httpError';

/**
 * What a catalogue entry is allowed to carry, checked at the edge.
 *
 * `metadata` used to be written straight from the request body into the database with no
 * inspection at all -- any JSON at all, of any size. That was survivable while nothing read it
 * except a swatch, but the product form now reads shade names out of it, so a malformed
 * metadata blob would reach every colour picker in the app.
 *
 * The other half of the job is the PATCH that arrives with only a hex in it. The Catalog
 * Settings screen sends `metadata: { hex }` when someone edits a colour's label, and because
 * the route replaced metadata wholesale, editing "Blue" to fix its spelling silently deleted
 * all seven of its shades. Merging rather than replacing is what stops that.
 */

export interface ColorMetadata {
  hex: string;
  shades: Shade[];
}

const MAX_SHADES = 24;

/**
 * The metadata to store for a COLOR, given what was posted and what is already there.
 *
 * `incoming` absent entirely means "leave it alone". A key absent WITHIN incoming means the
 * same for that key -- so a screen that only knows about `hex` can never erase `shades`.
 */
export function resolveColorMetadata(incoming: unknown, existing: unknown): ColorMetadata {
  const existingMeta = (existing ?? {}) as Record<string, unknown>;
  const incomingMeta = (incoming ?? {}) as Record<string, unknown>;

  if (incoming !== undefined && (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming))) {
    throw badRequest('Colour details must be an object.');
  }

  const hexSource = 'hex' in incomingMeta ? incomingMeta.hex : existingMeta.hex;
  const hex = normaliseHex(hexSource);
  if (!hex) {
    throw badRequest('Use a hex colour like #FF69B4.');
  }

  if ('shades' in incomingMeta) {
    if (!Array.isArray(incomingMeta.shades)) {
      throw badRequest('Shades must be a list.');
    }
    if (incomingMeta.shades.length > MAX_SHADES) {
      throw badRequest(`A colour can have at most ${MAX_SHADES} shades.`);
    }
    // Every hex in the list has to be real. Dropping a bad one silently would leave the
    // shopkeeper looking at a shade row that vanished without explanation.
    for (const entry of incomingMeta.shades) {
      const candidate = typeof entry === 'string' ? entry : (entry as any)?.hex;
      if (!normaliseHex(candidate)) {
        throw badRequest(`"${String(candidate ?? '')}" is not a hex colour like #FF69B4.`);
      }
    }
  }

  const shadeSource = 'shades' in incomingMeta ? incomingMeta.shades : existingMeta.shades;

  return { hex, shades: normaliseShades(shadeSource) };
}

/**
 * Read-side normalisation, for rows written before shades had names.
 *
 * Every shade in the database today is a bare hex string. Rather than require a backfill to
 * have run before the app works, reading names them on the way out; the backfill then makes
 * that the stored truth so the naming is stable if the palette is later edited.
 */
export function readColorMetadata(metadata: unknown, label?: string): ColorMetadata | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const hex = normaliseHex(meta.hex);
  if (!hex) return null;
  return { hex, shades: normaliseShades(meta.shades, label) };
}
