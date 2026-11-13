/**
 * Store setup and onboarding, worst cases, against the REAL local server (PLAN-onboarding-setup.md): the Console's
 * onboarding answers, /api/v1/setup, the switching rule, races, the boutique connection code, who may do what.
 * Throwaway clients only, erased at the end. Local database and server only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-shop-setup.ts
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const APP = 'http://localhost:5183';
const S = Date.now().toString(36);
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => { ok ? good++ : bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`); };
const made: string[] = [];
let consoleCookie = '';

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Origin: APP, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  return { status: r.status, data: j.data, message: j.message as string | undefined, headers: r.headers };
}
const asConsole = (m: string, p: string, b?: unknown) => http(m, p, b, { Cookie: consoleCookie });
const asUser = (token: string) => (m: string, p: string, b?: unknown) => http(m, p, b, { Authorization: `Bearer ${token}` });
const form = (n: string, extra: Record<string, unknown> = {}) => ({ companyName: `WC ${n} ${S}`, adminName: `Owner ${n}`, adminEmail: `wc-${n.toLowerCase()}-${S}@example.invalid`, ownerPhone: '9848012345', ...extra });
async function onboard(n: string, extra: Record<string, unknown> = {}) {
  const r = await asConsole('POST', '/admin/clients', form(n, extra));
  if (r.data?.clientId) made.push(r.data.clientId);
  return r;
}
async function login(email: string, password: string) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP }, body: JSON.stringify({ email, password }) });
  const c = (r.headers as any).getSetCookie?.().find((x: string) => x.startsWith('token='));
  return c ? c.split(';')[0].slice(6) : '';
}

async function main() {
  const admin = await prisma.platformAdmin.findFirst({ where: { status: 'ACTIVE' }, select: { id: true, sessionVersion: true } });
  if (!admin) throw new Error('no platform admin locally');
  consoleCookie = `platform_admin_token=${AuthService.generatePlatformAdminToken({ platformAdminId: admin.id, sessionVersion: admin.sessionVersion })}`;

  console.log('ONBOARDING: WHAT IT SELLS, ITS BOUTIQUE');
  check('the Console refuses anyone without its session', (await http('POST', '/admin/clients', form('N'))).status === 401);
  const blank = await onboard('Blank', { sells: '' });
  check('"" (owner decides) is stored as not chosen', blank.status === 201 && blank.data?.sells === null, blank);
  for (const v of ['ready_made', 'SHOES', 7, { x: 1 }]) {
    const r = await asConsole('POST', '/admin/clients', form('Bad', { sells: v }));
    check(`a "what it sells" of ${JSON.stringify(v)} is refused in words`, r.status === 400 && /select|Choose/.test(r.message ?? ''), r);
  }
  for (const t of ['Has Space', 'x', 'a'.repeat(70), '-starts-dash', 'ünïcode']) {
    const r = await asConsole('POST', '/admin/clients', form('BadT', { boutiqueTenant: t }));
    check(`a boutique account "${t.slice(0, 12)}${t.length > 12 ? '…' : ''}" is refused`, r.status === 400, r);
  }
  const caseT = `WC-Case-${S}`;
  const cased = await onboard('Case', { sells: 'BOTH', boutiqueTenant: caseT });
  const link = await prisma.boutiqueLink.findFirst({ where: { clientId: cased.data?.clientId } });
  check('a boutique account in capitals is kept lower-case and linked', cased.status === 201 && link?.tenant === caseT.toLowerCase(), { s: cased.status, t: link?.tenant });
  const dupe = await asConsole('POST', '/admin/clients', form('Dupe', { boutiqueTenant: caseT.toUpperCase() }));
  check('the same boutique account again (any case) is refused, nothing created', dupe.status === 409 && !(await prisma.user.findFirst({ where: { email: form('Dupe').adminEmail } })), dupe);
  const race = await Promise.all([1, 2].map(i => asConsole('POST', '/admin/clients', form(`Race${i}`, { boutiqueTenant: `wc-race-${S}` }))));
  race.forEach(r => r.data?.clientId && made.push(r.data.clientId));
  const raceLinks = await prisma.boutiqueLink.count({ where: { tenant: `wc-race-${S}`, unlinkedAt: null } });
  check('two clients onboarded at the same moment with the same boutique: it ends up linked to one shop only', raceLinks === 1, { statuses: race.map(r => r.status), raceLinks });

  console.log('\nSTORE SETUP API');
  const A = await onboard('A', { sells: 'BOTH' });
  const ownerA = asUser(await login(form('A').adminEmail, A.data.tempPassword));
  check('anyone signed out is refused', (await http('GET', '/setup')).status === 401);
  const g = await ownerA('GET', '/setup');
  check('a new owner: not done, sells BOTH from onboarding, pending lists what is missing', g.status === 200 && g.data?.setupDone === false && g.data?.sells === 'BOTH' && g.data?.missing?.includes('address'), g.data);
  check('finishing before anything is chosen works when the Console chose (BOTH)', (await ownerA('PUT', '/setup', { finish: true })).data?.setupDone === true);
  for (const v of ['both', '', null, 123, ['BOTH']]) {
    const r = await ownerA('PUT', '/setup', { sells: v });
    check(`sells ${JSON.stringify(v)} is refused in words`, r.status === 400, r);
  }
  for (const c of [7, -25, 0, 'abc', 100000]) {
    const r = await ownerA('PUT', '/setup', { sells: 'BOTH', fabricMinCut: c });
    check(`a minimum cut of ${JSON.stringify(c)} is refused`, r.status === 400 || r.status === 409, r);
  }
  const unknownField = await ownerA('PUT', '/setup', { setupDoneAt: '2001-01-01', clientId: 'someone-else', sells: 'BOTH' });
  const st = await prisma.clientSettings.findUnique({ where: { clientId: A.data.clientId }, select: { setupDoneAt: true } });
  check('fields it does not take are ignored (cannot set another shop or a date)', unknownField.status === 200 && st?.setupDoneAt?.getFullYear() !== 2001, { st });

  console.log('\nTHE SWITCHING RULE');
  const p = await ownerA('POST', '/products', { title: `WC silk ${S}`, category: 'WOMEN', productType: 'UNSTITCHED', basePrice: 4.5, status: 'ACTIVE', soldBy: 'METRE', kind: 'FABRIC' });
  const toRM = await ownerA('PUT', '/setup', { sells: 'READY_MADE' });
  const after = await prisma.clientSettings.findUnique({ where: { clientId: A.data.clientId }, select: { sells: true, fabricsOn: true } });
  check('ready-made is refused while a fabric exists; nothing changes', toRM.status === 409 && after?.sells === 'BOTH' && after?.fabricsOn === true, { toRM, after });
  check('...the message says how many and what to do', /1 product is still sold by the metre/.test(toRM.message ?? '') && /Trash/.test(toRM.message ?? ''), toRM.message);
  await prisma.product.update({ where: { id: p.data.id }, data: { trashedAt: new Date(), status: 'TRASHED' as any } });
  const nowRM = await ownerA('PUT', '/setup', { sells: 'READY_MADE' });
  check('once the fabric is in Trash, ready-made is allowed and fabric switches off', nowRM.status === 200 && nowRM.data?.fabricsOn === false && nowRM.data?.sells === 'READY_MADE', nowRM);
  const flips = await Promise.all(['BOTH', 'READY_MADE', 'FABRICS', 'BOTH', 'READY_MADE'].map(v => ownerA('PUT', '/setup', { sells: v })));
  const fin = await prisma.clientSettings.findUnique({ where: { clientId: A.data.clientId }, select: { sells: true, fabricsOn: true } });
  check('five changes at the same moment: what it sells and fabric on/off still agree', flips.every(r => r.status === 200) && ((fin?.sells === 'READY_MADE') === (fin?.fabricsOn === false)), { fin, statuses: flips.map(r => r.status) });

  console.log('\nWHO MAY DO WHAT');
  const staffEmail = `wc-staff-${S}@example.invalid`;
  // A staff member with no owner rights (no roles at all: the least anyone signed in can hold).
  const team = null;
  const staffUser = await prisma.user.create({ data: { clientId: A.data.clientId, name: 'Shop Staff', email: staffEmail, password: await AuthService.hashPassword(`x-${S}-Staff!9`), status: 'ACTIVE' } as any });
  if (staffUser) {
    const staffTok = AuthService.generateToken({ userId: staffUser.id, clientId: staffUser.clientId, sessionVersion: (staffUser as any).sessionVersion ?? 0 });
    const staff = asUser(staffTok);
    check('staff may read what the shop sells (screens shape themselves by it)', (await staff('GET', '/setup')).status === 200);
    check('...but not change it', (await staff('PUT', '/setup', { sells: 'BOTH' })).status === 403);
    check('...nor make a boutique connection code', (await staff('POST', '/boutique-link/code')).status === 403);
    check('...nor disconnect a boutique', (await staff('DELETE', '/boutique-link')).status === 403);
  } else check('a staff member could be added to test with', false, team);
  const B = await onboard('B', { sells: 'READY_MADE' });
  const ownerB = asUser(await login(form('B').adminEmail, B.data.tempPassword));
  const crossA = await ownerB('GET', '/setup');
  check('an owner only ever sees their own shop\'s setup', crossA.data?.sells === 'READY_MADE');

  console.log('\nBOUTIQUE CONNECTION CODES');
  const c1 = await ownerB('POST', '/boutique-link/code');
  const c2 = await ownerB('POST', '/boutique-link/code');
  check('a new code replaces the old one', c1.status === 200 && c2.status === 200 && c1.data?.code !== c2.data?.code);
  const codes = await prisma.boutiqueLinkCode.count({ where: { clientId: B.data.clientId, usedAt: null } });
  check('...only one unused code exists at a time', codes === 1, codes);
  const state0 = await ownerB('GET', '/boutique-link');
  check('not connected yet', state0.data?.linked === false);
  const dis = await ownerB('DELETE', '/boutique-link');
  check('disconnecting when nothing is connected is harmless', dis.status === 200 && dis.data?.linked === false);
  const linkedState = await asUser(await login(form('Case').adminEmail, cased.data.tempPassword))('GET', '/boutique-link');
  check('a shop linked at onboarding shows its boutique account', linkedState.data?.linked === true && linkedState.data?.tenant === caseT.toLowerCase(), linkedState.data);
}

async function cleanup() {
  if (!made.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, made).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE client_id = ANY($1))`, made).catch(() => undefined);
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, made); } catch { left++; } }
    if (!left) break;
  }
  await prisma.boutiqueLink.deleteMany({ where: { tenant: { startsWith: 'wc-' } } });
  console.log(`\nerased ${made.length} test clients (${await prisma.user.count({ where: { clientId: { in: made } } })} users left)`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
