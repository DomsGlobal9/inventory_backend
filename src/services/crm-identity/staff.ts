import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { HttpError } from '../../utils/httpError';
import { crm, crmConfigured, CrmRefused, CrmUnavailable } from './client';
import { crmIdOf, linkOne } from './links';

/**
 * Staff adding and changing customers in a shop whose customers ScaleEzy CRM owns (CRM switched on for the
 * shop by the ScaleEzy admin, and both sides set up). Anywhere else, nothing here does anything.
 *
 *   - Adding: saved in Inventory exactly as before, then linked to CRM at once (2 seconds at most; the link job
 *     finishes it later if CRM is slow). CRM's record wins, so a name CRM already knows for that number comes
 *     back, and the answer says so.
 *   - Changing who they are (name, phone, email, birthday, anniversary) of a customer already linked to CRM:
 *     CRM first. Only if CRM takes it is it saved here; if CRM cannot be reached nothing is changed, said in one
 *     sentence. A customer not linked yet is changed here as always (never blocked). Addresses, GST number,
 *     notes and the offers switch are Inventory's and save as before.
 */
export const IDENTITY_FIELDS = ['name', 'phone', 'email', 'birthday', 'anniversary'] as const;
export const CRM_AWAY = "Couldn't reach ScaleEzy CRM, so nothing was changed. Try again in a minute.";

export async function crmOwnsCustomers(clientId: string) {
  if (!crmConfigured()) return false;
  return !!(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId, module: 'crm' } }, select: { clientId: true } }));
}

/** Straight after staff add someone. Never throws: the customer is already saved. */
export async function afterStaffAdd(clientId: string, customerId: string) {
  if (!(await crmOwnsCustomers(clientId))) return null;
  const outcome = await linkOne(clientId, customerId, 0, 2_000);
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  return { linked: outcome === 'linked', name: c?.name ?? null };
}

/**
 * Before a staff edit is saved. Returns quietly when the edit is Inventory's alone; throws, in words, when CRM
 * refused it or could not be reached (then nothing is saved).
 */
export async function forwardStaffEdit(clientId: string, customerId: string, body: Record<string, unknown>, by: { id: string; name?: string | null }) {
  if (!body || !IDENTITY_FIELDS.some(k => k in body)) return;
  if (!(await crmOwnsCustomers(clientId))) return;
  const live = await prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { name: true, phone: true, email: true, birthday: true, anniversary: true } });
  if (!live) return; // the edit's own "not found" says it
  // The edit form sends every field each time; only what actually changes is CRM's business. A GST number or an
  // address saved while CRM is away must never be held up by an unchanged name riding along.
  const change: Record<string, unknown> = {};
  const same = (k: typeof IDENTITY_FIELDS[number], v: unknown) => {
    const now = (live as any)[k] ?? null;
    if (v === undefined) return true;
    if (k === 'phone') { const p = normalisePhone(v); return p.ok ? p.value === now : (v === null || v === '') && now === null; }
    const t = typeof v === 'string' ? v.trim() : v;
    return (t === '' ? null : t) === now;
  };
  for (const k of IDENTITY_FIELDS) if (k in body && !same(k, body[k])) change[k] = body[k];
  if (!Object.keys(change).length) return;
  let crmId = await crmIdOf(customerId);
  if (!crmId) {
    await linkOne(clientId, customerId, 0, 2_000);
    crmId = await crmIdOf(customerId);
  }
  // Not linked yet (CRM does not know this shop yet, the two sides are not set up to trust each other, or CRM
  // is slow): the edit is saved here as it always was, never blocked. The link job and the change feed bring
  // CRM up to date. Only a customer already linked -- proof both sides work -- waits for CRM.
  if (!crmId) return;
  try {
    await crm.update(clientId, crmId, change, { timeoutMs: 5_000, onBehalfOf: { userId: by.id, name: by.name ?? null } });
  } catch (e) {
    if (e instanceof CrmUnavailable) throw new HttpError(503, CRM_AWAY);
    // A CRM that does not yet take a changed phone number (asked for, 19 Nov): a number-only change it turns
    // away is saved here as before, rather than leaving staff unable to fix a number.
    if (e instanceof CrmRefused && e.status === 400 && Object.keys(change).every(k => k === 'phone')) return;
    if (e instanceof CrmRefused) throw new HttpError(e.status === 404 ? 409 : e.status, e.message);
    throw e;
  }
}
