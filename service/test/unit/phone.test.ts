import { describe, expect, it } from 'vitest';
import { digitsFromJid, maskPhone, normalisePhone } from '../../src/lib/phone';

describe('normalisePhone', () => {
  it('adds +91 to a bare Indian mobile', () => {
    expect(normalisePhone('9876543210')).toBe('919876543210');
    expect(normalisePhone('98765 43210')).toBe('919876543210');
    expect(normalisePhone('98765-43210')).toBe('919876543210');
  });
  it('accepts the usual Indian ways of writing a number', () => {
    expect(normalisePhone('+91 98765 43210')).toBe('919876543210');
    expect(normalisePhone('919876543210')).toBe('919876543210');
    expect(normalisePhone('09876543210')).toBe('919876543210');
    expect(normalisePhone('0091 98765 43210')).toBe('919876543210');
    expect(normalisePhone('(+91) 98765-43210')).toBe('919876543210');
  });
  it('keeps foreign numbers given with a country code', () => {
    expect(normalisePhone('+44 7911 123456')).toBe('447911123456');
    expect(normalisePhone('+1 (415) 555-2671')).toBe('14155552671');
  });
  it('refuses what cannot be a WhatsApp number', () => {
    for (const bad of ['', '   ', 'abc', '12345', '1234567890', '5876543210', '+91 12345 67890', '91987654321', '9198765432100', '+1234567890123456', 'call 9876543210', null, undefined, {}]) {
      expect(normalisePhone(bad as unknown)).toBeNull();
    }
  });
});

describe('maskPhone', () => {
  it('shows only the last 4 digits', () => {
    expect(maskPhone('918142424642')).toBe('********4642');
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('123')).toBe('****');
  });
});

describe('digitsFromJid', () => {
  it('reads phone JIDs, including device suffixes', () => {
    expect(digitsFromJid('919876543210@s.whatsapp.net')).toBe('919876543210');
    expect(digitsFromJid('919876543210:12@s.whatsapp.net')).toBe('919876543210');
  });
  it('ignores groups, LIDs and junk', () => {
    expect(digitsFromJid('1203630@g.us')).toBeNull();
    expect(digitsFromJid('123456789012345@lid')).toBeNull();
    expect(digitsFromJid('nonsense')).toBeNull();
    expect(digitsFromJid(null)).toBeNull();
  });
});
