/**
 * Single-use codes: one code per customer, each good once.
 *
 * "WELCOME-7KQ2M9" printed on a card in a parcel, or sent to one person. A shared code like
 * DEEPAVALI ends up on a coupon website by lunchtime; a batch of single-use codes cannot, because
 * each stops working the moment it is spent.
 *
 * The alphabet leaves out the characters people misread off a card -- 0 and O, 1 and I and L --
 * because a code a customer cannot type back correctly is a complaint at the counter.
 *
 * Pure except for randomness, which comes from crypto rather than Math.random: these codes are
 * worth money, and Math.random's sequence can be recovered from a handful of outputs.
 */

import crypto from 'crypto';

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const MAX_CODES_PER_BATCH = 5000;
export const RANDOM_PART_LENGTH = 8;

const PREFIX = /^[A-Z0-9]{2,12}$/;

export function validateCodeBatch(prefix: string, count: number): string[] {
  const problems: string[] = [];
  if (!PREFIX.test(String(prefix ?? '').trim().toUpperCase())) {
    problems.push('Start the codes with 2 to 12 letters or numbers, like WELCOME.');
  }
  if (!Number.isInteger(count) || count < 1) {
    problems.push('Say how many codes to make.');
  } else if (count > MAX_CODES_PER_BATCH) {
    problems.push(`Make at most ${MAX_CODES_PER_BATCH} codes at a time.`);
  }
  return problems;
}

/** One random part, from the unambiguous alphabet, without modulo bias. */
function randomPart(length = RANDOM_PART_LENGTH): string {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      // 248 is the largest multiple of 31 under 256; anything above would favour early letters.
      if (byte >= 248) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * `count` distinct codes, none of them in `taken`.
 *
 * 31^8 is 850 billion, so a clash inside one shop is vanishingly unlikely -- but "unlikely" is not a
 * guarantee, and the database's unique index is the thing that actually decides. This keeps a batch
 * from clashing with itself so a clash at the database means somebody else, not us.
 */
export function generateCodes(prefix: string, count: number, taken: Set<string> = new Set()): string[] {
  const head = String(prefix).trim().toUpperCase();
  const made = new Set<string>();
  while (made.size < count) {
    const code = `${head}-${randomPart()}`;
    if (!taken.has(code)) made.add(code);
  }
  return [...made];
}

/** How a code is compared: the customer's capitals and surrounding spaces do not matter. */
export const canonicalCode = (code: string) => String(code ?? '').trim().toUpperCase();
