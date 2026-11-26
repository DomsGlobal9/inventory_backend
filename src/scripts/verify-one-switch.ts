/**
 * One-switch onboarding (26 Nov 2026, PLAN-onboarding-modules.md), end to end against the REAL local services:
 * Inventory 4036 (the joint-test setup: POS_API_URL → POS 4007, CRM_SERVICE_URL → CRM 4008), POS and CRM with their
 * new doors. Four new clients from nothing, as the plan says:
 *   (a) every module   (b) CRM only   (c) POS + CRM without Inventory   (d) a boutique added through the Boutique door
 * each told, connected (the modules answer), shown in the checklist; then switched off and on again, and the refusals.
 * Owner emails go to @example.invalid addresses (nobody). Local only. Clients made here are switched off at POS and
 * CRM and removed from Inventory at the end.
 *   (the 4036 runner's env, BOUTIQUE_KEY_DIR) npx tsx src/scripts/verify-one-switch.ts
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const S = Date.now().toString(36);
// For the key doctor checked in this process: the same POS and key as the 4036 joint-test setup.
process.env.POS_API_URL = process.env.POS_API_URL || 'http://localhost:4007/api/v1';
process.env.INVENTORY_KEY_ID = process.env.INVENTORY_KEY_ID || 'inv-local-dev';
process.env.INVENTORY_PRIVATE_KEY_PATH = process.env.INVENTORY_PRIVATE_KEY_PATH || 'dev-keys/inventory-private.pem';
const CONSOLE = execSync('npx tsx src/scripts/print-local-console-token.ts', { env: process.env, encoding: 'utf8' }).match(/eyJ[A-Za-z0-9._-]+/)![0];
const btqKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');
let bad = 0, good = 0;
const made: string[] = [];
const check = (n: string, ok: boolean, d: unknown = '') => { ok ? good++ : bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : ' :: ' + JSON.stringify(d)?.slice(0, 700)}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const con = async (method: string, p: string, body?: unknown) => {
  const r = await axios.request({ method, url: `${BASE}/admin${p}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Cookie: `platform_admin_token=${CONSOLE}`, Origin: 'http://localhost:5183', 'Content-Type': 'application/json' } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
};
const ownerToken = async (clientId: string) => {
  const u = await prisma.user.findFirstOrThrow({ where: { clientId, roles: { some: { role: { name: 'SUPER_ADMIN' } } } } });
  return AuthService.generateToken({ userId: u.id, clientId, sessionVersion: (u as any).sessionVersion } as any);
};
const asOwner = async (token: string, method: string, p: string) => {
  const r = await axios.request({ method, url: `${BASE}${p}`, validateStatus: () => true, timeout: 60_000, headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost:5183' } });
  return { status: r.status, data: r.data?.data ?? r.data, reason: r.data?.reason };
};
const btq = async (tenant: string, method: string, p: string, body?: unknown, can = ['settings:write', 'products:write']) => {
  const token = jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } }, btqKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 120_000, headers: { Authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'Idempotency-Key': `os-${S}-${Math.random()}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
};
/** Wait until each module has answered (or refused). */
async function answered(clientId: string, modules: string[], ms = 60_000) {
  const until = Date.now() + ms;
  let rows: any[] = [];
  while (Date.now() < until) {
    // The answer to the NEWEST change (an answer to an earlier version does not count).
    const v = (await prisma.platformClient.findUnique({ where: { clientId }, select: { version: true } }))?.version ?? 0;
    rows = await prisma.moduleConnect.findMany({ where: { clientId, module: { in: modules } } });
    if (rows.length === modules.length && rows.every(r => r.version >= v && ['DONE', 'REFUSED'].includes(r.status))) break;
    await sleep(700);
  }
  return Object.fromEntries(rows.map(r => [r.module, { status: r.status, action: r.action, version: r.version, error: r.lastError }]));
}
const newClient = async (tag: string, modules: string[]) => {
  const r = await con('POST', '/clients', { companyName: `OS ${tag} ${S}`, adminName: `Owner ${tag}`, adminEmail: `os-${tag.toLowerCase()}-${S}@example.invalid`, ownerPhone: '9848012345', modules });
  if (r.data?.clientId) made.push(r.data.clientId);
  return r;
};

