// Phone numbers are stored as digits only, with the country code (e.g. 919876543210), which is
// also what the engine expects. India is the default country: a bare 10-digit mobile gets +91.

const INDIA = '91';

/** Returns digits with country code, or null when it cannot be a real WhatsApp number. */
export function normalisePhone(input: unknown): string | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const raw = String(input).trim();
  if (!raw) return null;
  // Only digits, spaces, dashes, dots, brackets and one leading + are acceptable input.
  if (!/^[\d\s\-().+]+$/.test(raw)) return null;
  // One +, and only in front of the digits: "+91 ...", "(+91) ...".
  const compact = raw.replace(/[\s()]/g, '');
  if ((compact.match(/\+/g) ?? []).length > 1 || (compact.includes('+') && !compact.startsWith('+'))) return null;

  let digits = raw.replace(/\D/g, '');
  const hadPlus = compact.startsWith('+');

  if (!hadPlus && digits.startsWith('00')) digits = digits.slice(2); // 0091...
  else if (!hadPlus && digits.length === 11 && digits.startsWith('0')) digits = INDIA + digits.slice(1); // 09876543210
  else if (!hadPlus && digits.length === 10) {
    // Indian mobiles start 6-9; a 10-digit number starting otherwise is not one.
    if (!/^[6-9]/.test(digits)) return null;
    digits = INDIA + digits;
  }

  // E.164: at most 15 digits; nothing real is shorter than 8 with its country code.
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('0')) return null;
  // +91 is India only, and WhatsApp there means a mobile: 91 + 10 digits starting 6-9.
  if (digits.startsWith(INDIA) && (digits.length !== 12 || !/^[6-9]/.test(digits.slice(2)))) return null;
  return digits;
}

/** For anything a person or a log may see: only the last 4 digits. */
export function maskPhone(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const d = String(digits).replace(/\D/g, '');
  if (d.length <= 4) return '****';
  return `${'*'.repeat(d.length - 4)}${d.slice(-4)}`;
}

/** Engine JIDs look like 919876543210@s.whatsapp.net or 919876543210:12@s.whatsapp.net. */
export function digitsFromJid(jid: string | null | undefined): string | null {
  if (!jid || typeof jid !== 'string') return null;
  const [user, server] = jid.split('@');
  if (!user || !server || !server.startsWith('s.whatsapp.net')) return null;
  const d = user.split(':')[0] ?? '';
  return /^\d{8,15}$/.test(d) ? d : null;
}
