import crypto from 'crypto';

/**
 * A generated password someone can actually pass on (5 Nov, owner: "cant login with that pass, only after
 * resetting"). Letters and digits only, so a double-tap selects all of it (a "-" ended the selection there, and
 * half a password was copied), and none of the look-alikes (l/I/1, O/0) that get typed wrong off a screen.
 * 12 of these 54 characters is about 69 bits: as strong as the base64url it replaces for a password this size.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function readablePassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}
