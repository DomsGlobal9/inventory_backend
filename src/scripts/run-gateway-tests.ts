import axios from 'axios';
import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

dotenv.config();

const BASE_URL = 'http://localhost:4006/api/v1';

async function runGatewayTests() {
  console.log('--- STARTING PHASE 3.1-3.3 GATEWAY AUTH TEST SUITE ---\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (e: any) {
      const errorMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      console.log(`[FAIL] ${name} - ${e.message} - ${errorMsg}`);
      failed++;
    }
  }

  // Load private key to sign test assertions
  const privateKeyPath = path.resolve(process.cwd(), './dev-keys/gateway-private.pem');
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

  
  const user = await prisma.user.findFirst({ where: { status: 'ACTIVE' } });
  if (!user) {
    console.error('No active users found in database for testing.');
    process.exit(1);
  }

  const clientA = user.clientId;
  const userA = user.id;

  const signToken = (payload: any, options: jwt.SignOptions = {}) => {
    return jwt.sign(payload, privateKey, { algorithm: 'RS256', ...options });
  };

  const validGatewayPayload = {
    iss: 'scal_easy_gateway',
    aud: 'inventory',
    sub: userA,
    clientId: clientA,
  };

  const validGatewayToken = signToken(validGatewayPayload, { expiresIn: '60s', keyid: 'gateway-key-01' });

  // 1. Valid Gateway JWT -> Accepted
  await test('1. Valid Gateway JWT -> Accepted', async () => {
    const res = await axios.get(`${BASE_URL}/products`, {
      headers: { Authorization: `Bearer ${validGatewayToken}` },
      validateStatus: () => true
    });
    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`);
    }
  });

  // 2. Forged JWT (signed with different key) -> Rejected
  await test('2. Forged JWT -> Rejected', async () => {
    const fakeKey = jwt.sign(validGatewayPayload, 'wrong-secret'); // HS256 instead of RS256
    const res = await axios.get(`${BASE_URL}/products`, {
      headers: { Authorization: `Bearer ${fakeKey}` },
      validateStatus: () => true
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  // 3. Wrong Issuer -> Rejected
  await test('3. Wrong Issuer -> Rejected', async () => {
    const token = signToken({ ...validGatewayPayload, iss: 'hacker' }, { expiresIn: '60s' });
    const res = await axios.get(`${BASE_URL}/products`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  // 4. Wrong Audience -> Rejected
  await test('4. Wrong Audience -> Rejected', async () => {
    const token = signToken({ ...validGatewayPayload, aud: 'tryon' }, { expiresIn: '60s' });
    const res = await axios.get(`${BASE_URL}/products`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  // 5. Expired JWT -> Rejected
  await test('5. Expired JWT -> Rejected', async () => {
    const token = signToken(validGatewayPayload, { expiresIn: '-1s' });
    const res = await axios.get(`${BASE_URL}/products`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  // 6. Wrong clientId -> Rejected (Tenant mismatch or missing in DB)
  await test('6. Wrong clientId (Tenant Mismatch) -> Rejected', async () => {
    const token = signToken({ ...validGatewayPayload, clientId: 'cl_fake123' }, { expiresIn: '60s' });
    const res = await axios.get(`${BASE_URL}/products`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  // 7. Service JWT cannot be accepted as a Gateway assertion
  await test('7. Service JWT cannot be accepted as a Gateway assertion', async () => {
    const serviceToken = signToken({
      iss: 'scal_easy_inventory',
      aud: 'tryon',
      sub: 'inventory-service',
      clientId: clientA,
      onBehalfOf: { userId: userA },
      scope: ['tryon.read']
    }, { expiresIn: '60s' });

    const res = await axios.get(`${BASE_URL}/products`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
      validateStatus: () => true
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log(`\nTests Completed: ${passed} Passed, ${failed} Failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runGatewayTests();
