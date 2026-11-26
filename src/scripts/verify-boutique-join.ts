/**
 * Boutique clients no longer ask to join ScaleEzy Inventory (26 Nov 2026, the owner: a boutique's clients are the
 * Boutique app's own and run on ScaleEzy underneath; they never become ScaleEzy's Inventory clients). The ask
 * (POST /join-request) answers 410 in words, pointing at PUT /modules; reading (GET) and withdrawing (DELETE) an old
 * request still answer, so the Boutique app's screen does not break. The Console no longer lists requests.
 * The full ask/accept flow this suite tested until 26 Nov is in git history (verify-boutique-join.ts before 26 Nov).
 * Against the REAL local server; throwaway boutique accounts only (jointest-*). Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-join.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const A = `jointest-a-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
};
const pass = (tenant: string) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'sa-1', name: 'CRM-B super admin', can: ['products:write', 'settings:write'] } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function boutique(method: string, path: string, tenant: string, body?: unknown) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(tenant)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `join-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, code: r.data?.code, message: r.data?.message as string | undefined };
}

async function main() {
  const before = await prisma.boutiqueJoinRequest.count();
  const ask = await boutique('POST', '/join-request', A, { shopName: 'Jyothi Boutique', ownerName: 'Jyothi', ownerEmail: `jyothi-${S}@example.invalid`, ownerPhone: '9848012345', city: 'Guntur' });
  check('asking to join: 410 in words, pointing at PUT /modules', ask.status === 410 && ask.code === 'USE_MODULES' && /PUT \/modules/.test(ask.message ?? ''), ask);
  check('...and nothing is made (no request, no client)', (await prisma.boutiqueJoinRequest.count()) === before && !(await prisma.boutiqueLink.findUnique({ where: { tenant: A } })));
  const st = await boutique('GET', '/join-request', A);
  check('reading still answers (the Boutique app\'s screen does not break): NONE', st.status === 200 && st.data?.status === 'NONE', st);
  check('withdrawing when nothing is waiting: 404 in words, not a crash', (await boutique('DELETE', '/join-request', A)).status === 404);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
