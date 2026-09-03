import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const devKeysDir = path.join(__dirname, '../../dev-keys');
if (!fs.existsSync(devKeysDir)) {
  fs.mkdirSync(devKeysDir, { recursive: true });
}

// Inventory Keys
const { publicKey: invPub, privateKey: invPriv } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

fs.writeFileSync(path.join(devKeysDir, 'inventory-private.pem'), invPriv);
fs.writeFileSync(path.join(devKeysDir, 'inventory-public.pem'), invPub);

// TryOn Keys (Mocking another service for inbound tests)
const { publicKey: tryonPub, privateKey: tryonPriv } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

fs.writeFileSync(path.join(devKeysDir, 'tryon-private.pem'), tryonPriv);
fs.writeFileSync(path.join(devKeysDir, 'tryon-public.pem'), tryonPub);

console.log('Successfully generated RSA keys for Inventory and TryOn in dev-keys directory.');
