/**
 * The Security log: sign-ins, passwords, roles and team changes, kept for 180 days while ordinary
 * activity is trimmed to the latest rows.
 *
 *   A  recorded through the real API: a sign-in, a wrong password, a switched-off account trying,
 *      an email nobody has (records nothing), a password viewed, the owner changing their own
 *      password, signing out other devices, a team member added (named, not "a team member").
 *   B  kept: a flood of ordinary activity trims the activity to the latest 30 and leaves every
 *      security row; a security row 179 days old stays, one 181 days old goes.
 *   C  shown: plain sentences with names, failed and refused attempts marked, pages that do not
 *      overlap, sign-ins kept out of Recent Activity, the retention period stated.
 *   D  guarded: a salesperson is refused; another shop's owner sees none of it.
 *
 * Two throwaway shops, removed at the end. Needs the backend running (high-limit config).
 *
 *   npx ts-node --transpile-only src/scripts/verify-security-log.ts
 */
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { seedRolesForClient } from '../services/rbac-seed.service';
import { encryptCredential } from '../lib/credentialEncryption';
import { platformAdminService } from '../services/platform-admin.service';
import { pruneAuditLogs, ACTIVITY_ROWS_KEPT, SECURITY_RETENTION_DAYS } from '../services/security-log';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1';
const STAMP = Date.now();
const SHOP = `verify-seclog-${STAMP}`;
const OTHER = `verify-seclog-other-${STAMP}`;
const DAY = 24 * 60 * 60 * 1000;

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function call(path: string, { method = 'GET', body, token }: { method?: string; body?: any; token?: string } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const cookie = r.headers.get('set-cookie') ?? '';
  const token2 = /token=([^;]+)/.exec(cookie)?.[1];
  let json: any = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json, token: token2 };
}

