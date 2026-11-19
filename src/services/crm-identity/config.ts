import { createPrivateKey, KeyObject } from 'crypto';
import { readFileSync } from 'fs';

/**
 * ScaleEzy CRM owns who a customer is for a shop with CRM on (19 Nov 2026, the owner). Inventory talks to CRM
 * ONLY through CRM's service API and CRM's signed events; nothing here reads CRM's database.
 *
 * Nothing happens until both sides are set up. Missing any of these, the link job waits and the events
 * address answers "not set up" (so CRM keeps the events and sends them again later):
 *
 *   CRM_SERVICE_URL              CRM's service door, e.g. https://crm.example/api/v1/service
 *   INVENTORY_PRIVATE_KEY_PATH   Inventory's own signing key (PEM file), or INVENTORY_PRIVATE_KEY (the PEM itself)
 *   INVENTORY_KEY_ID             the kid CRM lists Inventory's public key under
 *   CRM_INBOUND_EVENTS_SECRET    the shared secret CRM signs its events with
 */
export const ISSUER = 'scaleezy-inventory';
export const AUDIENCE = 'scaleezy-crm';

let cachedKey: { from: string; key: KeyObject | null } | null = null;

function signingKey(): KeyObject | null {
  const pem = process.env.INVENTORY_PRIVATE_KEY;
  const path = process.env.INVENTORY_PRIVATE_KEY_PATH;
  const from = pem ? 'pem' : path ?? '';
  if (!from) return null;
  if (cachedKey?.from === from) return cachedKey.key;
  let key: KeyObject | null = null;
  try { key = createPrivateKey(pem ? pem.replace(/\\n/g, '\n') : readFileSync(path!, 'utf8')); }
  catch (e) { console.error(`[crm-identity] Inventory's signing key could not be read: ${(e as Error).message}`); }
  cachedKey = { from, key };
  return key;
}

export type CallerConfig = { baseUrl: string; key: KeyObject; kid: string };

/** How to call CRM, or null while it is not set up. */
export function callerConfig(): CallerConfig | null {
  const baseUrl = (process.env.CRM_SERVICE_URL ?? '').replace(/\/+$/, '');
  const kid = process.env.INVENTORY_KEY_ID ?? '';
  if (!baseUrl || !kid) return null;
  const key = signingKey();
  return key ? { baseUrl, key, kid } : null;
}

/** The secret CRM's events are signed with (CRM_INBOUND_EVENTS_SECRET, or a file at CRM_INBOUND_EVENTS_SECRET_PATH), or null while it is not set up. */
export function inboundSecret(): string | null {
  if (process.env.CRM_INBOUND_EVENTS_SECRET) return process.env.CRM_INBOUND_EVENTS_SECRET;
  const path = process.env.CRM_INBOUND_EVENTS_SECRET_PATH;
  if (!path) return null;
  try { return readFileSync(path, 'utf8').trim() || null; }
  catch (e) { console.error(`[crm-identity] the events secret file could not be read: ${(e as Error).message}`); return null; }
}
