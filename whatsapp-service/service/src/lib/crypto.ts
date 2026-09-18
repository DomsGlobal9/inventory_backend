import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison takes the
 * same time whatever the lengths, and a wrong key leaks nothing about the right one.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Module keys: shown once, stored only as a sha256. */
export function newModuleKey(): string {
  return `wsk_${randomBytes(32).toString('base64url')}`;
}

export function hashModuleKey(key: string): string {
  return sha256Hex(key);
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/** Signature a module checks on every event: `sha256=<hex HMAC-SHA256(secret, raw body)>`. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  return safeEqual(signBody(secret, body), header);
}

// AES-256-GCM. Stored as base64(iv[12] | tag[16] | ciphertext).
export function encrypt(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(stored: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
