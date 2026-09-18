import { describe, expect, it } from 'vitest';
import { createLogger, maskDigits } from '../../src/lib/logger';

function capture() {
  const lines: string[] = [];
  const logger = createLogger('trace', { write: (l: string) => lines.push(l) });
  return { logger, all: () => lines.join('') };
}

const SECRET_TEXT = 'Your PO 4411 from Lakshmi Silks is attached';
const PHONE = '918142424642';

describe('log redaction', () => {
  it('message text, documents and keys never reach the log output', () => {
    const { logger, all } = capture();
    logger.info(
      {
        text: SECRET_TEXT,
        caption: SECRET_TEXT,
        document: 'JVBERi0xLjQK',
        base64: 'JVBERi0xLjQK',
        message: { conversation: SECRET_TEXT },
        apikey: 'engine-key-123',
        headers: { 'x-module-key': 'wsk_abc', authorization: 'Bearer zzz' },
        nested: { deeper: { text: SECRET_TEXT, secret: 'whsec_abc' } },
        list: [{ text: SECRET_TEXT }],
      },
      'queued',
    );
    const out = all();
    expect(out).not.toContain(SECRET_TEXT);
    expect(out).not.toContain('JVBERi0xLjQK');
    expect(out).not.toContain('engine-key-123');
    expect(out).not.toContain('wsk_abc');
    expect(out).not.toContain('whsec_abc');
    expect(out).not.toContain('zzz');
    expect(out).toContain('queued');
  });

  it('full phone numbers never reach the log output, in any field or form', () => {
    const { logger, all } = capture();
    logger.info({ to: PHONE, toDigits: PHONE, phone: `+${PHONE}`, remoteJid: `${PHONE}@s.whatsapp.net`, num: 918142424642 }, `sending to ${PHONE}`);
    logger.warn({ url: `http://engine/chat/${PHONE}` }, 'called +91 81424 24642 and 81424-24642');
    logger.error({ err: new Error(`Bad Request: [{"exists":false,"number":"${PHONE}"}]`) }, 'engine said no');
    const out = all();
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain('8142424642');
    expect(out).not.toContain('81424 24642');
    expect(out).not.toContain('81424-24642');
    // The last 4 digits stay, so a support person can still match a number.
    expect(out).toContain('4642');
  });

  it('keeps what is needed to debug: ids, times, statuses, error messages', () => {
    const { logger, all } = capture();
    const id = '3f4fec9e-50c9-451b-94a6-123456789012';
    logger.info({ messageId: id, status: 'SENT', tries: 2, at: '2026-09-18T10:00:00.000Z' }, 'message sent');
    logger.error({ err: new Error('The engine timed out') }, 'failed');
    const out = all();
    expect(out).toContain(id);
    expect(out).toContain('"status":"SENT"');
    expect(out).toContain('2026-09-18T10:00:00.000Z');
    expect(out).toContain('The engine timed out');
    const first = JSON.parse(out.split('\n')[0] ?? '{}');
    expect(typeof first.time).toBe('string');
    expect(first.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('maskDigits leaves dates and short numbers alone', () => {
    expect(maskDigits('2026-09-18 retry 3 of 3, code 404')).toBe('2026-09-18 retry 3 of 3, code 404');
    expect(maskDigits('to 919876543210')).toBe('to ***3210');
  });
});
