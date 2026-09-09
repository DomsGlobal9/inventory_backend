/**
 * What a platform admin does is recorded.
 *
 * Before this, entering a client's account was the only console action that left any trace.
 * Sixteen others -- including reading a shop owner's password in plain text, resetting it,
 * suspending a shop, deleting one outright, and issuing or revoking a service key -- happened
 * invisibly. The console's own Audit Log page showed client-user activity and impersonation
 * sessions, and nothing else.
 *
 * The plaintext-password path is a deliberate feature and the right call: a client whose only
 * Super Admin forgets their password has no other way back in, and locking a paying shop out
 * of its own stock is worse. What makes a capability like that acceptable is not that it is
 * rarely used, it is that using it is recorded and someone can go and look.
 *
 * This exercises the real route through the real middleware, because the property being
 * checked is "the console records it", not "the service can write a row".
 *
 *   npx ts-node src/scripts/verify-platform-audit.ts
 */
import { prisma } from '../lib/prisma';
import { platformAuditService } from '../services/platform-audit.service';
import { buildUnifiedAuditFeed } from '../services/audit-feed.service';
import { AuthService } from '../services/auth.service';
import { encryptCredential } from '../lib/credentialEncryption';
import express from 'express';
import cookieParser from 'cookie-parser';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `pa-audit-${Date.now()}`;
const ADMIN_EMAIL = `pa-audit-${Date.now()}@example.com`;
const ADMIN_PASSWORD = 'Sc@leezy-Test-1';

const servers: any[] = [];

