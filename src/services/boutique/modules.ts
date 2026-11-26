import { problem, type Actor } from './index';

/**
 * The Boutique app's door to one-switch onboarding (26 Nov 2026, decision O5: Boutique is another team's module; we
 * build the door, its developers only call it). When the Boutique app adds a boutique it links it (POST /link) and may
 * ask for ScaleEzy POS and CRM at once; afterwards it can read how the boutique is connected and switch POS or CRM.
 * Everything goes through the one record of the client's modules (services/client-modules), like the Console's box.
 *   - A boutique's shop runs on ScaleEzy without the Inventory app (no Inventory login): Inventory is off for it.
 *   - Inventory and Logistics are ScaleEzy's to switch, in the Platform Console; the Boutique link is the link itself.
 */
const BOUTIQUE_MAY = ['pos', 'crm'] as const;
const by = (a: { name?: string | null }) => ({ userId: 'boutique-app', name: `${a.name ?? 'Boutique app'} (Boutique)` });

function asked(body: any): Partial<Record<'pos' | 'crm', boolean>> {
  const m = body?.modules;
  if (m === undefined || m === null) return {};
  // Either a list (["pos","crm"] = these on) or { pos: true, crm: false }.
  const out: Partial<Record<'pos' | 'crm', boolean>> = {};
  if (Array.isArray(m)) {
    for (const x of m) {
      if (!(BOUTIQUE_MAY as readonly string[]).includes(x)) throw problem(`The Boutique app can switch ${BOUTIQUE_MAY.join(' and ')}; "${x}" is ScaleEzy's to switch.`);
      out[x as 'pos' | 'crm'] = true;
    }
    return out;
  }
  if (typeof m !== 'object') throw problem('Send modules as a list, like ["pos","crm"], or as { "pos": true }.');
  for (const [k, v] of Object.entries(m)) {
    if (!(BOUTIQUE_MAY as readonly string[]).includes(k)) throw problem(`The Boutique app can switch ${BOUTIQUE_MAY.join(' and ')}; "${k}" is ScaleEzy's to switch.`);
    if (typeof v !== 'boolean') throw problem(`Say ${k}: true or false.`);
    out[k as 'pos' | 'crm'] = v;
  }
  return out;
}

/**
 * Right after POST /link: the client is recorded (Boutique on; Inventory off for a NEW boutique-only shop) with any
 * POS/CRM asked for, and the owner it names (POS and CRM make the owner's own login from it). Asking for modules needs
 * settings:write. Answers the modules and what each module was told.
 */
/** Checked before POST /link makes anything: the modules asked for are ones the Boutique app may switch, by its owner. */
export function checkLinkAsk(pass: { onBehalfOf?: { can?: string[] } | null }, body: any) {
  const want = asked(body);
  if (Object.keys(want).length && !(pass.onBehalfOf?.can ?? []).includes('settings:write')) throw problem('Only the owner may switch POS or CRM on (settings:write).', 403);
}

export async function afterLink(pass: { tenant: string; onBehalfOf?: { name?: string | null; can?: string[] } | null }, link: { clientId: string; linked: 'new' | 'already' }, body: any) {
  const want = asked(body);
  if (Object.keys(want).length && !(pass.onBehalfOf?.can ?? []).includes('settings:write')) throw problem('Only the owner may switch POS or CRM on (settings:write).', 403);
  const cm = await import('../client-modules');
  const name = typeof body?.shopName === 'string' ? body.shopName : null;
  await cm.ensureClient(link.clientId, name ?? link.clientId);
  try {
    if (body?.owner) await cm.setOwner(link.clientId, body.owner, name);
    const modules = { boutique: true, ...(link.linked === 'new' ? { inventory: false } : {}), ...want };
    const out = await cm.setModules(link.clientId, { modules, by: by(pass.onBehalfOf ?? {}), source: 'boutique-api', boutique: { tenant: pass.tenant }, name, quiet: true });
    return { modules: out.modules, told: out.told };
  } catch (e) {
    if (e instanceof cm.ModulesError) throw problem(e.message, e.statusCode);
    throw e;
  }
}

/** GET /modules: which modules the boutique's shop has, and how each says it is connected (the Console's checklist). */
export async function view(a: Actor) {
  const { checklist } = await import('../client-modules/status');
  return checklist(a.clientId);
}

/** PUT /modules: switch POS and/or CRM for the boutique's shop. settings:write. { modules, owner? } */
export async function change(a: Actor, body: any) {
  if (!a.can.includes('settings:write')) throw problem('Only the owner may switch POS or CRM (settings:write).', 403);
  const want = asked(body);
  if (!Object.keys(want).length) throw problem('Say which to switch: { "modules": { "pos": true, "crm": true } }.');
  const cm = await import('../client-modules');
  try {
    if (body?.owner) await cm.setOwner(a.clientId, body.owner);
    const out = await cm.setModules(a.clientId, { modules: want, by: by(a), source: 'boutique-api', quiet: true });
    return { modules: out.modules, changed: out.changed, told: out.told };
  } catch (e) {
    if (e instanceof cm.ModulesError) throw problem(e.message, e.statusCode);
    throw e;
  }
}
