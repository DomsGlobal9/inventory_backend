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
  const owner = body.owner && typeof body.owner === 'object' ? body.owner : null;
  if (body.on && owner && typeof owner.name !== 'string') throw problem('owner needs a name.');
  // One record of the client's modules (26 Nov 2026): POS is switched through it like every door, so CRM and the
  // Console know too. The Boutique app still gets POS's answer at once: told now, and waited for.
  const cm = await import('../client-modules');
  const { tellAndWait } = await import('../client-modules/connect');
  try {
    if (owner) await cm.setOwner(a.clientId, owner);
    await cm.setModules(a.clientId, { modules: { pos: body.on }, by: by(a), source: 'boutique-api', quiet: true });
  } catch (e) {
    if (e instanceof cm.ModulesError) throw problem(e.message, e.statusCode);
    throw e;
  }
  const r = await tellAndWait(a.clientId, 'pos', { by: by(a), source: 'boutique-api' });
  if (r.status === 'DONE') return r.answer;
  if (r.status === 'REFUSED') {
    // As before: refused, nothing changed. The switch goes back, quietly.
    await cm.setModules(a.clientId, { modules: { pos: !body.on }, by: by(a), source: 'boutique-api', quiet: true }).catch(() => undefined);
    throw problem(r.why, 409);
  }
  if (r.status === 'NONE') return said(() => posSwitch.status(a.clientId));
  throw problem('POS could not be reached just now. ScaleEzy keeps trying by itself; check again in a minute.', 503);
}

/** A new one-time welcome link for the owner; reset: true when they cannot sign in any more. */
export async function ownerLink(a: Actor, body: any) {
  mustWrite(a);
  return said(() => posSwitch.ownerLink(a.clientId, by(a), body?.reset === true));
}
