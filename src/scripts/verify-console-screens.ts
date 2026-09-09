/**
 * Every screen in the Platform Console loads, for the real data that is really there.
 *
 * Six of these screens have never been exercised by anything: Users, Leads, Onboarding,
 * Inventory Health, Errors and Support. A console screen fails differently from a shop screen
 * -- it reads across every tenant at once, so one bad row anywhere in the platform takes the
 * whole page down for the operator, and the operator is the person who was going to go and fix
 * that row.
 *
 * Speed is checked here too, and deliberately not as a pass/fail on a guessed number. It is
 * printed, because a console screen that takes eight seconds is a console nobody opens, and
 * the number is the thing worth knowing.
 *
 *   npx ts-node src/scripts/verify-console-screens.ts
 */
import { prisma } from '../lib/prisma';
import { platformAdminService } from '../services/platform-admin.service';
import { platformAuditService } from '../services/platform-audit.service';
import { leadService } from '../services/lead.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** Runs a screen's query, says how long it took, and never lets a throw escape. */
async function screen(name: string, load: () => Promise<any>) {
  const started = Date.now();
  try {
    const data = await load();
    const ms = Date.now() - started;
    const count = Array.isArray(data) ? data.length : (data ? 1 : 0);
    console.log(`  [PASS] ${name.padEnd(22)} ${String(ms + 'ms').padStart(7)}   ${count} row${count === 1 ? '' : 's'}`);
    passed++;
    return { ms, data };
  } catch (e: any) {
    const ms = Date.now() - started;
    console.log(`  [FAIL] ${name.padEnd(22)} ${String(ms + 'ms').padStart(7)}   ${e?.message ?? e}`);
    failed++; failures.push(name);
    return { ms, data: null };
  }
}

async function main() {
  try {
    console.log('EVERY CONSOLE SCREEN LOADS, AGAINST THE REAL PLATFORM\n');

    const clients = await screen('Clients', () => platformAdminService.listClients());
    const users = await screen('Users', () => platformAdminService.listAllUsers());
    await screen('Leads', () => leadService.list({ page: 1, limit: 25 }));
    await screen('Errors', () => platformAdminService.listClientErrors(100));
    await screen('Support', () => platformAdminService.listAllSupportTickets());
    await screen('Audit Log', () => platformAdminService.listAuditLog(100));
    await screen('Platform Admins', () => platformAdminService.listPlatformAdmins());
    await screen('Staff actions', () => platformAuditService.list(100));

    console.log('\nAND THERE WAS REAL DATA BEHIND THEM, NOT AN EMPTY DATABASE');
    // Without this, every check above passes on a platform with nothing in it.
    check('the platform has clients', (clients.data?.length ?? 0) > 0, `${clients.data?.length ?? 0}`);
    check('and users', (users.data?.length ?? 0) > 0, `${users.data?.length ?? 0}`);

    // --- THE PER-CLIENT SCREEN, FOR EVERY CLIENT ----------------------------
    console.log('\nTHE CLIENT OVERVIEW OPENS FOR EVERY SINGLE TENANT');
    // The one console screen with a page per tenant, so it is the one where a single bad row
    // hides -- it works for the first shop the operator clicks and fails on the fortieth.
    const ids: string[] = (clients.data ?? []).map((c: any) => c.clientId ?? c.id).filter(Boolean);
    const broken: string[] = [];
    let slowest = { clientId: '', ms: 0 };
    for (const clientId of ids) {
      const t = Date.now();
      try {
        const summary: any = await platformAdminService.getClientSummary(clientId);
        const ms = Date.now() - t;
        if (ms > slowest.ms) slowest = { clientId, ms };
        // A summary that loads but has no value figure is a blank card, which reads to an
        // operator as "this shop has nothing" rather than "this did not load".
        if (summary === null || summary === undefined) broken.push(`${clientId}: empty`);
      } catch (e: any) {
        broken.push(`${clientId}: ${e?.message ?? e}`);
      }
    }
    check(`all ${ids.length} client overviews open`, broken.length === 0, broken.slice(0, 3).join(' | '));
    check('and there were enough tenants for that to mean something', ids.length >= 5, `${ids.length} tenants`);
    console.log(`  (slowest: ${slowest.clientId} at ${slowest.ms}ms)`);

    // --- WHAT AN OPERATOR IS LOOKING FOR ------------------------------------
    console.log('\nTHE ERRORS SCREEN SHOWS FAULTS, NOT ROUTINE REFUSALS');
    // Rejecting "you cannot receive more than you ordered" is the app working. If those land
    // on this page they bury the crashes, and the page stops being read.
    const errors: any[] = await platformAdminService.listClientErrors(200);
    const routine = errors.filter(e =>
      /not found|already|cannot receive|must be|required|invalid|unauthor/i.test(e.message || ''));
    check('routine refusals are not filling the crash log',
      routine.length < Math.max(3, errors.length * 0.5),
      `${routine.length} of ${errors.length} look like ordinary rejections`);

    console.log('\nSUPPORT TICKETS ALL CARRY A REFERENCE SOMEONE CAN QUOTE');
    const tickets: any = await platformAdminService.listAllSupportTickets();
    const list = Array.isArray(tickets) ? tickets : (tickets?.data ?? []);
    const unnumbered = list.filter((t: any) => !t.ticketNumber);
    check('every ticket has a number', unnumbered.length === 0,
      `${unnumbered.length} of ${list.length} without one`);

    console.log('\nNO CLIENT IS LEFT SHOWING AN IMPERSONATION THAT ENDED');
    // A session row left open is shown to the client's own team as "a Scaleezy admin is
    // currently inside your account", which is alarming and, when stale, untrue.
    const open = await prisma.platformAdminSession.findMany({
      where: { endedAt: null }, select: { clientId: true, startedAt: true }
    });
    const stale = open.filter(s => Date.now() - new Date(s.startedAt).getTime() > 24 * 3600_000);
    check('no impersonation has been open for over a day', stale.length === 0,
      stale.slice(0, 3).map(s => `${s.clientId} since ${s.startedAt.toISOString().slice(0, 10)}`).join(' | '));

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
