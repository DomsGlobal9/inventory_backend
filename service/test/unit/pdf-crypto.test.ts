import { describe, expect, it } from 'vitest';
import { decodePdf, isPdf, MAX_DOCUMENT_BYTES } from '../../src/lib/pdf';
import { AppError } from '../../src/lib/errors';
import { decrypt, encrypt, hashModuleKey, newModuleKey, safeEqual, signBody, verifySignature } from '../../src/lib/crypto';
import { createHmac, randomBytes } from 'node:crypto';

const pdf = (size: number) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, size - 9), 0x20)]);

function refused(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected a refusal');
}

describe('PDF check', () => {
  it('accepts a real PDF header', () => {
    expect(isPdf(pdf(100))).toBe(true);
    expect(decodePdf(pdf(100).toString('base64'), 'application/pdf').length).toBe(100);
  });
  it('accepts a data URL prefix', () => {
    expect(decodePdf(`data:application/pdf;base64,${pdf(50).toString('base64')}`, 'application/pdf').length).toBe(50);
  });
  it('refuses a file that only claims to be a PDF', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const e = refused(() => decodePdf(png.toString('base64'), 'application/pdf'));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/not a PDF/);
  });
  it('refuses other mime types, empty files and junk', () => {
    expect(refused(() => decodePdf(pdf(10).toString('base64'), 'image/png')).message).toMatch(/Only PDF/);
    expect(refused(() => decodePdf('', 'application/pdf')).status).toBe(400);
    expect(refused(() => decodePdf('!!!not base64!!!', 'application/pdf')).status).toBe(400);
  });
});

describe('size limit', () => {
  it('5 MB exactly is fine', () => {
    expect(decodePdf(pdf(MAX_DOCUMENT_BYTES).toString('base64'), 'application/pdf').length).toBe(MAX_DOCUMENT_BYTES);
  });
  it('one byte over is refused with a plain message', () => {
    const e = refused(() => decodePdf(pdf(MAX_DOCUMENT_BYTES + 1).toString('base64'), 'application/pdf'));
    expect(e.status).toBe(413);
    expect(e.message).toBe('This PDF is larger than 5 MB. Please make it smaller and try again.');
  });
  it('a huge upload is refused before decoding', () => {
    const e = refused(() => decodePdf('A'.repeat(20_000_000), 'application/pdf'));
    expect(e.status).toBe(413);
  });
});

describe('HMAC signing', () => {
  it('matches a standard HMAC-SHA256 of the raw body', () => {
    const body = JSON.stringify({ id: 'e1', type: 'message.status', data: { status: 'DELIVERED' } });
    const expected = `sha256=${createHmac('sha256', 'whsec_test').update(body).digest('hex')}`;
    expect(signBody('whsec_test', body)).toBe(expected);
    expect(verifySignature('whsec_test', body, expected)).toBe(true);
  });
  it('fails for a changed body, a wrong secret or no header', () => {
    const body = '{"a":1}';
    const sig = signBody('s1', body);
    expect(verifySignature('s1', '{"a":2}', sig)).toBe(false);
    expect(verifySignature('s2', body, sig)).toBe(false);
    expect(verifySignature('s1', body, undefined)).toBe(false);
  });
});

describe('keys', () => {
  it('module keys are random and stored only as sha256', () => {
    const a = newModuleKey();
    const b = newModuleKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^wsk_[A-Za-z0-9_-]{43}$/);
    expect(hashModuleKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashModuleKey(a)).not.toContain(a);
  });
  it('constant-time comparison gives the right answers, whatever the lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
  it('webhook secrets round-trip through AES-256-GCM and tampering is detected', () => {
    const key = randomBytes(32).toString('base64');
    const enc = encrypt('whsec_hello', key);
    expect(enc).not.toContain('whsec_hello');
    expect(decrypt(enc, key)).toBe('whsec_hello');
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(buf.toString('base64'), key)).toThrow();
    expect(() => decrypt(enc, randomBytes(32).toString('base64'))).toThrow();
  });
});
