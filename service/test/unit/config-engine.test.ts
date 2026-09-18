import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig } from '../../src/config';
import { classify } from '../../src/engine/client';
import { toAppError } from '../../src/http/errors';
import { EngineError } from '../../src/engine/client';
import { ZodError, z } from 'zod';

const good = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/whatsapp',
  ENGINE_URL: 'whatsapp-engine:8080',
  ENGINE_API_KEY: 'k'.repeat(32),
  ENGINE_WEBHOOK_SECRET: 's'.repeat(32),
  ADMIN_KEY: 'a'.repeat(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SCALEEZY_INSTANCE: 'scaleezy',
};

describe('config', () => {
  it('loads a complete config and adds http:// to a bare host:port', () => {
    const c = loadConfig(good);
    expect(c.ENGINE_URL).toBe('http://whatsapp-engine:8080');
    expect(c.PORT).toBe(18081);
    expect(c.CANARY_ENABLED).toBe(false);
  });
  it('refuses to start without a secret, naming it', () => {
    for (const key of ['ENGINE_API_KEY', 'ADMIN_KEY', 'ENCRYPTION_KEY', 'ENGINE_WEBHOOK_SECRET', 'DATABASE_URL', 'SCALEEZY_INSTANCE']) {
      const env = { ...good } as Record<string, string>;
      delete env[key];
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(new RegExp(key));
    }
  });
  it('refuses malformed values', () => {
    expect(() => loadConfig({ ...good, ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...good, ADMIN_KEY: 'weak' })).toThrow(/ADMIN_KEY/);
    expect(() => loadConfig({ ...good, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...good, PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...good, CANARY_ENABLED: 'maybe' })).toThrow(/CANARY_ENABLED/);
    expect(() => loadConfig({ ...good, SEND_GAP_MIN_MS: '9000', SEND_GAP_MAX_MS: '4000' })).toThrow(/SEND_GAP/);
  });
});

describe('engine error classification', () => {
  it('reads Evolution error bodies', () => {
    expect(classify(400, { status: 400, response: { message: [{ exists: false, jid: 'x', number: '1' }] } }).kind).toBe('not_on_whatsapp');
    expect(classify(400, { response: { message: ['Error: Connection Closed'] } }).kind).toBe('not_connected');
    expect(classify(400, { response: { message: ['The "x" instance is not connected'] } }).kind).toBe('not_connected');
    expect(classify(404, { response: { message: ['The "x" instance does not exist'] } }).kind).toBe('not_found');
    expect(classify(401, {}).kind).toBe('unauthorized');
    expect(classify(500, { response: { message: ['boom'] } }).kind).toBe('server');
    expect(classify(400, { response: { message: ['Timed Out'] } }).kind).toBe('server');
    expect(classify(400, { response: { message: ['something else'] } }).kind).toBe('rejected');
  });
  it('only server/timeout/unreachable are transient', () => {
    expect(new EngineError('server', '').transient).toBe(true);
    expect(new EngineError('timeout', '').transient).toBe(true);
    expect(new EngineError('unreachable', '').transient).toBe(true);
    expect(new EngineError('rejected', '').transient).toBe(false);
    expect(new EngineError('not_connected', '').transient).toBe(false);
  });
});

describe('errors people see are plain English, never stack traces', () => {
  it('maps internal failures to a plain message', () => {
    const e = toAppError(new Error('TypeError: cannot read properties of undefined at /app/dist/x.js:1:2'));
    expect(e.status).toBe(500);
    expect(e.message).toBe('Something went wrong on our side. Please try again.');
  });
  it('maps validation, engine and body errors', () => {
    let zerr: ZodError | null = null;
    try {
      z.object({ to: z.string() }).strict().parse({ foo: 1 });
    } catch (e) {
      zerr = e as ZodError;
    }
    expect(toAppError(zerr).message).toMatch(/^The request is not valid: /);
    expect(toAppError(new EngineError('unreachable', 'x')).message).toBe('WhatsApp is not reachable right now. Please try again in a few minutes.');
    expect(toAppError({ type: 'entity.too.large' }).status).toBe(413);
    expect(toAppError({ type: 'entity.parse.failed' }).message).toBe('The request body is not valid JSON.');
  });
});
