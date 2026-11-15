import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';

export interface ServiceIdentity {
  id: string;
  issuer: string;
  scopes: string[];
  clientId?: string;
  onBehalfOf?: {
    userId: string;
    /** A boutique person: their name and what the boutique lets them do (modules:boutique only). */
    name?: string;
    can?: string[];
  };
  /** modules:boutique: the boutique account the token speaks for, and when it was signed / runs out. */
  tenant?: string;
  issuedAt?: number;
  expiresAt?: number;
}

/**
 * One registered key: the public key, and -- for a key held OUTSIDE ScaleEzy -- the only scopes a pass signed with it
 * may ask for. `scopes: null` is a plain string entry: one of our own modules, trusted with whatever it asks for, as
 * before.
 *
 * Why (15 Nov): a pass names its own scopes, and the routes check only that the scope is in the pass. While every key
 * was ours that was fine; the boutique team's key is the first one held by another company, and with a plain entry it
 * could sign `modules:crm` and read the CRM data of every shop. Registered as { key, scopes: ["modules:boutique"] } it
 * can do boutique calls and nothing else.
 */
type RegisteredKey = { pem: string; scopes: string[] | null };

// Memory cache for loaded public keys
const publicKeyCache: Record<string, RegisteredKey> = {};

const own = (o: unknown, k: string) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

const readKey = (entry: string): string => entry.includes('-----BEGIN')
  ? entry.replace(/\\n/g, '\n')
  : fs.readFileSync(path.resolve(process.cwd(), entry), 'utf8');

const getPublicKeyForService = (issuer: string, kid: string): RegisteredKey => {
  const cacheKey = `${issuer}:${kid}`;
  if (own(publicKeyCache, cacheKey)) return publicKeyCache[cacheKey];

  const registry = env.TRUSTED_SERVICES_KEYS as any;
  if (!own(registry, issuer) || !own(registry[issuer], kid) || !registry[issuer][kid]) {
    throw new Error(`Public key not found for issuer ${issuer} with kid ${kid}`);
  }

  // Either the public key itself (2 Nov: a partner's key added by editing this one setting on the
  // host, no file to upload; line breaks may be written as \n) or, as before, a path to a .pem file.
  // An object { key, scopes } is the same key, held to those scopes. A broken object (no key, no scopes, an empty
  // list, anything not a word) is refused outright rather than trusted with everything.
  const entry = registry[issuer][kid];
  let found: RegisteredKey;
  if (typeof entry === 'object') {
    const scopes = entry.scopes;
    if (typeof entry.key !== 'string' || !entry.key || !Array.isArray(scopes) || !scopes.length
        || !scopes.every((s: unknown) => typeof s === 'string' && s.length > 0)) {
      throw new Error(`The key for issuer ${issuer} with kid ${kid} is set up wrongly (needs key and scopes)`);
    }
    found = { pem: readKey(entry.key), scopes: [...scopes] };
  } else {
    found = { pem: readKey(String(entry)), scopes: null };
  }
  publicKeyCache[cacheKey] = found;
  return found;
};

export const verifyServiceToken = (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid Service token' });
    }

    const token = authHeader.split(' ')[1];
    
    // 1. Decode header to extract kid, and payload to extract iss
    const decodedUnverified = jwt.decode(token, { complete: true });
    if (!decodedUnverified || typeof decodedUnverified !== 'object') {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid token format' });
    }

    const header = decodedUnverified.header;
    const payload = decodedUnverified.payload as jwt.JwtPayload;

    if (!header.kid || !payload.iss) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing kid in header or iss in payload' });
    }

    // Explicitly reject Gateway assertions
    if (payload.iss === 'scal_easy_gateway') {
      return res.status(401).json({ success: false, message: 'Unauthorized: Gateway assertion cannot be used as Service token' });
    }

    // 2. Discover Public Key from Registry
    let registered: RegisteredKey;
    try {
      registered = getPublicKeyForService(payload.iss, header.kid);
    } catch (e: any) {
      return res.status(401).json({ success: false, message: `Unauthorized: Unknown issuer or kid. ${e.message}` });
    }

    // 3. Verify Signature & Audience
    const decoded = jwt.verify(token, registered.pem, {
      algorithms: ['RS256'],
      audience: 'inventory'
    }) as jwt.JwtPayload;

    const { sub, scope, clientId, onBehalfOf, tenant, iat, exp } = decoded as jwt.JwtPayload & { tenant?: unknown };

    if (!sub || !scope || !Array.isArray(scope)) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing required service claims (sub, scope)' });
    }

    // 3b. A key held to some scopes: every scope the pass asks for must be one of them. The whole pass is refused,
    // not trimmed -- a caller asking for more than it was given has a bug or is trying something.
    if (registered.scopes) {
      const extra = scope.filter((s: unknown) => typeof s !== 'string' || !registered.scopes!.includes(s));
      if (extra.length) {
        return res.status(403).json({ success: false, message: `This key may not ask for ${extra.map(String).join(', ')}.` });
      }
    }

    // Enforce clientId for tenant-scoped operations if onBehalfOf is present
    if (onBehalfOf) {
      if (typeof onBehalfOf !== 'object' || Array.isArray(onBehalfOf) || typeof onBehalfOf.userId !== 'string') {
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid onBehalfOf structure' });
      }
      // A boutique pass names its boutique account (tenant) instead: the shop comes from that link, never from the
      // pass (routes/internal-boutique.routes.ts). Every other delegated pass still names its shop.
      const boutiquePass = scope.includes('modules:boutique') && typeof (decoded as any).tenant === 'string';
      if (!clientId && !boutiquePass) {
        return res.status(401).json({ success: false, message: 'Unauthorized: Tenant-scoped delegated request must include clientId' });
      }
    }

    // 4. Normalize Service Identity
    const normalizedService: ServiceIdentity = {
      id: sub,
      issuer: payload.iss,
      scopes: scope,
      clientId: clientId,
      onBehalfOf: onBehalfOf,
      ...(typeof tenant === 'string' ? { tenant } : {}),
      ...(typeof iat === 'number' ? { issuedAt: iat } : {}),
      ...(typeof exp === 'number' ? { expiresAt: exp } : {})
    };

    (req as any).service = normalizedService;
    
    next();
  } catch (error: any) {
    console.error('Service JWT verification failed:', error.message);
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid Service token' });
  }
};
