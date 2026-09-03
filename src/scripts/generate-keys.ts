import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const devKeysDir = path.join(__dirname, '../../dev-keys');
if (!fs.existsSync(devKeysDir)) {
  fs.mkdirSync(devKeysDir, { recursive: true });
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem'
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem'
  }
});

fs.writeFileSync(path.join(devKeysDir, 'gateway-private.pem'), privateKey);
fs.writeFileSync(path.join(devKeysDir, 'gateway-public.pem'), publicKey);

console.log('Successfully generated RSA keys in dev-keys directory.');
