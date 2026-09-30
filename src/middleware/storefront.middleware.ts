import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { prefixOf, credentialMatches } from '../utils/storefrontCredential';
import { isPosConnection } from '../utils/posConnection';

/**
 * Authenticating a storefront reading the catalogue.
 *
 * This is a THIRD kind of caller, deliberately separate from the two that already exist:
 *
 *   authenticate          a person, by session cookie
 *   verifyServiceToken    another Scaleezy service, by RS256 assertion
 *   this                  a merchant's website, by connection credential
 *
 * Keeping them apart matters. `auth.middleware.ts:16-23` records that an
 * `x-internal-service-key` bypass once existed inside the human path and was removed as a
 * vulnerability; a storefront credential must never be able to satisfy a human route, and a
 * human session must never reach a storefront route.
 *
 * The credential identifies a CONNECTION, and the connection supplies the tenant and the
 * location scope. Authorisation is therefore never taken from anything the caller sent -- a
 * clientId in a header or a query string is ignored, because a credential that could name its
 * own tenant would be a credential that could read any tenant.
 */

export interface StorefrontContext {
  connectionId: string;
  clientId: string;
  locationIds: string[];
  connectionName: string;
  status: string;
  /** A till (POS) or a website. Each may use only its own routes -- see onlyPos / onlyWebsites. */
  kind: 'POS' | 'WEBSITE';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      storefront?: StorefrontContext;
    }
  }
}

function presentedCredential(req: Request): string | null {
  const header = req.headers['x-storefront-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();

  return null;
}

export async function authenticateStorefront(req: Request, res: Response, next: NextFunction) {
  const credential = presentedCredential(req);
  if (!credential) {
    res.status(401).json({
      success: false,
      message: 'Missing storefront credential. Send it as X-Storefront-Key or a Bearer token.'
    });
    return;
  }

  const prefix = prefixOf(credential);
  if (!prefix) {
    res.status(401).json({ success: false, message: 'That storefront credential is not valid.' });
    return;
  }

  // Found by its non-secret prefix -- one indexed lookup -- then verified by hash. The prefix
  // narrows; only the hash authenticates.
  const candidates = await prisma.storefrontConnection.findMany({
    where: { credentialPrefix: prefix },
    select: {
      id: true, clientId: true, name: true, status: true,
      credentialHash: true, locationIds: true, baseUrl: true
    }
  });

  const connection = candidates.find(c => credentialMatches(credential, c.credentialHash));
  if (!connection) {
    res.status(401).json({ success: false, message: 'That storefront credential is not valid.' });
    return;
  }

  if (connection.status === 'REVOKED') {
    res.status(401).json({
      success: false,
      message: 'This storefront credential has been revoked. Ask the shop owner to reconnect.'
    });
    return;
  }

  if (connection.status === 'DISABLED') {
    res.status(403).json({
      success: false,
      message: 'This storefront connection is paused. Ask the shop owner to re-enable it.'
    });
    return;
  }

  req.storefront = {
    connectionId: connection.id,
    clientId: connection.clientId,
    locationIds: connection.locationIds,
    connectionName: connection.name,
    status: connection.status,
    kind: isPosConnection(connection) ? 'POS' : 'WEBSITE'
  };
  next();
}

/** Narrowing helper, so a route never has to assert the context is present. */
export function storefrontContext(req: Request, res: Response): StorefrontContext | null {
  if (!req.storefront) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return null;
  }
  return req.storefront;
}

/*
 * A key opens only its own door.
 *
 * Until these existed any connection key worked everywhere: a website's key could post bills to
 * /pos/v1, and a till's key could read the public feed. Mounted after authenticateStorefront.
 */
export function onlyPos(req: Request, res: Response, next: NextFunction) {
  if (req.storefront?.kind !== 'POS') {
    res.status(403).json({ success: false, message: 'This key is for a website, not a till. Create a till key in Inventory: Settings, POS (billing counter).' });
    return;
  }
  next();
}

export function onlyWebsites(req: Request, res: Response, next: NextFunction) {
  if (req.storefront?.kind !== 'WEBSITE') {
    res.status(403).json({ success: false, message: 'This key is for a POS till, not a website.' });
    return;
  }
  next();
}
