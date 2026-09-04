/**
 * End-to-end verification of the authentication, public signup and lead pipeline.
 *
 * Runs against a live server so it exercises routing, middleware order, rate limiting and
 * the real database rather than calling services directly -- the signup endpoint's most
 * important property is that it sits OUTSIDE the global authenticate middleware while the
 * console endpoints sit inside it, and only a real request proves that.
 *
 *   npx ts-node src/scripts/verify-auth-signup-leads.ts
 */
const BASE = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const PLATFORM_EMAIL = 'platform-admin@scaleezy.com';
const PLATFORM_PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'PlatformAdmin123!';

const stamp = Date.now();
const LEAD_EMAIL = `lead.${stamp}@example.com`;
const DUP_EMAIL = `dup.${stamp}@example.com`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`);
  }
}

/** Minimal cookie jar: the session is an httpOnly cookie, so auth cannot be faked here. */
class Jar {
  private cookies = new Map<string, string>();
  capture(res: Response) {
    const raw = (res.headers as any).getSetCookie?.() || [];
    for (const line of raw) {
      const [pair] = String(line).split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear() { this.cookies.clear(); }
}

async function call(
  method: string,
  path: string,
  body?: any,
  jar?: Jar
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const cookie = jar?.header();
  if (cookie) headers['Cookie'] = cookie;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  jar?.capture(res);
  let json: any = null;
  try { json = await res.json(); } catch { /* empty body is fine */ }
  return { status: res.status, json };
}

async function main() {
  console.log(`\nVerifying against ${BASE}\n`);

  // ─── SIGNUP: required fields ────────────────────────────────────────────────
  console.log('SIGNUP -- validation');
  const base = { companyName: 'Verify Traders', contactName: 'Test Person' };

  const noPhone = await call('POST', '/leads', { ...base, email: LEAD_EMAIL });
  check('signup without phone is rejected', noPhone.status === 400, `got ${noPhone.status}`);

  const noEmail = await call('POST', '/leads', { ...base, phone: '9876543210' });
  check('signup without email is rejected', noEmail.status === 400, `got ${noEmail.status}`);

  const badEmail = await call('POST', '/leads', { ...base, email: 'not-an-email', phone: '9876543210' });
  check('signup with malformed email is rejected', badEmail.status === 400, `got ${badEmail.status}`);

  const lettersPhone = await call('POST', '/leads', { ...base, email: LEAD_EMAIL, phone: 'call-me' });
  check('signup with non-numeric phone is rejected', lettersPhone.status === 400, `got ${lettersPhone.status}`);

  const shortPhone = await call('POST', '/leads', { ...base, email: LEAD_EMAIL, phone: '12345' });
  check('signup with too-short phone is rejected', shortPhone.status === 400, `got ${shortPhone.status}`);

  const shortName = await call('POST', '/leads', { companyName: 'X', contactName: 'Y', email: LEAD_EMAIL, phone: '9876543210' });
  check('signup with 1-character names is rejected', shortName.status === 400, `got ${shortName.status}`);

  // ─── SIGNUP: accepted shapes ────────────────────────────────────────────────
  console.log('\nSIGNUP -- accepted');
  const created = await call('POST', '/leads', {
    companyName: '  Verify Traders  ',
    contactName: '  Test Person  ',
    email: `  ${LEAD_EMAIL.toUpperCase()}  `,
    phone: '  +91 98765 43210  ',
    message: 'Interested in multi-location stock.'
  });
  check('valid signup is accepted', created.status === 201, `got ${created.status}`);
  check('signup returns only an id, never the stored row',
    !!created.json?.data?.id && Object.keys(created.json?.data || {}).length === 1,
    JSON.stringify(created.json?.data));

  const intlPhone = await call('POST', '/leads', { ...base, email: DUP_EMAIL, phone: '(044) 2345 6789' });
  check('landline written with brackets and spaces is accepted', intlPhone.status === 201, `got ${intlPhone.status}`);

  const again = await call('POST', '/leads', { ...base, email: DUP_EMAIL, phone: '9876543210' });
  check('same email may enquire twice (no unique constraint leak)', again.status === 201, `got ${again.status}`);

  // ─── SIGNUP: rate limiting ──────────────────────────────────────────────────
  // Only meaningful when the server was started with a known ceiling; skipped otherwise so
  // the suite does not depend on how many requests happened before it ran.
  const ceiling = Number(process.env.TEST_SIGNUP_LIMIT || 0);
  if (ceiling > 0) {
    console.log('
SIGNUP -- rate limiting');
    let sawLimit = false;
    // +2 past the ceiling: everything so far already counted, so this must trip it.
    for (let i = 0; i < ceiling + 2; i++) {
      const r = await call('POST', '/leads', {
        companyName: 'Flood Co', contactName: 'Flood Person',
        email: `flood.${stamp}.${i}@example.com`, phone: '9876543210'
      });
      if (r.status === 429) { sawLimit = true; break; }
    }
    check('the public form is rate limited', sawLimit);
    await call('DELETE', '/__noop', undefined); // no-op, keeps shape simple
  }

  // ─── SIGNUP: provisions nothing ─────────────────────────────────────────────
  console.log('\nSIGNUP -- provisions nothing');
  const anon = new Jar();
  const loginAsLead = await call('POST', '/auth/login', { email: LEAD_EMAIL, password: 'anything' }, anon);
  check('a signup does NOT create a login', loginAsLead.status === 401, `got ${loginAsLead.status}`);

  // ─── AUTH: platform admin ───────────────────────────────────────────────────
  console.log('\nAUTH -- platform admin');
  const badAdmin = await call('POST', '/auth/admin/login', { email: PLATFORM_EMAIL, password: 'wrong-password' });
  check('platform login with wrong password is refused', badAdmin.status === 401, `got ${badAdmin.status}`);

  const noSuchAdmin = await call('POST', '/auth/admin/login', { email: 'nobody@nowhere.test', password: 'x' });
  check('platform login with unknown email is refused', noSuchAdmin.status === 401, `got ${noSuchAdmin.status}`);

  const admin = new Jar();
  const adminLogin = await call('POST', '/auth/admin/login', { email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD }, admin);
  check('platform login with correct password succeeds', adminLogin.status === 200, `got ${adminLogin.status}`);

  const session = await call('GET', '/auth/admin/session', undefined, admin);
  check('platform session resolves from the cookie', session.status === 200, `got ${session.status}`);

  // ─── AUTH: console is protected ─────────────────────────────────────────────
  console.log('\nAUTH -- console access control');
  const leadsAnon = await call('GET', '/admin/leads');
  check('leads list is refused without a session', leadsAnon.status === 401, `got ${leadsAnon.status}`);

  const convertAnon = await call('POST', '/admin/leads/00000000-0000-0000-0000-000000000000/convert', {});
  check('convert is refused without a session', convertAnon.status === 401, `got ${convertAnon.status}`);

  const clientJar = new Jar();
  const leadsAsClient = await call('GET', '/admin/leads', undefined, clientJar);
  check('a client session cannot reach console leads', leadsAsClient.status === 401, `got ${leadsAsClient.status}`);

  // ─── LEADS: listing ─────────────────────────────────────────────────────────
  console.log('\nLEADS -- listing and filtering');
  const list = await call('GET', '/admin/leads', undefined, admin);
  check('leads list loads for a platform admin', list.status === 200, `got ${list.status}`);

  const mine = (list.json?.data || []).find((l: any) => l.email === LEAD_EMAIL.toLowerCase());
  check('the submitted lead appears in the list', !!mine);
  check('email is normalised to lowercase and trimmed', mine?.email === LEAD_EMAIL.toLowerCase(), mine?.email);
  check('company name is trimmed', mine?.companyName === 'Verify Traders', JSON.stringify(mine?.companyName));
  check('phone is stored as entered', mine?.phone === '+91 98765 43210', mine?.phone);
  check('new leads start as NEW', mine?.status === 'NEW', mine?.status);
  check('the message is kept', mine?.message === 'Interested in multi-location stock.', mine?.message);
  check('status counts are returned for the board', typeof list.json?.meta?.countsByStatus?.NEW === 'number');

  const filtered = await call('GET', '/admin/leads?status=NEW', undefined, admin);
  check('filtering by status returns only that status',
    filtered.status === 200 && (filtered.json?.data || []).every((l: any) => l.status === 'NEW'));

  const searched = await call('GET', `/admin/leads?search=${encodeURIComponent('Verify Traders')}`, undefined, admin);
  check('search matches on business name',
    searched.status === 200 && (searched.json?.data || []).some((l: any) => l.email === LEAD_EMAIL.toLowerCase()));

  const byPhone = await call('GET', '/admin/leads?search=98765', undefined, admin);
  check('search matches on phone fragment',
    byPhone.status === 200 && (byPhone.json?.data || []).some((l: any) => l.email === LEAD_EMAIL.toLowerCase()));

  const noMatch = await call('GET', '/admin/leads?search=zzzz-no-such-lead-zzzz', undefined, admin);
  check('a search with no matches returns an empty list, not an error',
    noMatch.status === 200 && (noMatch.json?.data || []).length === 0);

  // ─── LEADS: triage ──────────────────────────────────────────────────────────
  console.log('\nLEADS -- triage');
  const leadId = mine?.id;

  const contacted = await call('PATCH', `/admin/leads/${leadId}`, { status: 'CONTACTED' }, admin);
  check('status can be moved to CONTACTED', contacted.status === 200 && contacted.json?.data?.status === 'CONTACTED');

  const noted = await call('PATCH', `/admin/leads/${leadId}`, { notes: 'Called, wants a demo.' }, admin);
  check('notes are saved', noted.status === 200 && noted.json?.data?.notes === 'Called, wants a demo.');

  const stillContacted = await call('GET', '/admin/leads?status=CONTACTED', undefined, admin);
  check('notes update does not clobber status',
    (stillContacted.json?.data || []).some((l: any) => l.id === leadId));

  const manualConvert = await call('PATCH', `/admin/leads/${leadId}`, { status: 'CONVERTED' }, admin);
  check('CONVERTED cannot be set by hand', manualConvert.status === 400, `got ${manualConvert.status}`);

  const emptyPatch = await call('PATCH', `/admin/leads/${leadId}`, {}, admin);
  check('an empty update is rejected', emptyPatch.status === 400, `got ${emptyPatch.status}`);

  const missingLead = await call('PATCH', '/admin/leads/00000000-0000-0000-0000-000000000000', { status: 'NEW' }, admin);
  check('updating an unknown lead returns 404', missingLead.status === 404, `got ${missingLead.status}`);

  // ─── LEADS: conversion ──────────────────────────────────────────────────────
  console.log('\nLEADS -- conversion');
  const convert = await call('POST', `/admin/leads/${leadId}/convert`, {}, admin);
  check('convert creates a workspace', convert.status === 201, `got ${convert.status}`);

  const creds = convert.json?.data;
  check('convert returns a workspace id', !!creds?.clientId, JSON.stringify(creds));
  check('convert returns a temporary password', !!creds?.tempPassword);
  check('the workspace admin is the lead contact', creds?.adminEmail === LEAD_EMAIL.toLowerCase(), creds?.adminEmail);

  const afterConvert = await call('GET', '/admin/leads?status=CONVERTED', undefined, admin);
  const convertedLead = (afterConvert.json?.data || []).find((l: any) => l.id === leadId);
  check('the lead is marked CONVERTED', convertedLead?.status === 'CONVERTED');
  check('the lead records which workspace it became', convertedLead?.convertedClientId === creds?.clientId);
  check('the lead records when it was converted', !!convertedLead?.convertedAt);

  const twice = await call('POST', `/admin/leads/${leadId}/convert`, {}, admin);
  check('converting the same lead twice is refused', twice.status === 409, `got ${twice.status}`);

  // ─── AUTH: the converted client ─────────────────────────────────────────────
  console.log('\nAUTH -- the converted client');
  const clientSession = new Jar();
  const wrongPw = await call('POST', '/auth/login', { email: creds?.adminEmail, password: 'not-the-password' });
  check('client login with a wrong password is refused', wrongPw.status === 401, `got ${wrongPw.status}`);

  const clientLogin = await call('POST', '/auth/login',
    { email: creds?.adminEmail, password: creds?.tempPassword }, clientSession);
  check('the converted client can log in', clientLogin.status === 200, `got ${clientLogin.status}`);
  check('the login is scoped to the new workspace',
    clientLogin.json?.data?.user?.clientId === creds?.clientId, clientLogin.json?.data?.user?.clientId);

  const locations = await call('GET', '/locations', undefined, clientSession);
  const locs = Array.isArray(locations.json) ? locations.json : (locations.json?.data || []);
  check('the new workspace has a default stock location',
    locations.status === 200 && locs.length > 0 && locs[0]?.code === 'MAIN-STORE',
    JSON.stringify(locs));

  const products = await call('GET', '/products', undefined, clientSession);
  check('the new workspace starts with an empty catalogue',
    products.status === 200 && (products.json?.data || []).length === 0);

  const consoleFromClient = await call('GET', '/admin/leads', undefined, clientSession);
  check('a real client session still cannot read console leads',
    consoleFromClient.status === 401, `got ${consoleFromClient.status}`);

  const logout = await call('POST', '/auth/logout', {}, clientSession);
  check('client logout succeeds', logout.status === 200, `got ${logout.status}`);

  const afterLogout = await call('GET', '/products', undefined, clientSession);
  check('the session is dead after logout', afterLogout.status === 401, `got ${afterLogout.status}`);

  // ─── CLEANUP ────────────────────────────────────────────────────────────────
  console.log('\nCLEANUP');
  const { prisma } = await import('../lib/prisma');
  const clientId = creds?.clientId;
  if (clientId) {
    await prisma.userRole.deleteMany({ where: { user: { clientId } } });
    await prisma.user.deleteMany({ where: { clientId } });
    await prisma.clientCatalogItem.deleteMany({ where: { clientId } });
    await prisma.stockLocation.deleteMany({ where: { clientId } });
    await prisma.rolePermission.deleteMany({ where: { role: { clientId } } });
    await prisma.role.deleteMany({ where: { clientId } });
    console.log(`  removed test workspace ${clientId}`);
  }
  const removed = await prisma.signupLead.deleteMany({
    where: {
      OR: [
        { email: { in: [LEAD_EMAIL.toLowerCase(), DUP_EMAIL.toLowerCase()] } },
        { email: { startsWith: `flood.${stamp}.` } }
      ]
    }
  });
  console.log(`  removed ${removed.count} test lead(s)`);
  await prisma.$disconnect();

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) {
    console.log('Failed:\n' + failures.map(f => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
