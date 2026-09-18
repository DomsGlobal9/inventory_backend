import type { ModuleClient } from '@prisma/client';
import type { Ctx } from '../context';

/**
 * May this module act for (link, send from, read) this platform client's number?
 *
 * The hook for per-module rules. Today: Inventory may use any Inventory client's number, and
 * the platform does not yet tell us which clients use which module, so every active module is
 * allowed every client. When CRM/Marketing join, this is where "only clients that subscribe to
 * this module" is checked (e.g. a lookup against the gateway's subscriptions).
 */
export async function mayModuleUseClient(_ctx: Ctx, mod: ModuleClient, clientId: string): Promise<boolean> {
  if (!mod.active) return false;
  if (!clientId || clientId.length > 100) return false;
  return true;
}
