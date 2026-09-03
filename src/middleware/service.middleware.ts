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
  };
}

// Memory cache for loaded public keys
const publicKeyCache: Record<string, string> = {};

const getPublicKeyForService = (issuer: string, kid: string): string => {
  const cacheKey = `${issuer}:${kid}`;
  if (publicKeyCache[cacheKey]) return publicKeyCache[cacheKey];

  const registry = env.TRUSTED_SERVICES_KEYS as any;
  if (!registry || !registry[issuer] || !registry[issuer][kid]) {
    throw new Error(`Public key not found for issuer ${issuer} with kid ${kid}`);
  }

  const keyPath = path.resolve(process.cwd(), registry[issuer][kid]);
  const pubKey = fs.readFileSync(keyPath, 'utf8');
  publicKeyCache[cacheKey] = pubKey;
  return pubKey;
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
    let publicKey: string;
    try {
      publicKey = getPublicKeyForService(payload.iss, header.kid);
    } catch (e: any) {
      return res.status(401).json({ success: false, message: `Unauthorized: Unknown issuer or kid. ${e.message}` });
    }

    // 3. Verify Signature & Audience
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      audience: 'inventory'
    }) as jwt.JwtPayload;

    const { sub, scope, clientId, onBehalfOf } = decoded;

    if (!sub || !scope || !Array.isArray(scope)) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing required service claims (sub, scope)' });
    }

    // Enforce clientId for tenant-scoped operations if onBehalfOf is present
    if (onBehalfOf) {
      if (typeof onBehalfOf !== 'object' || Array.isArray(onBehalfOf) || typeof onBehalfOf.userId !== 'string') {
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid onBehalfOf structure' });
      }
      if (!clientId) {
        return res.status(401).json({ success: false, message: 'Unauthorized: Tenant-scoped delegated request must include clientId' });
      }
    }

    // 4. Normalize Service Identity
    const normalizedService: ServiceIdentity = {
      id: sub,
      issuer: payload.iss,
      scopes: scope,
      clientId: clientId,
      onBehalfOf: onBehalfOf
    };

    (req as any).service = normalizedService;
    
    next();
  } catch (error: any) {
    console.error('Service JWT verification failed:', error.message);
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid Service token' });
  }
};