async function main() {
  let adminId = '';
  let userId = '';
  try {
    console.log('SETUP: one platform admin, one shop owner with a viewable password');

    const admin = await prisma.platformAdmin.create({
      data: {
        email: ADMIN_EMAIL, name: 'Audit Tester',
        password: await AuthService.hashPassword(ADMIN_PASSWORD), status: 'ACTIVE'
      }
    });
    adminId = admin.id;

    // passwordEncrypted is what makes the plaintext view possible at all.
    const owner = await prisma.user.create({
      data: {
        clientId: CLIENT, name: 'Shop Owner', email: `owner-${Date.now()}@example.com`,
        password: await AuthService.hashPassword('owner-secret-1'),
        passwordEncrypted: encryptCredential('owner-secret-1'),
        status: 'ACTIVE'
      }
    });
    userId = owner.id;

    // --- THE REAL ROUTE -----------------------------------------------------
    console.log('\nREADING A PASSWORD THROUGH THE CONSOLE LEAVES A RECORD');
    // Through the actual express app, so the middleware is what is being tested rather than a
    // direct call to the service it delegates to.
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Mounted the way server.ts mounts them, so paths match production exactly.
    const { platformAdminAuthRoutes, platformAdminConsoleRoutes } = require('../routes/platform-admin.routes');
    app.use('/api/v1/auth/admin', platformAdminAuthRoutes);
    app.use('/api/v1/admin', platformAdminConsoleRoutes);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}/api/v1`;

    // The session lives in a cookie, and this holds on to it the way a browser would.
    let cookie = '';
    const call = async (path: string, opts: { withCookie?: boolean } = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.withCookie === false ? {} : cookie ? { cookie } : {})
        },
        body: '{}'
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body: any = null;
      try { body = await res.json(); } catch { /* some responses have no body */ }
      return { status: res.status, body };
    };
    servers.push(server);

    // The login body carries the credentials, so it is sent directly rather than through call().
    const loginRes = await fetch(`${base}/auth/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    });
    const loginCookie = loginRes.headers.get('set-cookie');
    if (loginCookie) cookie = loginCookie.split(';')[0];
    check('the platform admin can sign in', loginRes.status === 200, `status ${loginRes.status}`);

    const before = await prisma.platformAdminAction.count();
    const view = await call(`/admin/users/${userId}/password/view`);
    check('the password can be read -- the recovery path still works', view.status === 200, `status ${view.status}`);
    check('and it really is the password, not a hash',
      view.body?.data?.password === 'owner-secret-1', String(view.body?.data?.password).slice(0, 12));

    // The middleware records after the response is sent, so give it a beat to land.
    await new Promise(r => setTimeout(r, 2500));

    const after = await prisma.platformAdminAction.count();
    check('a row is written', after === before + 1, `${before} -> ${after}`);

    const row: any = await prisma.platformAdminAction.findFirst({
      where: { action: 'VIEW_PASSWORD', targetId: userId }, orderBy: { createdAt: 'desc' }
    });
    check('it names the action plainly', row?.action === 'VIEW_PASSWORD', String(row?.action));
    check('it names who did it', row?.adminEmail === ADMIN_EMAIL, String(row?.adminEmail));
    check('it names whose password was read', (row?.targetLabel || '').includes(owner.email), String(row?.targetLabel));
    check('and when', !!row?.createdAt, String(row?.createdAt));

    console.log('\nBUT THE RECORD DOES NOT ITSELF LEAK THE PASSWORD');
    // A log that copies the secret it is reporting on has doubled the exposure rather than
    // controlled it: it moves the password into a table more people can read, for ever.
    const serialised = JSON.stringify(row);
    check('the password appears nowhere in the row', !serialised.includes('owner-secret-1'));

    // --- FAILED ATTEMPTS ARE NOT "WHAT WAS DONE" ----------------------------
    console.log('\nA REFUSED ACTION IS NOT RECORDED AS HAVING HAPPENED');
    const countBeforeFail = await prisma.platformAdminAction.count();
    const missing = await call('/admin/users/00000000-0000-0000-0000-000000000000/password/view');
    check('reading a password for a user who does not exist fails', missing.status >= 400, `status ${missing.status}`);
    await new Promise(r => setTimeout(r, 2000));
    const countAfterFail = await prisma.platformAdminAction.count();
    check('and nothing is recorded for it', countAfterFail === countBeforeFail,
      `${countBeforeFail} -> ${countAfterFail}`);

    console.log('\nAND AN ANONYMOUS CALLER IS NOT RECORDED AS AN ADMIN');
    const stranger = await call(`/admin/users/${userId}/password/view`, { withCookie: false });
    check('a caller with no session is refused', stranger.status === 401, `status ${stranger.status}`);

    // --- THE TRAIL SURVIVES ITS SUBJECT -------------------------------------
    console.log('\nTHE TRAIL OUTLIVES THE ADMIN IT IS ABOUT');
    // Deleting an admin account is itself one of the things recorded here. A trail with a
    // foreign key to platform_admins would take the evidence with it.
    await prisma.platformAdmin.delete({ where: { id: adminId } });
    adminId = '';
    const survives: any = await prisma.platformAdminAction.findFirst({
      where: { action: 'VIEW_PASSWORD', targetId: userId }, orderBy: { createdAt: 'desc' }
    });
    check('the row is still there after the admin is deleted', !!survives);
    check('and it still says who it was', survives?.adminEmail === ADMIN_EMAIL, String(survives?.adminEmail));

    // --- THE CONSOLE CAN SEE IT ---------------------------------------------
    console.log("\nIT SHOWS UP ON THE CONSOLE'S AUDIT LOG, IN WORDS");
    const feed: any[] = await buildUnifiedAuditFeed({ limit: 200 });
    const entry = feed.find(e => e.type === 'ADMIN_ACTION' && e.action === 'VIEW_PASSWORD');
    check('the console feed carries it', !!entry);
    check('written as a sentence, not a code',
      /plain text/i.test(entry?.title || ''), String(entry?.title).slice(0, 80));

    console.log("\nBUT NOT ON AN UNRELATED CLIENT'S OWN ACTIVITY FEED");
    // A client's Team & Users page must not show them Scaleezy's actions against other shops.
    const otherClientFeed: any[] = await buildUnifiedAuditFeed({
      clientId: `unrelated-${Date.now()}`, limit: 100, includeAdminSessions: false
    });
    check('a client sees nothing of it',
      !otherClientFeed.some(e => e.type === 'ADMIN_ACTION'), `${otherClientFeed.length} entries`);

    // --- EVERY SENSITIVE ROUTE IS COVERED -----------------------------------
    console.log('\nEVERY CONSOLE MUTATION HAS A NAME IN THE MAP, NOT JUST THIS ONE');
    // A route added later without a name still gets recorded -- with a generic action -- which
    // is the right way round. This checks the ones that exist today are all named, so nothing
    // sensitive is sitting in the log as "POST_/clients/x/suspend".
    const routeFile = require('fs').readFileSync('src/routes/platform-admin.routes.ts', 'utf8');
    const mutationRoutes = (routeFile.match(/consoleRouter\.(post|put|patch|delete)\('([^']+)'/g) || [])
      .map((m: string) => m.replace(/consoleRouter\.(post|put|patch|delete)\('/, '').replace(/'$/, ''));
    const middleware = require('fs').readFileSync('src/middleware/platform-audit.middleware.ts', 'utf8');
    // Every route's distinctive last segment should appear somewhere in the pattern table.
    const unnamed = mutationRoutes.filter((r: string) => {
      const tail = r.split('/').filter(Boolean).pop() || '';
      if (tail.startsWith(':')) {
        const parent = r.split('/').filter(Boolean).slice(-2)[0] || '';
        return !middleware.includes(parent.replace(/^:/, ''));
      }
      return !middleware.includes(tail);
    });
    check('no console mutation is left unnamed', unnamed.length === 0, unnamed.join(', '));
    check('and there were routes to check', mutationRoutes.length >= 15, `${mutationRoutes.length} routes`);

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    await prisma.platformAdminAction.deleteMany({ where: { adminEmail: ADMIN_EMAIL } }).catch(() => {});
    await prisma.user.deleteMany({ where: { clientId: CLIENT } }).catch(() => {});
    if (adminId) await prisma.platformAdmin.delete({ where: { id: adminId } }).catch(() => {});
    await prisma.platformAdmin.deleteMany({ where: { email: ADMIN_EMAIL } }).catch(() => {});
    // closeAllConnections as well as close: fetch leaves keep-alive sockets open, and one live
    // socket keeps the whole process running after the suite has already finished.
    servers.forEach(srv => {
      try { srv.closeAllConnections?.(); srv.close(); } catch { /* already closed */ }
    });
    console.log('\n(test admin and tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
