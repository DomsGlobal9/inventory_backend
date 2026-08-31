import jwt from 'jsonwebtoken';
import fs from 'fs';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_v1';
const CLIENT_ID = 'demo-client';

const roles = {
  ADMIN: {
    userId: 'admin-user-1',
    clientId: CLIENT_ID,
    roles: ['ADMIN'],
    permissions: [
      'sales_order:view', 'sales_order:update', 'sales_order:create', 'sales_order:cancel', 'sales_order:confirm',
      'inventory:view', 'inventory:update', 'inventory:create',
      'dispatch:create', 'dispatch:view',
      'customer:view', 'customer:update'
    ]
  },
  WAREHOUSE_STAFF: {
    userId: 'warehouse-user-2',
    clientId: CLIENT_ID,
    roles: ['STAFF'],
    permissions: [
      'inventory:view', 'inventory:update', 
      'sales_order:view', 'sales_order:confirm',
      'dispatch:create', 'dispatch:view'
    ]
  },
  READ_ONLY: {
    userId: 'readonly-user-3',
    clientId: CLIENT_ID,
    roles: ['GUEST'],
    permissions: [
      'sales_order:view',
      'inventory:view',
      'dispatch:view',
      'customer:view'
    ]
  }
};

const creds: any = {};

for (const [roleName, payload] of Object.entries(roles)) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  creds[roleName] = {
    description: `Token for ${roleName} testing`,
    token: token,
    payload: payload
  };
}

// Add the Internal Service Key for Service-to-Service testing
creds['INTERNAL_SERVICE'] = {
  description: 'Internal Service Key (used by Billing/Storefront)',
  headerName: 'x-internal-service-key',
  headerValue: process.env.INTERNAL_SERVICE_KEY || 'development_secret_key_123'
};

fs.writeFileSync('test-creds.json', JSON.stringify(creds, null, 2));
console.log('✅ test-creds.json generated successfully!');
