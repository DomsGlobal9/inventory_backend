import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

/**
 * Which locations belong to a client, remembered briefly.
 *
 * A miss costs one indexed lookup; a hit costs nothing. The TTL is short because the answer
 * changes the moment somebody adds a shop, and being a minute out of date only means one
 * request falls back to the unscoped view.
 */
const LOCATION_TTL_MS = 60_000;
const locationCache = new Map<string, { ids: Set<string>; at: number }>();

async function clientOwnsLocation(clientId: string, locationId: string): Promise<boolean> {
  const cached = locationCache.get(clientId);
  if (cached && Date.now() - cached.at < LOCATION_TTL_MS) {
    return cached.ids.has(locationId);
  }

  try {
    const rows = await prisma.stockLocation.findMany({ where: { clientId }, select: { id: true } });
    const ids = new Set<string>(rows.map((r: { id: string }) => r.id));
    locationCache.set(clientId, { ids, at: Date.now() });
    return ids.has(locationId);
  } catch {
    // If the lookup itself fails, fall back to the tenant-wide view rather than failing the
    // request: a broader answer is wrong in a way the user can see, and a 500 is not.
    return false;
  }
}

export const tenantMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  // If requireAuth middleware ran first, use the verified clientId from the JWT
  let clientId = (req as any).user?.clientId;

  // The clientId MUST come from the trusted identity (req.user) established by auth.middleware.ts
  // The browser is NEVER trusted to provide the clientId via headers.


  if (!clientId) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing tenant context (clientId)'
    });
  }

  // Inject into request object for controllers to use
  (req as any).clientId = clientId;
  
  // Scope to a location, but only one this client actually owns.
  //
  // The header was taken on trust. Nothing leaked -- every query is filtered by clientId as
  // well -- but an id from another tenant still steered the answer: with no stock row for
  // that location, "how many units are here" reads as zero, and the low-stock count then
  // reports every variant as below its reorder level. A dashboard saying "1 item low" on the
  // strength of a location the shop has never heard of is a number nobody can act on.
  //
  // Checked against a short-lived cache rather than a query per request: locations change
  // when somebody opens a shop, and this middleware runs on every business call.
  const locationId = req.headers['x-location-id'] as string | undefined;
  if (locationId && await clientOwnsLocation(clientId, locationId)) {
    (req as any).locationId = locationId;
  }

  next();
};
