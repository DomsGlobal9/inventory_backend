import type { Request, Response, NextFunction } from 'express';
import { inventoryOn } from './index';

/**
 * A client without the Inventory module (26 Nov 2026, one-switch onboarding): Inventory's own screens and the
 * Inventory-backed module calls are refused in one recognisable way, agreed with CRM:
 *   409 { success: false, reason: 'no_inventory', message: "This shop doesn't use ScaleEzy Inventory." }
 * Signing in keeps working (Inventory's login is the client's ScaleEzy identity), as do Team members and roles (the
 * stand-in for every module's team), the shop's name and logo, WhatsApp and support.
 */
export const NO_INVENTORY = { success: false, reason: 'no_inventory', message: "This shop doesn't use ScaleEzy Inventory." };

/** Signed-in staff app: what stays open for a client without Inventory (path after /api/v1). */
const STAFF_OPEN = [/^\/team(\/|$)/, /^\/roles(\/|$)/, /^\/branding(\/|$)/, /^\/whatsapp(\/|$)/, /^\/support-tickets(\/|$)/, /^\/live(\/|$)/];

export async function staffInventoryGate(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = (req as any).clientId ?? (req as any).user?.clientId;
    if (!clientId || STAFF_OPEN.some(r => r.test(req.path))) return next();
    if (await inventoryOn(String(clientId))) return next();
    res.status(409).json(NO_INVENTORY);
  } catch (e) { next(e); }
}

/**
 * Module calls (internal, a module's service pass) about one shop: /modules/:module/shops/:clientId/<anything>, and
 * switching that shop's feed on (PUT .../shops/:clientId), need Inventory. Reading the switch list does not.
 */
export async function moduleInventoryGate(req: Request, res: Response, next: NextFunction) {
  try {
    const m = /^\/([a-z-]+)\/shops\/([^/]+)(\/.*)?$/.exec(req.path);
    if (!m) return next();
    const [, , clientId, rest] = m;
    const needs = (rest && rest !== '/') || req.method === 'PUT';
    if (!needs || (await inventoryOn(decodeURIComponent(clientId)))) return next();
    res.status(409).json(NO_INVENTORY);
  } catch (e) { next(e); }
}
