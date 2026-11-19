import jwt from 'jsonwebtoken';
import { AUDIENCE, callerConfig, ISSUER } from './config';

/**
 * Inventory calling ScaleEzy CRM's service API, as the module "scaleezy-inventory": a short token signed with
 * Inventory's OWN key (RS256, kid), the shop it is for, the CRM scopes it needs and, when a person did it,
 * who. CRM holds only Inventory's public key and decides what Inventory may do.
 */
export type CrmCustomer = {
  id: string; name: string | null; phone: string | null; email: string | null;
  birthday: string | null; anniversary: string | null; walkIn?: boolean;
  mergedInto: string | null; removed: boolean; ids: { module: string; id: string }[];
};

/** CRM could not be reached, timed out, or failed on its side: try again later. Never the caller's mistake. */
export class CrmUnavailable extends Error {
  constructor(public why: string) { super("Couldn't reach ScaleEzy CRM just now."); }
}
/** CRM answered and said no (4xx), in its own words. */
export class CrmRefused extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

type Opts = { scope: string[]; timeoutMs?: number; onBehalfOf?: { userId: string; name?: string | null } };

export function crmConfigured() { return callerConfig() !== null; }

export async function callCrm<T>(method: 'GET' | 'POST' | 'PATCH', path: string, clientId: string, body: unknown, opts: Opts): Promise<T> {
  const cfg = callerConfig();
  if (!cfg) throw new CrmUnavailable('not set up');
  const token = jwt.sign(
    { clientId, scope: opts.scope, ...(opts.onBehalfOf ? { onBehalfOf: opts.onBehalfOf } : {}) },
    cfg.key as any,
    { algorithm: 'RS256', issuer: ISSUER, audience: AUDIENCE, keyid: cfg.kid, expiresIn: '5m' }
  );
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000)
    });
  } catch (e: any) {
    throw new CrmUnavailable(e?.name === 'TimeoutError' ? 'timed out' : String(e?.message ?? e).slice(0, 200));
  }
  const data: any = await res.json().catch(() => null);
  if (res.ok) return (data?.data ?? data) as T;
  // 401/403 mean the two sides are not set up to trust each other yet: wait, as if CRM were away.
  if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) {
    throw new CrmUnavailable(`HTTP ${res.status}: ${String(data?.message ?? '').slice(0, 200)}`);
  }
  throw new CrmRefused(res.status, String(data?.message ?? `CRM said ${res.status}.`), data);
}

export const crm = {
  findOrAdd: (clientId: string, body: Record<string, unknown>, opts: Partial<Opts> = {}) =>
    callCrm<{ customer: CrmCustomer; created: boolean; matched: null | 'phone' | 'id' }>('POST', '/customers/find-or-add', clientId, body, { scope: ['crm:customer:create'], ...opts }),
  fromInventory: (clientId: string, inventoryId: string, opts: Partial<Opts> = {}) =>
    callCrm<{ id: string; name: string }>('GET', `/customers/from/inventory/${encodeURIComponent(inventoryId)}`, clientId, undefined, { scope: ['crm:customer:view'], ...opts }),
  update: (clientId: string, crmId: string, body: Record<string, unknown>, opts: Partial<Opts> = {}) =>
    callCrm<CrmCustomer>('PATCH', `/customers/${encodeURIComponent(crmId)}`, clientId, body, { scope: ['crm:customer:update'], ...opts }),
  /** Tell CRM this shop's customers are linked: from then on CRM owns them (Inventory's feed only fills blanks). */
  takeOwnership: (clientId: string, opts: Partial<Opts> = {}) =>
    callCrm<{ ownedAt: string | null }>('POST', '/customers/ownership', clientId, { linked: true }, { scope: ['crm:customer:update'], ...opts }),
  ownership: (clientId: string, opts: Partial<Opts> = {}) =>
    callCrm<{ ownedAt: string | null }>('GET', '/customers/ownership', clientId, undefined, { scope: ['crm:customer:view'], ...opts }),
  record: (clientId: string, crmId: string, opts: Partial<Opts> = {}) =>
    callCrm<CrmCustomer>('GET', `/customers/${encodeURIComponent(crmId)}/record`, clientId, undefined, { scope: ['crm:customer:view'], ...opts })
};
