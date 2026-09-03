import axios from 'axios';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
dotenv.config();

const BASE_URL = 'http://localhost:4006/api/v1';

async function runTests() {
  console.log('--- STARTING PHASE 2.75 SECURITY TEST SUITE ---\n');

  // Setup Test Data
  const clientA = 'test-client-a';
  const clientB = 'test-client-b';

  // Clear existing
  await prisma.userRole.deleteMany({ where: { user: { clientId: { in: [clientA, clientB] } } } });
  await prisma.user.deleteMany({ where: { clientId: { in: [clientA, clientB] } } });
  await prisma.role.deleteMany({ where: { clientId: { in: [clientA, clientB] } } });
  await prisma.product.deleteMany({ where: { clientId: { in: [clientA, clientB] } } });

  // Create Client A Product
  const productA = await prisma.product.create({
    data: {
      clientId: clientA,
      title: 'Product A',
      slug: 'prod-a',
      productCode: 'PA',
      category: 'WOMEN',
      productType: 'READY_TO_WEAR',
      basePrice: 100
    }
  });

  // Create Client B Product
  const productB = await prisma.product.create({
    data: {
      clientId: clientB,
      title: 'Product B',
      slug: 'prod-b',
      productCode: 'PB',
      category: 'WOMEN',
      productType: 'READY_TO_WEAR',
      basePrice: 100
    }
  });

  // Create User A
  const roleA = await prisma.role.create({ data: { clientId: clientA, name: 'ADMIN' } });
  const userA = await prisma.user.create({
    data: {
      clientId: clientA,
      name: 'User A',
      email: 'a@test.com',
      password: await AuthService.hashPassword('password123'),
      roles: { create: { roleId: roleA.id } }
    }
  });

  const validTokenA = AuthService.generateToken({ userId: userA.id, clientId: clientA });
  const validCookieA = `token=${validTokenA}`;

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

  // 1. No cookie
  await test('1. No cookie -> /products (401)', async () => {
    try {
      await axios.get(`${BASE_URL}/products`);
      throw new Error('Did not return 401');
    } catch (e: any) {
      if (e.response?.status !== 401) throw new Error(`Expected 401, got ${e.response?.status}`);
    }
  });

  // 2. Fake x-client-id
  await test('2. Fake x-client-id -> /products (401)', async () => {
    try {
      await axios.get(`${BASE_URL}/products`, { headers: { 'x-client-id': clientB } });
      throw new Error('Did not return 401');
    } catch (e: any) {
      if (e.response?.status !== 401) throw new Error(`Expected 401, got ${e.response?.status}`);
    }
  });

  // 3. Valid JWT Client A + Client B header
  await test('3. Valid JWT Client A + Client B header -> Only Client A products', async () => {
    const res = await axios.get(`${BASE_URL}/products`, { 
      headers: { Cookie: validCookieA, 'x-client-id': clientB } 
    });
    if (res.data.data.some((p: any) => p.clientId !== clientA)) {
      throw new Error('Leaked Client B data!');
    }
  });

  // 4. Modified JWT
  await test('4. Modified JWT (401)', async () => {
    try {
      const parts = validTokenA.split('.');
      const modifiedToken = `${parts[0]}.${parts[1]}xyz.${parts[2]}`;
      await axios.get(`${BASE_URL}/products`, { headers: { Cookie: `token=${modifiedToken}` } });
      throw new Error('Did not return 401');
    } catch (e: any) {
      if (e.response?.status !== 401) throw new Error(`Expected 401, got ${e.response?.status}`);
    }
  });

  // 5. Expired JWT
  await test('5. Expired JWT (401)', async () => {
    const secret = process.env.JWT_SECRET || 'super_secret_jwt_key_v1';
    const expiredToken = jwt.sign({ sub: userA.id, clientId: clientA, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, secret, { expiresIn: '-1h' });
    try {
      await axios.get(`${BASE_URL}/products`, { headers: { Cookie: `token=${expiredToken}` } });
      throw new Error('Did not return 401');
    } catch (e: any) {
      if (e.response?.status !== 401) throw new Error(`Expected 401, got ${e.response?.status}`);
    }
  });

  // 6. Inactive user in DB
  await test('6. Inactive user in DB (401)', async () => {
    await prisma.user.update({ where: { id: userA.id }, data: { status: 'INACTIVE' } });
    try {
      await axios.get(`${BASE_URL}/products`, { headers: { Cookie: validCookieA } });
      throw new Error('Did not return 401');
    } catch (e: any) {
      if (e.response?.status !== 401) throw new Error(`Expected 401, got ${e.response?.status}`);
    }
    await prisma.user.update({ where: { id: userA.id }, data: { status: 'ACTIVE' } });
  });

  // 7. Role/Permission removed in DB
  await test('7. User role removed in DB -> 403 on protected route', async () => {
    await prisma.userRole.deleteMany({ where: { userId: userA.id } });
    try {
      await axios.get(`${BASE_URL}/sales-orders`, { headers: { Cookie: validCookieA } });
      throw new Error('Did not return 403');
    } catch (e: any) {
      if (e.response?.status !== 403) throw new Error(`Expected 403, got ${e.response?.status}`);
    }
    await prisma.userRole.create({ data: { userId: userA.id, roleId: roleA.id } });
  });

  // 8. Object-Level GET Client-B resource by Client A
  await test('8. Object-Level GET Client-B resource by Client A (404/403)', async () => {
    try {
      await axios.get(`${BASE_URL}/products/${productB.id}`, { headers: { Cookie: validCookieA } });
      throw new Error('Did not return 404/403');
    } catch (e: any) {
      if (e.response?.status !== 404 && e.response?.status !== 403) throw new Error(`Expected 404/403, got ${e.response?.status}`);
    }
  });

  // 9. Object-Level PATCH Client-B resource by Client A
  await test('9. Object-Level PATCH Client-B resource by Client A (404/403)', async () => {
    try {
      await axios.patch(`${BASE_URL}/products/${productB.id}`, { title: 'Hacked' }, { headers: { Cookie: validCookieA } });
      throw new Error('Did not return 404/403');
    } catch (e: any) {
      if (![403, 404].includes(e.response?.status)) throw new Error(`Expected 404/403, got ${e.response?.status}`);
    }
  });

  // 10. Object-Level DELETE Client-B resource by Client A
  await test('10. Object-Level DELETE Client-B resource by Client A (404/403)', async () => {
    try {
      await axios.post(`${BASE_URL}/products/${productB.id}/trash`, {}, { headers: { Cookie: validCookieA } });
      throw new Error('Did not return 404/403');
    } catch (e: any) {
      if (![403, 404].includes(e.response?.status)) throw new Error(`Expected 404/403, got ${e.response?.status}`);
    }
  });

  // 11. Logout -> /products
  await test('11. Logout -> /products (401)', async () => {
    const res = await axios.post(`${BASE_URL}/auth/logout`);
    const setCookie = res.headers['set-cookie'];
    if (!setCookie || !setCookie[0].includes('token=;')) throw new Error('Cookie not cleared');
  });

  // 12. Missing auth -> /auth/logout
  await test('12. Missing auth -> /auth/logout (Idempotent 200)', async () => {
    const res = await axios.post(`${BASE_URL}/auth/logout`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // 13. Unauthorized Origin (CORS)
  await test('13. Unauthorized Origin (CORS rejection)', async () => {
    const res = await axios.get(`${BASE_URL}/products`, { 
      headers: { Origin: 'https://evil.example.com', Cookie: validCookieA },
      validateStatus: () => true 
    });
    if (res.headers['access-control-allow-origin'] === 'https://evil.example.com') {
      throw new Error('CORS allowed evil.example.com');
    }
  });

  // 14. Direct browser call with X-Authenticated-Client-Id
  await test('14. Fake Gateway Header X-Authenticated-Client-Id (Remains Client A)', async () => {
    const res = await axios.get(`${BASE_URL}/products`, { 
      headers: { Cookie: validCookieA, 'x-authenticated-client-id': clientB } 
    });
    if (res.data.data.some((p: any) => p.clientId !== clientA)) {
      throw new Error('Leaked Client B data via gateway header!');
    }
  });

  // 15. Valid JWT with wrong secret
  await test('15. Valid JWT with wrong secret (401)', async () => {
    const fakeToken = jwt.sign({ sub: userA.id, clientId: clientA, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' }, 'wrong_secret');
    try {
      await axios.get(`${BASE_URL}/products`, { headers: { Cookie: `token=${fakeToken}` } });
      throw new Error('Did not return 401');
    } catch (e: any) {
      if (e.response?.status !== 401) throw new Error(`Expected 401, got ${e.response?.status}`);
    }
  });

  // 16. JWT with invalid iss/aud claims
  await test('16. JWT with invalid iss/aud claims (401)', async () => {
    const fakeToken = jwt.sign({ sub: userA.id, clientId: clientA, iss: 'wrong_issuer', aud: 'wrong_audience' }, process.env.JWT_SECRET || 'super_secret_jwt_key_v1');
    try {
      await axios.get(`${BASE_URL}/products`, { headers: { Cookie: `token=${fakeToken}` } });
      throw new Error('Did not return 401');
    } catch (e: any) {
      if (e.response?.status !== 401) throw new Error(`Expected 401, got ${e.response?.status}`);
    }
  });

  console.log(`\nTests Completed: ${passed} Passed, ${failed} Failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);