async function makePerson(clientId: string, roleId: string, name: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  const password = crypto.randomBytes(9).toString('base64url');
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${STAMP}@example.com`;
  const user = await prisma.user.create({
    data: { clientId, name, email, status, password: await AuthService.hashPassword(password), passwordEncrypted: encryptCredential(password) }
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId } });
  return { id: user.id, email, password, name };
}

/** The account events are written after the answer goes back; give them a moment. */
async function rowsFor(clientId: string, where: Record<string, any>, want = 1, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const n = await prisma.auditLog.count({ where: { clientId, ...where } });
    if (n >= want) return n;
    await wait(500);
  }
  return prisma.auditLog.count({ where: { clientId, ...where } });
}

async function main() {
  try {
    console.log('SETUP: a shop with an owner, a salesperson and a switched-off person; and a second shop');
    const roles = await seedRolesForClient(SHOP);
    const owner = await makePerson(SHOP, roles.SUPER_ADMIN, 'Lakshmi Owner');
    const sales = await makePerson(SHOP, roles.SALES, 'Anjali Sales');
    const gone = await makePerson(SHOP, roles.SALES, 'Ravi Former', 'INACTIVE');
    const otherRoles = await seedRolesForClient(OTHER);
    const otherOwner = await makePerson(OTHER, otherRoles.SUPER_ADMIN, 'Other Owner');

    console.log('\nA. RECORDED');
    const signIn = await call('/auth/login', { method: 'POST', body: { email: owner.email, password: owner.password, clientId: SHOP } });
    check('the owner signs in', signIn.status === 200 && !!signIn.token, `${signIn.status}`);
    let token = signIn.token!;
    check('a sign-in is recorded against the owner', await rowsFor(SHOP, { entityType: 'ACCOUNT', action: 'SIGNED_IN', entityId: owner.id, userId: owner.id }) === 1);

    const wrong = await call('/auth/login', { method: 'POST', body: { email: sales.email, password: 'not-it-at-all' } });
    check('a wrong password is still refused the same way', wrong.status === 401, `${wrong.status}`);
    check('and recorded as a failed sign-in against that account, with nobody as the actor',
      await rowsFor(SHOP, { entityType: 'ACCOUNT', action: 'SIGN_IN_FAILED', entityId: sales.id, userId: null }) === 1);

    const blocked = await call('/auth/login', { method: 'POST', body: { email: gone.email, password: gone.password } });
    check('a switched-off account is refused', blocked.status === 401, `${blocked.status}`);
    check('and recorded as a blocked sign-in', await rowsFor(SHOP, { entityType: 'ACCOUNT', action: 'SIGN_IN_BLOCKED', entityId: gone.id }) === 1);

    const before = await prisma.auditLog.count({ where: { entityType: 'ACCOUNT', createdAt: { gte: new Date(STAMP) } } });
    await call('/auth/login', { method: 'POST', body: { email: `nobody.${STAMP}@example.com`, password: 'x' } });
    await wait(2500);
    const after = await prisma.auditLog.count({ where: { entityType: 'ACCOUNT', createdAt: { gte: new Date(STAMP) } } });
    check('an email that belongs to nobody records nothing anywhere', after === before, `${before} -> ${after}`);

    const viewed = await call(`/team/members/${sales.id}/password/view`, { method: 'POST', body: { reason: 'she forgot it' }, token });
    check('the owner views the salesperson\'s password', viewed.status === 200, `${viewed.status} ${viewed.json?.message}`);

    const added = await call('/team/members', { method: 'POST', token, body: { name: 'Meena New', email: `meena.${STAMP}@example.com`, roleId: roles.SALES, customPassword: 'meena-pass-123' } });
    check('the owner adds a team member', added.status === 201, `${added.status} ${added.json?.message}`);

    const newPass = crypto.randomBytes(9).toString('base64url');
    const changed = await call('/auth/me/password', { method: 'POST', token, body: { currentPassword: owner.password, newPassword: newPass } });
    check('the owner changes their own password', changed.status === 200, `${changed.status} ${changed.json?.message}`);
    token = changed.token ?? token;
    check('which is recorded (the /auth routes run before the activity logger)',
      await rowsFor(SHOP, { entityType: 'ACCOUNT', action: 'PASSWORD_CHANGED', entityId: owner.id }) === 1);

    const out = await call('/auth/me/sign-out-other-devices', { method: 'POST', token });
    check('the owner signs out every other device', out.status === 200, `${out.status}`);
    token = out.token ?? token;
    check('which is recorded too', await rowsFor(SHOP, { entityType: 'ACCOUNT', action: 'SIGNED_OUT_OTHER_DEVICES', entityId: owner.id }) === 1);

    console.log('\nB. KEPT');
    // Forty ordinary changes, older than everything above, as a busy shop floor would make.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.auditLog.createMany({
      data: Array.from({ length: 40 }, (_, i) => ({
        clientId: SHOP, userId: owner.id, action: 'CREATED', entityType: 'PRODUCT', entityId: `p-${i}`,
        createdAt: new Date(old.getTime() + i * 1000)
      }))
    });
    // One security row just inside the retention period and one just outside it.
    await prisma.auditLog.create({ data: { clientId: SHOP, userId: owner.id, action: 'PASSWORD_VIEWED', entityType: 'USER_CREDENTIAL', entityId: sales.id, createdAt: new Date(Date.now() - (SECURITY_RETENTION_DAYS - 1) * DAY) } });
    await prisma.auditLog.create({ data: { clientId: SHOP, userId: owner.id, action: 'PASSWORD_VIEWED', entityType: 'USER_CREDENTIAL', entityId: gone.id, createdAt: new Date(Date.now() - (SECURITY_RETENTION_DAYS + 1) * DAY) } });
    // The other shop has more than 30 ordinary rows too; trimming this shop must leave them all.
    await prisma.auditLog.createMany({
      data: Array.from({ length: 35 }, (_, i) => ({ clientId: OTHER, action: 'CREATED', entityType: 'PRODUCT', entityId: `o-${i}` }))
    });
    const securityBefore = await prisma.auditLog.count({ where: { clientId: SHOP, entityType: { in: ['ACCOUNT', 'USER_CREDENTIAL', 'TEAM'] } } });

    await pruneAuditLogs(SHOP);

    const ordinary = await prisma.auditLog.count({ where: { clientId: SHOP, NOT: [{ entityType: { in: ['ACCOUNT', 'USER_CREDENTIAL', 'TEAM'] } }, { entityType: 'ROLE', action: { in: ['CREATED', 'UPDATED', 'DELETED'] } }] } });
    check(`ordinary activity is cut back to the latest ${ACTIVITY_ROWS_KEPT}`, ordinary === ACTIVITY_ROWS_KEPT, `${ordinary}`);
    const newestKept = await prisma.auditLog.count({ where: { clientId: SHOP, entityType: 'PRODUCT', entityId: 'p-39' } });
    const oldestGone = await prisma.auditLog.count({ where: { clientId: SHOP, entityType: 'PRODUCT', entityId: 'p-0' } });
    check('the newest ordinary rows are the ones kept', newestKept === 1 && oldestGone === 0);
    const securityAfter = await prisma.auditLog.count({ where: { clientId: SHOP, entityType: { in: ['ACCOUNT', 'USER_CREDENTIAL', 'TEAM'] } } });
    check('every security row inside the period survives the flood (only the too-old one goes)', securityAfter === securityBefore - 1, `${securityBefore} -> ${securityAfter}`);
    check(`a security row ${SECURITY_RETENTION_DAYS - 1} days old stays`, await prisma.auditLog.count({ where: { clientId: SHOP, entityType: 'USER_CREDENTIAL', entityId: sales.id, createdAt: { lt: new Date(Date.now() - 100 * DAY) } } }) === 1);
    check(`a security row ${SECURITY_RETENTION_DAYS + 1} days old is removed`, await prisma.auditLog.count({ where: { clientId: SHOP, entityType: 'USER_CREDENTIAL', entityId: gone.id } }) === 0);
    check('the other shop\'s 35 rows are untouched by this shop\'s trim', await prisma.auditLog.count({ where: { clientId: OTHER, entityType: 'PRODUCT' } }) === 35);

    console.log('\nC. SHOWN');
    const log = await call('/team/security-log?limit=200', { token });
    check('the owner opens the security log', log.status === 200, `${log.status} ${log.json?.message}`);
    const entries: any[] = log.json?.data?.entries ?? [];
    const sentences = entries.map(e => e.sentence);
    const has = (s: string) => sentences.includes(s);
    check('it says how long rows are kept', log.json?.data?.keptForDays === SECURITY_RETENTION_DAYS);
    check('"Lakshmi Owner signed in"', has('Lakshmi Owner signed in'), sentences.join(' | '));
    check('"Someone tried to sign in as Anjali Sales with a wrong password", marked', entries.some(e => e.sentence === 'Someone tried to sign in as Anjali Sales with a wrong password' && e.warning));
    check('"Someone tried to sign in as Ravi Former, whose account is switched off", marked', entries.some(e => e.sentence === 'Someone tried to sign in as Ravi Former, whose account is switched off' && e.warning));
    check('"Lakshmi Owner viewed Anjali Sales\'s password"', has("Lakshmi Owner viewed Anjali Sales's password"));
    check('"Lakshmi Owner added Meena New to the team" names the new person', has('Lakshmi Owner added Meena New to the team'), sentences.filter(s => /added/.test(s)).join(' | '));
    check('"Lakshmi Owner changed their own password"', has('Lakshmi Owner changed their own password'));
    check('"Lakshmi Owner signed out of every other device"', has('Lakshmi Owner signed out of every other device'));
    check('ordinary product changes are not in it', !sentences.some(s => /product/i.test(s)));
    // Two views of Anjali's password exist (today's, and the one planted 179 days ago). Each must
    // appear once: the general logger's own TEAM:VIEW row would make today's appear twice.
    check('each password view is listed exactly once', sentences.filter(s => s === "Lakshmi Owner viewed Anjali Sales's password").length === 2,
      String(sentences.filter(s => /viewed/.test(s)).length));
    check('no ids or codes anywhere in the sentences', !sentences.some(s => /[0-9a-f]{8}-[0-9a-f]{4}|_[A-Z]{2,}|USER_CREDENTIAL/.test(s)));
    check('newest first', entries.every((e, i) => i === 0 || new Date(entries[i - 1].at) >= new Date(e.at)));

    const p1 = await call('/team/security-log?limit=3', { token });
    const p2 = await call(`/team/security-log?limit=3&before=${encodeURIComponent(p1.json?.data?.entries?.at(-1)?.at)}`, { token });
    const ids1 = (p1.json?.data?.entries ?? []).map((e: any) => e.id);
    const ids2 = (p2.json?.data?.entries ?? []).map((e: any) => e.id);
    check('pages of 3 say there is more', p1.json?.data?.hasMore === true && ids1.length === 3);
    check('the next page carries on without repeating a row', ids2.length > 0 && !ids2.some((id: string) => ids1.includes(id)));
    const junk = await call('/team/security-log?before=not-a-date&limit=-5', { token });
    check('a nonsense page request still answers sensibly', junk.status === 200 && Array.isArray(junk.json?.data?.entries));

    const feed = await call('/team/activity', { token });
    const titles: string[] = (feed.json?.data ?? []).map((e: any) => e.title);
    check('Recent Activity leaves sign-ins out', feed.status === 200 && !titles.some(t => /signed in|sign in as/i.test(t)), titles.slice(0, 5).join(' | '));

    console.log('\nD. GUARDED');
    const salesIn = await call('/auth/login', { method: 'POST', body: { email: sales.email, password: sales.password } });
    const salesLog = await call('/team/security-log', { token: salesIn.token });
    check('a salesperson is refused the security log', salesLog.status === 403, `${salesLog.status}`);
    const otherIn = await call('/auth/login', { method: 'POST', body: { email: otherOwner.email, password: otherOwner.password } });
    const otherLog = await call('/team/security-log?limit=200', { token: otherIn.token });
    const otherSentences: string[] = (otherLog.json?.data?.entries ?? []).map((e: any) => e.sentence);
    check('another shop\'s owner sees only their own sign-in, nothing of this shop',
      otherLog.status === 200 && !otherSentences.some(s => /Lakshmi|Anjali|Ravi|Meena/.test(s)), otherSentences.join(' | '));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(x => console.log('  - ' + x)); process.exitCode = 1; }
  } finally {
    for (const id of [SHOP, OTHER]) {
      await platformAdminService.deleteClientCompletely(id, id).catch(e => console.log(`cleanup ${id}:`, e?.message));
    }
    const left = await prisma.user.count({ where: { clientId: { in: [SHOP, OTHER] } } })
      + await prisma.auditLog.count({ where: { clientId: { in: [SHOP, OTHER] } } });
    console.log(`\n(test shops removed, rows left: ${left})`);
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