async function main() {
  console.log('(a) EVERY MODULE');
  const a = await newClient('Every', ['inventory', 'pos', 'crm']);
  const A = a.data?.clientId as string;
  check('made in the Console with Inventory, POS and CRM; POS and CRM told', a.status === 201 && ['inventory', 'pos', 'crm'].every(m => a.data?.modules?.on?.includes(m)) && a.data?.modules?.told?.length === 2, a);
  const ta = await answered(A, ['pos', 'crm']);
  check('...POS answered (connected)', ta.pos?.status === 'DONE', ta.pos);
  check('...CRM answered (connected)', ta.crm?.status === 'DONE', ta.crm);
  const keyA = await prisma.storefrontConnection.findFirst({ where: { clientId: A, baseUrl: 'pos://counter', name: 'POS', status: 'ACTIVE' } as any });
  check('...the till key was made and handed to POS (POS used it)', !!keyA?.lastUsedAt, keyA);
  check('...Inventory\'s change feed to CRM is on (CRM and Inventory both on)', !!(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: A, module: 'crm' } } })));
  const ca = await con('GET', `/clients/${A}/connections`);
  const groupsA = Object.fromEntries((ca.data?.groups ?? []).map((g: any) => [g.module, g.lines]));
  check('checklist: the shop, Inventory, POS and CRM, each with lines', ca.status === 200 && ['shop', 'inventory', 'pos', 'crm'].every(m => groupsA[m]?.length), Object.keys(groupsA));
  check('...nobody is still being told', !(ca.data?.groups ?? []).some((g: any) => g.lines.some((l: any) => /-told$/.test(l.key))), ca.data?.groups);
  check('...POS speaks for itself (its own lines)', (groupsA.pos ?? []).some((l: any) => !['till-key', 'pos-said'].includes(l.key)), groupsA.pos);
  check('...CRM speaks for itself (its own lines)', (groupsA.crm ?? []).some((l: any) => l.key !== 'crm-said'), groupsA.crm);
  check('...the owner has not signed in yet: amber, naming the email', (groupsA.shop ?? []).some((l: any) => l.key === 'owner' && l.state === 'warn' && /example\.invalid/.test(l.says)), groupsA.shop);
  const tokA = await ownerToken(A);
  check('the owner\'s session lists inventory, pos and crm', JSON.stringify((await asOwner(tokA, 'GET', '/auth/session')).data?.modules) === JSON.stringify(['inventory', 'pos', 'crm']), (await asOwner(tokA, 'GET', '/auth/session')).data?.modules);
  check('...and Inventory\'s screens work for them', (await asOwner(tokA, 'GET', '/products')).status === 200);

  console.log('\n(a) SWITCHED OFF AND ON AGAIN');
  await prisma.moduleSubscription.update({ where: { clientId_module: { clientId: A, module: 'crm' } }, data: { moved: { notes: true } } });
  const v0 = (await prisma.platformClient.findUnique({ where: { clientId: A } }))!.version;
  const offCrm = await con('PUT', `/clients/${A}/modules`, { modules: { crm: false } });
  check('CRM off: recorded, version up, CRM told it is off', offCrm.status === 200 && !offCrm.data?.modules?.includes('crm') && offCrm.data?.version === v0 + 1 && offCrm.data?.changed?.off?.includes('crm'), offCrm);
  const tOff = await answered(A, ['crm']);
  check('...CRM answered the switch-off', tOff.crm?.status === 'DONE' && tOff.crm?.action === 'disconnect', tOff.crm);
  check('...Inventory\'s feed to CRM stopped', !(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: A, module: 'crm' } } })));
  check('...POS was told the new picture too (no CRM)', (await answered(A, ['pos'])).pos?.status === 'DONE');
  const onCrm = await con('PUT', `/clients/${A}/modules`, { modules: { crm: true } });
  check('CRM on again: told, connected', onCrm.status === 200 && (await answered(A, ['crm'])).crm?.status === 'DONE');
  const subBack = await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: A, module: 'crm' } } });
  check('...the feed is back with what CRM had taken over kept (nothing re-entered)', (subBack?.moved as any)?.notes === true, subBack?.moved);
  const offPos = await con('PUT', `/clients/${A}/modules`, { modules: { pos: false } });
  check('POS off: POS told it is off, and answered', offPos.status === 200 && (await answered(A, ['pos'])).pos?.action === 'disconnect' && (await answered(A, ['pos'])).pos?.status === 'DONE');
  const doctor = await import('../services/pos-switch/doctor');
  const dr = await doctor.checkShop(A);
  check('...the key doctor leaves a client with POS off alone', dr.action === 'skipped' && /switched off/.test((dr as any).why), dr);
  const onPos = await con('PUT', `/clients/${A}/modules`, { modules: { pos: true } });
  const tOn = await answered(A, ['pos']);
  check('POS on again: connected (with a till key POS uses)', onPos.status === 200 && tOn.pos?.status === 'DONE', tOn.pos);
  const same = await con('PUT', `/clients/${A}/modules`, { modules: { pos: true } });
  check('asking for what is already so: nothing changes, nobody told, version the same', same.data?.told?.length === 0 && same.data?.version === onPos.data?.version, same.data);
  const lg = await con('PUT', `/clients/${A}/modules`, { modules: { logistics: true } });
  check('Logistics on: its feed is switched on', lg.status === 200 && !!(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: A, module: 'logistics' } } })));
  const invOff = await con('PUT', `/clients/${A}/modules`, { modules: { inventory: false } });
  check('Inventory off: Logistics goes off with it, CRM\'s feed stops', invOff.status === 200 && !invOff.data?.modules?.includes('logistics') && !(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: A, module: 'crm' } } })), invOff.data?.modules);
  check('...POS told the picture without Inventory: answered, and Inventory\'s till keys retired', (await answered(A, ['pos'])).pos?.status === 'DONE' && !(await prisma.storefrontConnection.count({ where: { clientId: A, baseUrl: 'pos://counter', status: 'ACTIVE' } as any })));
  const blocked = await asOwner(tokA, 'GET', '/products');
  check('...the owner\'s Inventory screens answer 409 no_inventory', blocked.status === 409 && blocked.reason === 'no_inventory', blocked);
  check('...but Team members stays open', (await asOwner(tokA, 'GET', '/team')).status !== 409);
  check('...and signing in still works (session without inventory)', !(await asOwner(tokA, 'GET', '/auth/session')).data?.modules?.includes('inventory'));
  const invOn = await con('PUT', `/clients/${A}/modules`, { modules: { inventory: true } });
  const tInv = await answered(A, ['pos', 'crm']);
  check('Inventory on again: POS reconnects with a fresh till key, CRM\'s feed is back', invOn.status === 200 && tInv.pos?.status === 'DONE' && !!(await prisma.storefrontConnection.findFirst({ where: { clientId: A, baseUrl: 'pos://counter', name: 'POS', status: 'ACTIVE' } as any })) && !!(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: A, module: 'crm' } } })), tInv);
  check('...and the owner\'s Inventory screens are back', (await asOwner(tokA, 'GET', '/products')).status === 200);

  console.log('\n(b) CRM ONLY');
  const b = await newClient('Crm', ['crm']);
  const B = b.data?.clientId as string;
  check('made with CRM only; CRM told', b.status === 201 && JSON.stringify(b.data?.modules?.on) === JSON.stringify(['crm']), b);
  check('...CRM connected', (await answered(B, ['crm'])).crm?.status === 'DONE');
  check('...no Inventory feed to CRM (Inventory is off)', !(await prisma.moduleSubscription.findUnique({ where: { clientId_module: { clientId: B, module: 'crm' } } })));
  const tokB = await ownerToken(B);
  check('...the owner signs in (session lists crm only)', JSON.stringify((await asOwner(tokB, 'GET', '/auth/session')).data?.modules) === JSON.stringify(['crm']));
  check('...Inventory\'s screens answer 409 no_inventory', (await asOwner(tokB, 'GET', '/products')).reason === 'no_inventory');
  const { moduleInventoryGate } = await import('../services/client-modules/gate');
  const gateSays = async (method: string, path: string) => new Promise<number>(resolve => {
    void moduleInventoryGate({ method, path } as any, { status: (s: number) => ({ json: () => resolve(s) }) } as any, () => resolve(0));
  });
  check('...CRM\'s Inventory-backed calls are refused (409) for it', await gateSays('GET', `/crm/shops/${B}/past-purchases`) === 409 && await gateSays('PUT', `/crm/shops/${B}`) === 409);
  check('...the module switch list is not', await gateSays('GET', '/crm/shops') === 0 && await gateSays('GET', `/crm/shops/${A}/past-purchases`) === 0);
  const lgB = await con('PUT', `/clients/${B}/modules`, { modules: { logistics: true } });
  check('Logistics without Inventory: refused in words', lgB.status === 409 && /Inventory/.test(lgB.message ?? ''), lgB);
  const cb = await con('GET', `/clients/${B}/connections`);
  check('checklist: the shop and CRM only', JSON.stringify((cb.data?.groups ?? []).map((g: any) => g.module)) === JSON.stringify(['shop', 'crm']), cb.data?.groups?.map((g: any) => g.module));

  console.log('\n(c) POS + CRM, NO INVENTORY');
  const c = await newClient('PosCrm', ['pos', 'crm']);
  const C = c.data?.clientId as string;
  const tc = await answered(C, ['pos', 'crm']);
  check('made with POS and CRM; both connected', c.status === 201 && tc.pos?.status === 'DONE' && tc.crm?.status === 'DONE', tc);
  check('...no till key at Inventory (POS runs without it)', !(await prisma.storefrontConnection.count({ where: { clientId: C, baseUrl: 'pos://counter', status: 'ACTIVE' } as any })));
  const cc = await con('GET', `/clients/${C}/connections`);
  check('...checklist: POS and CRM say how they are connected', ['pos', 'crm'].every(m => (cc.data?.groups ?? []).find((g: any) => g.module === m)?.lines?.length), cc.data?.groups);

  console.log('\n(d) A BOUTIQUE ADDED THROUGH THE BOUTIQUE DOOR');
  const TEN = `os-btq-${S}`;
  const noOwner = await btq(TEN, 'POST', '/link', { shopName: 'OS Boutique', modules: ['pos'] }, ['products:write']);
  check('asking for POS without settings:write: 403', noOwner.status === 403, noOwner);
  const d = await btq(TEN, 'POST', '/link', { shopName: 'OS Boutique', modules: ['pos', 'crm'], owner: { name: 'Lakshmi', phone: '9848012345' } });
  const D = d.data?.clientId as string;
  if (D) made.push(D);
  check('linked with POS and CRM: Boutique on, Inventory off, POS and CRM told', d.status === 201 && ['boutique', 'pos', 'crm'].every(m => d.data?.modules?.includes(m)) && !d.data?.modules?.includes('inventory') && d.data?.told?.length === 2, d);
  const td = await answered(D, ['pos', 'crm']);
  check('...POS and CRM connected (the owner it named)', td.pos?.status === 'DONE' && td.crm?.status === 'DONE', td);
  const vd = await btq(TEN, 'GET', '/modules');
  check('...the Boutique app reads its checklist', vd.status === 200 && (vd.data?.groups ?? []).some((g: any) => g.module === 'boutique'), vd.data?.groups?.map((g: any) => g.module));
  check('...it may not switch Inventory or Logistics (ScaleEzy\'s)', (await btq(TEN, 'PUT', '/modules', { modules: { inventory: true } })).status === 400);
  const dOff = await btq(TEN, 'PUT', '/modules', { modules: { crm: false } });
  check('...switches CRM off: told, answered', dOff.status === 200 && !dOff.data?.modules?.includes('crm') && (await answered(D, ['crm'])).crm?.action === 'disconnect');
  const again = await btq(TEN, 'POST', '/link', { shopName: 'OS Boutique' });
  check('...linking again changes nothing (already linked, Inventory stays off)', again.status === 200 && again.data?.linked === 'already' && !again.data?.modules?.includes('inventory'), again.data);

  console.log('\nREFUSALS');
  check('not a module: 400 naming the modules', (await con('PUT', `/clients/${A}/modules`, { modules: { shop: true } })).status === 400);
  check('not true/false: 400', (await con('PUT', `/clients/${A}/modules`, { modules: { pos: 'yes' } })).status === 400);
  check('Boutique on without its account: 400 in words', /account/i.test((await con('PUT', `/clients/${B}/modules`, { modules: { boutique: true } })).message ?? ''));
  check('"Try again" for a module that is off: 409', (await con('POST', `/clients/${B}/modules/pos/retry`)).status === 409);
  check('"Try again" for a module with no door: 400', (await con('POST', `/clients/${A}/modules/logistics/retry`)).status === 400);
  check('New client with no module: refused', (await con('POST', '/clients', { companyName: `OS None ${S}`, adminName: 'X', adminEmail: `os-none-${S}@example.invalid`, ownerPhone: '9848012345', modules: [] })).status === 400);
  check('New client with Logistics but no Inventory: refused', (await con('POST', '/clients', { companyName: `OS L ${S}`, adminName: 'X', adminEmail: `os-l-${S}@example.invalid`, ownerPhone: '9848012345', modules: ['logistics'] })).status === 400);
}

async function cleanup() {
  const cm = await import('../services/client-modules');
  const { runOnce } = await import('../services/client-modules/connect');
  for (const id of made) {
    // Switched off at POS and CRM first (their rows are theirs to keep, switched off).
    await cm.setModules(id, { modules: { pos: false, crm: false }, by: { userId: 'verify', name: 'verify' }, source: 'console', quiet: true }).catch(() => undefined);
  }
  await sleep(1500); await runOnce().catch(() => undefined); await sleep(3000);
  if (!made.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE client_id = ANY($1))`, made).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE client_id = ANY($1))`, made).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, made).catch(() => undefined);
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, made); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${made.length} clients here (switched off at POS and CRM): ${made.join(', ')}`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
