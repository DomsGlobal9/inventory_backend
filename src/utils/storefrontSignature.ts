import crypto from 'crypto';

/**
 * Signing outbound webhooks.
 *
 * The previous scheme sent a header called `x-inventory-event-signature` whose value was a
 * static shared secret. That is a bearer token wearing a signature's name: it proves the
 * sender knows a secret and says nothing about the body, so a proxy could rewrite quantities
 * in flight and a captured request could be replayed forever.
 *
 * What is sent instead:
 *
 *   X-Inventory-Key:          the connection's non-secret credential prefix
 *   X-Inventory-Timestamp:    unix seconds
 *   X-Inventory-Delivery-Id:  stable across every retry of the same delivery
 *   X-Inventory-Signature:    sha256=<hmac>
 *
 * where the HMAC covers `timestamp + "." + rawBody`. Including the timestamp inside the signed
 * material is what makes it a replay defence rather than a decoration: an attacker cannot move
 * a captured request to a new timestamp without invalidating the signature.
 */

export const SIGNATURE_HEADER = 'x-inventory-signature';
export const TIMESTAMP_HEADER = 'x-inventory-timestamp';
export const KEY_HEADER = 'x-inventory-key';
export const DELIVERY_HEADER = 'x-inventory-delivery-id';

/**
 * How far a receiver's clock may differ from ours before a signature is rejected.
 *
 * Five minutes each way. Tight enough that a captured request is not replayable for long,
 * loose enough that an unsynchronised server does not produce intermittent failures the
 * merchant has no way to diagnose. Published, so integrators can account for it.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

export function signedMaterial(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function sign(secret: string, timestamp: number, rawBody: string): string {
  const mac = crypto.createHmac('sha256', secret)
    .update(signedMaterial(timestamp, rawBody), 'utf8')
    .digest('hex');
  return `sha256=${mac}`;
}

/**
 * The receiver's half, exported so the contract can be tested from both ends rather than
 * described in prose and hoped for.
 */
export function verify(
  secret: string,
  timestamp: number,
  rawBody: string,
  presentedSignature: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): { ok: boolean; reason?: string } {
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'timestamp is not a number' };
  if (Math.abs(nowSeconds - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp outside the allowed window' };
  }

  const expected = Buffer.from(sign(secret, timestamp, rawBody), 'utf8');
  const presented = Buffer.from(presentedSignature, 'utf8');
  if (expected.length !== presented.length) return { ok: false, reason: 'signature mismatch' };
  if (!crypto.timingSafeEqual(expected, presented)) return { ok: false, reason: 'signature mismatch' };

  return { ok: true };
}
