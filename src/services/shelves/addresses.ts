import crypto from 'crypto';
import { badRequest } from '../../utils/httpError';

/**
 * Addresses, label codes and walking order for racks and shelves.
 *
 * The database holds the same rules (migration 20260917120000_racks_and_shelves): a code is 1-12
 * letters and digits, an address is up to four codes joined by "-", upper case. These functions exist
 * so a person hears a sentence before the database would refuse.
 */

export const MAX_DEPTH = 4;
export const MAX_CODE_LENGTH = 12;
const CODE_PATTERN = /^[A-Z0-9]{1,12}$/;

/** "c 2" -> "C2". Case and spaces are forgiven; anything else is refused with the reason. */
export function normaliseCode(input: unknown, what = 'A code'): string {
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw badRequest(`${what} is needed, such as C2 or 03.`);
  }
  const code = String(input).trim().toUpperCase().replace(/\s+/g, '');
  if (!code) throw badRequest(`${what} is needed, such as C2 or 03.`);
  if (code.length > MAX_CODE_LENGTH) throw badRequest(`${what} can be at most ${MAX_CODE_LENGTH} letters or digits.`);
  if (!CODE_PATTERN.test(code)) {
    throw badRequest(`${what} "${code}" can use only letters and digits. The dash between parts is added for you.`);
  }
  return code;
}

export const joinAddress = (parentAddress: string | null, code: string) =>
  parentAddress ? `${parentAddress}-${code}` : code;

/** A typed or scanned address, in the stored form: "floor - c2 - 1" -> "FLOOR-C2-1". */
export function normaliseAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const parts = input.trim().toUpperCase().split(/\s*-\s*/).map(p => p.replace(/\s+/g, ''));
  if (parts.length === 0 || parts.length > MAX_DEPTH || parts.some(p => !CODE_PATTERN.test(p))) return null;
  return parts.join('-');
}

/**
 * What a shelf label's QR code holds. The prefix and colon cannot occur in an address, so a scanned
 * label and a typed address are never confused.
 */
export const LABEL_PREFIX = 'SEZ:';
export const labelPayload = (labelCode: string) => `${LABEL_PREFIX}${labelCode}`;

/** "SEZ:K7M2QX9TPA" or a bare label code -> "K7M2QX9TPA"; anything else -> null. */
export function parseLabel(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let text = input.trim().toUpperCase();
  if (text.startsWith(LABEL_PREFIX)) text = text.slice(LABEL_PREFIX.length);
  return /^[A-Z0-9]{6,16}$/.test(text) ? text : null;
}

// No 0/O, 1/I/L: a label code is sometimes read aloud or typed from a torn sticker.
const LABEL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newLabelCode(length = 10): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += LABEL_ALPHABET[bytes[i] % LABEL_ALPHABET.length];
  return out;
}

/**
 * Where a spot comes in a walk through the location: its ancestors' walk orders, then its own.
 * Compared part by part, so everything in area 10 comes before area 20 whatever the rack numbers.
 */
export type WalkKey = number[];

export function compareWalk(a: { walkKey: WalkKey; address: string }, b: { walkKey: WalkKey; address: string }): number {
  const n = Math.min(a.walkKey.length, b.walkKey.length);
  for (let i = 0; i < n; i++) {
    if (a.walkKey[i] !== b.walkKey[i]) return a.walkKey[i] - b.walkKey[i];
  }
  if (a.walkKey.length !== b.walkKey.length) return a.walkKey.length - b.walkKey.length;
  // The tie-break that makes the order deterministic: the same shelves, the same answer, every time.
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

export type SpotTreeRow = {
  id: string;
  parentId: string | null;
  walkOrder: number;
  address: string;
};

/** Walk keys for every spot of a location, from its rows. */
export function walkKeys(rows: SpotTreeRow[]): Map<string, WalkKey> {
  const byId = new Map(rows.map(r => [r.id, r]));
  const memo = new Map<string, WalkKey>();
  const keyOf = (id: string, guard = 0): WalkKey => {
    const hit = memo.get(id);
    if (hit) return hit;
    const row = byId.get(id);
    if (!row || guard > MAX_DEPTH) return [];
    const key = row.parentId ? [...keyOf(row.parentId, guard + 1), row.walkOrder] : [row.walkOrder];
    memo.set(id, key);
    return key;
  };
  for (const r of rows) keyOf(r.id);
  return memo;
}

/**
 * Codes for quick create: "R", 1..20, pad 2 -> R01..R20; letters A..D -> A, B, C, D.
 */
export type CodeRange =
  | { codes: string[] }
  | { from: number; to: number; pad?: number; prefix?: string }
  | { letterFrom: string; letterTo: string; prefix?: string };

export const MAX_BULK = 2000;

export function expandCodes(spec: CodeRange, what: string): string[] {
  let codes: string[];
  if ('codes' in spec) {
    codes = spec.codes.map(c => normaliseCode(c, what));
  } else if ('from' in spec) {
    const { from, to } = spec;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      throw badRequest(`${what}: numbers run from a smaller number to a larger one, such as 1 to 12.`);
    }
    if (to - from + 1 > MAX_BULK) throw badRequest(`${what}: that is more than ${MAX_BULK} at once.`);
    const pad = Math.max(0, Math.min(4, spec.pad ?? 0));
    const prefix = spec.prefix ? normaliseCode(spec.prefix, `${what} prefix`) : '';
    codes = [];
    for (let n = from; n <= to; n++) codes.push(normaliseCode(prefix + String(n).padStart(pad, '0'), what));
  } else {
    const a = String(spec.letterFrom ?? '').trim().toUpperCase();
    const b = String(spec.letterTo ?? '').trim().toUpperCase();
    if (!/^[A-Z]$/.test(a) || !/^[A-Z]$/.test(b) || b < a) {
      throw badRequest(`${what}: letters run from one letter to a later one, such as A to D.`);
    }
    const prefix = spec.prefix ? normaliseCode(spec.prefix, `${what} prefix`) : '';
    codes = [];
    for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) codes.push(normaliseCode(prefix + String.fromCharCode(c), what));
  }
  const seen = new Set<string>();
  for (const c of codes) {
    if (seen.has(c)) throw badRequest(`${what}: "${c}" is listed twice.`);
    seen.add(c);
  }
  if (codes.length === 0) throw badRequest(`${what}: give at least one code.`);
  return codes;
}
