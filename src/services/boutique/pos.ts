import * as posSwitch from '../pos-switch';
import { problem, type Actor } from './index';

/**
 * The POS switch for a boutique's shop (25 Nov 2026; POS's spec D:/villy/pos/PLAN-boutique-pos-switch.md). The
 * Boutique super admin's module switch calls this; it does exactly what the Platform Console's switch does for the
 * boutique's linked shop: Inventory makes the till key and switches POS on for it. settings:write to change.
 */
const mustWrite = (a: Actor) => { if (!a.can.includes('settings:write')) throw problem('This person may not switch POS on or off.', 403); };
const by = (a: Actor) => ({ userId: 'boutique-app', name: `${a.name} (Boutique)` });

async function said<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof posSwitch.PosSwitchError) throw problem(e.message, e.statusCode);
    throw e;
  }
}

export const state = (a: Actor) => said(() => posSwitch.status(a.clientId));

/** { on: true, owner?: { name, email?, phone? } } or { on: false }. A boutique-only shop has no login, so name its owner. */
export async function set(a: Actor, body: any) {
  mustWrite(a);
  if (typeof body?.on !== 'boolean') throw problem('Send "on": true to switch POS on, or false to switch it off.');
  if (!body.on) return said(() => posSwitch.switchOff(a.clientId, by(a)));
  const owner = body.owner && typeof body.owner === 'object' ? body.owner : null;
  if (owner && typeof owner.name !== 'string') throw problem('owner needs a name.');
  return said(() => posSwitch.switchOn(a.clientId, by(a), owner));
}

/** A new one-time welcome link for the owner; reset: true when they cannot sign in any more. */
export async function ownerLink(a: Actor, body: any) {
  mustWrite(a);
  return said(() => posSwitch.ownerLink(a.clientId, by(a), body?.reset === true));
}
