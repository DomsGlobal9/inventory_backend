/**
 * Image upload tenancy.
 *
 * The storage path used to be built in the browser and written straight to Supabase with
 * the anon key, so the tenant boundary was whatever the client asserted. These checks pin
 * the replacement: the server derives the path from the session, signs an upload for that
 * exact path, and refuses to register anything outside the caller's own prefix.
 */
import axios, { AxiosInstance } from 'axios';
import * as dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
dotenv.config();

const prisma = new PrismaClient();
const BASE = 'http://localhost:4006/api/v1';
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_v1';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  [PASS] ${name}`); passed++; }
  catch (e: any) {
    const d = e.response?.data ? JSON.stringify(e.response.data).slice(0, 220) : e.message;
    console.log(`  [FAIL] ${name}\n         -> ${d}`); failed++;
  }
}
function assert(c: boolean, m = 'assertion failed') { if (!c) throw new Error(m); }
function unwrap(r: any) { return r.data?.data !== undefined ? r.data.data : r.data; }

async function run() {
  console.log('\n=== IMAGE UPLOAD TENANCY ===\n');

  const user = await prisma.user.findFirst({
    where: { status: 'ACTIVE', clientId: 'demo-client', email: 'admin@example.com' }
  });
  if (!user) { console.error('no demo-client admin'); process.exit(1); }
  const clientId = user.clientId;
  const token = jwt.sign(
    { sub: user.id, clientId, iss: 'scal_easy_auth', aud: 'scal_easy_inventory' },
    JWT_SECRET, { expiresIn: '1h' }
  );
  const api: AxiosInstance = axios.create({
    baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true
  });

  const product = await prisma.product.findFirst({ where: { clientId }, select: { id: true } });
  if (!product) { console.error('no product for demo-client'); process.exit(1); }
  const productId = product.id;

  let issuedPath = '';

  await test('server issues a signed upload URL scoped to the caller\'s own tenant', async () => {
    const r = await api.post(`/products/${productId}/images/upload-url`, { fileName: 'photo.jpg' });
    assert(r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    const d = unwrap(r);
    issuedPath = d.storagePath;
    assert(!!d.token, 'no upload token returned');
    assert(!!d.signedUrl, 'no signed URL returned');
    assert(issuedPath.startsWith(`${clientId}/${productId}/`),
      `path "${issuedPath}" is not inside this tenant's prefix`);
  });

  await test('a traversing filename cannot escape the tenant prefix', async () => {
    const r = await api.post(`/products/${productId}/images/upload-url`, {
      fileName: '../../../../etc/passwd'
    });
    assert(r.status === 201, `got ${r.status}`);
    const p = unwrap(r).storagePath as string;
    assert(p.startsWith(`${clientId}/${productId}/`), `escaped the prefix: ${p}`);
    assert(!p.includes('..'), `path still contains traversal: ${p}`);
  });

  await test('the tenant cannot be overridden from the request body', async () => {
    const r = await api.post(`/products/${productId}/images/upload-url`, {
      fileName: 'photo.jpg', clientId: 'some-other-boutique'
    });
    assert(r.status === 201, `got ${r.status}`);
    const p = unwrap(r).storagePath as string;
    assert(p.startsWith(`${clientId}/`), `body overrode the tenant: ${p}`);
  });

  await test('cannot request an upload URL for another tenant\'s product', async () => {
    const foreign = await prisma.product.findFirst({
      where: { clientId: { not: clientId } }, select: { id: true }
    });
    if (!foreign) { console.log('     (no other-tenant product)'); return; }
    const r = await api.post(`/products/${foreign.id}/images/upload-url`, { fileName: 'x.jpg' });
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('registering an image with a foreign storagePath is rejected', async () => {
    const r = await api.post(`/products/${productId}/images`, {
      url: 'https://example.com/x.jpg',
      storagePath: `some-other-boutique/${productId}/stolen.jpg`,
      fileName: 'stolen.jpg', fileSize: 10, isPrimary: false
    });
    assert(r.status === 400, `expected 400, got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });

  await test('registering an image with the server-issued path is accepted', async () => {
    const r = await api.post(`/products/${productId}/images`, {
      url: 'https://example.com/ok.jpg',
      storagePath: issuedPath,
      fileName: 'ok.jpg', fileSize: 10, isPrimary: false
    });
    assert(r.status === 201, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    // clean up the row we just made
    const created = unwrap(r);
    if (created?.id) await prisma.productImage.delete({ where: { id: created.id } }).catch(() => {});
  });

  await test('an unauthenticated caller gets no upload URL', async () => {
    const r = await axios.post(`${BASE}/products/${productId}/images/upload-url`,
      { fileName: 'x.jpg' }, { validateStatus: () => true });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
