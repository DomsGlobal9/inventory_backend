/**
 * "I'm at the shop": the message a customer sends by scanning the QR at a shop's door. The QR
 * opens WhatsApp with the text already written, and in it a door code, IN- and six letters or
 * digits, that names the store. The code is all this service reads from the message -- the words
 * around it are the customer's, never stored or logged, and a message without a code is nobody's
 * business here.
 */
const CODE = /(?:^|[^A-Z0-9])IN-([A-Z0-9]{6})(?![A-Z0-9])/i;

/** The door code in a customer's message, upper-cased, or null. */
export function checkInCode(words: string): string | null {
  const m = CODE.exec(String(words ?? ''));
  return m?.[1] ? m[1].toUpperCase() : null;
}
