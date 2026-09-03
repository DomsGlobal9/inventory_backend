import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';
import { v4 as uuidv4 } from 'uuid';

let inventoryPrivateKey: string | null = null;

const getInventoryPrivateKey = (): string => {
  if (inventoryPrivateKey) return inventoryPrivateKey;
  if (!env.INVENTORY_PRIVATE_KEY_PATH) {
    throw new Error('INVENTORY_PRIVATE_KEY_PATH is not defined in environment');
  }
  const keyPath = path.resolve(process.cwd(), env.INVENTORY_PRIVATE_KEY_PATH);
  inventoryPrivateKey = fs.readFileSync(keyPath, 'utf8');
  return inventoryPrivateKey;
};

interface ServiceTokenOptions {
  audience: string;
  scopes: string[];
  clientId?: string;
  onBehalfOfUserId?: string;
  onBehalfOfPrincipalType?: 'SUPER_ADMIN' | 'USER';
}

export class ServiceAuth {
  /**
   * Generates a Service JWT to authenticate Inventory against another microservice.
   * If clientId and onBehalfOfUserId are provided, the request is delegated.
   * Otherwise, it's a pure system-to-system request.
   */
  static generateOutboundServiceToken(options: ServiceTokenOptions): string {
    const privateKey = getInventoryPrivateKey();

    const payload: any = {
      iss: 'scal_easy_inventory',
      aud: options.audience,
      sub: 'inventory-service',
      scope: options.scopes,
      jti: uuidv4(),
    };

    if (options.clientId) {
      payload.clientId = options.clientId;
    }

    if (options.onBehalfOfUserId) {
      payload.onBehalfOf = {
        userId: options.onBehalfOfUserId,
        ...(options.onBehalfOfPrincipalType && { principalType: options.onBehalfOfPrincipalType })
      };
    }

    // Sign with RS256 and explicitly set the kid in the header
    return jwt.sign(payload, privateKey, {
      algorithm: 'RS256',
      expiresIn: '60s',
      keyid: 'inventory-key-01'
    });
  }
}
