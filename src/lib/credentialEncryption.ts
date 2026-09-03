import crypto from 'crypto';

// Reversible (AES-256-GCM) storage for staff passwords, so a Super Admin/Admin can view a
// team member's current password to re-share it on request -- distinct from `User.password`
// (bcrypt, one-way, used for actual login verification, never touched by this file). This
// is a deliberate, explicitly-approved product trade-off: whoever holds
// CREDENTIAL_ENCRYPTION_KEY + a DB copy can read every staff password on the platform, which
// a one-way hash alone would never allow. Keep the key out of source control in production.
const KEY = process.env.CREDENTIAL_ENCRYPTION_KEY;

function getKey(): Buffer {
  if (!KEY || KEY.length !== 64) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)');
  }
  return Buffer.from(KEY, 'hex');
}

export function encryptCredential(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv.authTag.ciphertext, each base64 -- self-contained so decryption never needs
  // anything beyond this one stored string plus the server-side key.
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptCredential(stored: string): string {
  const [ivB64, authTagB64, dataB64] = stored.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}
