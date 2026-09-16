/**
 * One way to write a phone number.
 *
 * A counter finds its customers by phone, and the same mobile arrives written a dozen ways --
 * "98480 22338", "09848022338", "+91-98480-22338", "919848022338". Stored as typed, those are four
 * customers, and a regular's history splits across whichever copy the till happened to pick. So
 * every number is stored in one form, E.164: "+" then the country code then the number, with no
 * spaces -- "+919848022338". Equality and the unique index both rely on that.
 *
 * Indian mobiles: 10 digits starting 6-9, with or without +91 / 91 / a leading 0. That is what a
 * shop counter deals in, and what WhatsApp needs later. A landline written with its STD code can
 * look exactly like a mobile (0863 2345678 and 086323 45678 are the same digits), so no rule can
 * refuse every landline; ones that do not look like a mobile are refused.
 *
 * Another country: "+" (or "00") and the country code, 8-15 digits in all, as the ITU allows. A
 * tourist buying a saree is a real customer.
 *
 * Numbers that are plainly not a person's -- all one digit, 1234567890 -- are refused: they are
 * what gets typed to get past a required box, and every walk-in would become the same customer.
 *
 * Kept in step with frontend/src/utils/phone.js, which applies the same rule as it is typed.
 */

export type PhoneResult = { ok: true; value: string } | { ok: false; reason: string };

const INDIA_HINT = 'Enter a 10-digit mobile number, or + and the country code for a number from another country.';

function looksFake(national: string): boolean {
  if (/^(\d)\1+$/.test(national)) return true;
  const ascending = '01234567890123456789';
  const descending = '98765432109876543210';
  return national.length >= 8 && (ascending.includes(national) || descending.includes(national));
}

export function normalisePhone(raw: unknown): PhoneResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'Enter the customer\'s phone number.' };
  const typed = String(raw).trim();
  if (!typed) return { ok: false, reason: 'Enter the customer\'s phone number.' };

  // Spaces, dashes, dots and brackets are how people write numbers; anything else is not a number.
  const compact = typed.replace(/[\s\-.()]/g, '');
  if (!/^(\+|00)?\d+$/.test(compact)) return { ok: false, reason: 'A phone number can only have digits, spaces, + and -.' };

  const international = compact.startsWith('+') || compact.startsWith('00');
  const digits = compact.replace(/^\+|^00/, '');

  if (!international || digits.startsWith('91')) {
    let national: string | null = null;
    if (!international && digits.length === 10) national = digits;
    else if (!international && digits.length === 11 && digits.startsWith('0')) national = digits.slice(1);
    else if (digits.length === 12 && digits.startsWith('91')) national = digits.slice(2);

    if (national === null) {
      return { ok: false, reason: international ? 'An Indian number has 10 digits after +91.' : INDIA_HINT };
    }
    if (!/^[6-9]/.test(national)) {
      return { ok: false, reason: 'An Indian mobile number starts with 6, 7, 8 or 9.' };
    }
    if (looksFake(national)) return { ok: false, reason: 'That doesn\'t look like a real number.' };
    return { ok: true, value: `+91${national}` };
  }

  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) {
    return { ok: false, reason: 'A number from another country is + then the country code and number, 8 to 15 digits.' };
  }
  if (looksFake(digits.slice(-10))) return { ok: false, reason: 'That doesn\'t look like a real number.' };
  return { ok: true, value: `+${digits}` };
}

/** "+919848022338" -> "+91 98480 22338"; other countries are left as stored. */
export function formatPhone(stored: string | null | undefined): string {
  if (!stored) return '';
  const m = /^\+91(\d{5})(\d{5})$/.exec(stored);
  return m ? `+91 ${m[1]} ${m[2]}` : stored;
}

/**
 * The digits a search box should look for in stored numbers. "098480 22338" and "+91 98480"
 * both find "+919848022338". Null when the text holds too few digits to be part of a number.
 */
export function phoneSearchDigits(text: string): string | null {
  // Only when the search reads as a number. "Old Customer 221504" is a name that happens to contain
  // digits, and matching those digits inside other people's phone numbers returned strangers.
  if (!/^[+\d\s\-.()]+$/.test(String(text || '').trim())) return null;
  let digits = String(text || '').replace(/\D/g, '');
  // The trunk 0 people put in front of a mobile ("098480...") is never stored, whether the whole
  // number was typed or only its start.
  if (/^0[6-9]/.test(digits)) digits = digits.slice(1);
  return digits.length >= 4 ? digits : null;
}
