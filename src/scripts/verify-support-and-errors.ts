/**
 * Support tickets and the crash reporter — the two channels a customer reaches us through.
 *
 * Neither had a test. They matter more than most features because they are what a customer
 * uses when something else has already gone wrong: a ticket that vanishes, or a crash report
 * that is never recorded, turns one bad moment into a customer who believes nobody is home.
 *
 * The crash reporter has a second property worth pinning down. It is deliberately mounted
 * ahead of authentication, because a frontend can crash BEFORE login resolves, or because auth
 * itself is what broke. That makes it the one place an anonymous stranger can write to our
 * database, so what it accepts is a security question, not just a correctness one.
 *
 *   npx ts-node src/scripts/verify-support-and-errors.ts
 */
import { prisma } from '../lib/prisma';
import { supportTicketService } from '../services/support-ticket.service';

let passed = 0, failed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const CLIENT = `support-e2e-${Date.now()}`;
const OTHER = `support-other-${Date.now()}`;
const API = process.env.TEST_API_URL || 'https://inventory-backend-6vk5.onrender.com';

async function main() {
  let userId = '';
  try {
    const user = await prisma.user.create({
      data: {
        clientId: CLIENT, name: 'Support Tester', email: `support-${Date.now()}@example.com`,
        password: 'x', status: 'ACTIVE'
      }
    });
    userId = user.id;

    // ─── RAISING A TICKET ───────────────────────────────────────────────────
    console.log('A CUSTOMER CAN RAISE A TICKET AND IT STAYS RAISED');
    const ticket: any = await supportTicketService.createTicket({
      clientId: CLIENT, userId, userName: user.name, userEmail: user.email,
      subject: 'Stock count looks wrong after a transfer',
      description: 'The Chirala figure did not move when I transferred twelve pieces.',
      category: 'OTHER'
    });
    check('a ticket is created', !!ticket?.id, ticket?.ticketNumber ?? '');
    check('it carries a reference the customer can quote', !!ticket?.ticketNumber, String(ticket?.ticketNumber));
    check('and opens in an unresolved state', ['OPEN', 'IN_PROGRESS'].includes(ticket?.status), String(ticket?.status));

    const mine: any = await supportTicketService.listTicketsForClient(CLIENT);
    const list = Array.isArray(mine) ? mine : (mine?.data ?? mine?.tickets ?? []);
    check('the customer can see it in their own list', list.some((t: any) => t.id === ticket.id),
      `${list.length} tickets`);

    // ─── THE CONVERSATION ───────────────────────────────────────────────────
    console.log('\nTHE CONVERSATION IS KEPT, BOTH SIDES OF IT');
    await supportTicketService.addMessage(ticket.id,
      { authorType: 'CLIENT', authorName: user.name, body: 'Adding the transfer reference: TRF-000004.' }, CLIENT);
    await supportTicketService.addMessage(ticket.id,
      { authorType: 'PLATFORM_ADMIN', authorName: 'Scaleezy Support', body: 'Thanks -- looking at that transfer now.' });

    const full: any = await supportTicketService.getTicket(ticket.id, CLIENT);
    const messages = full?.messages ?? [];
    check('both replies are stored', messages.length >= 2, `${messages.length} messages`);
    check('and it is possible to tell who said what',
      messages.some((m: any) => m.authorType === 'PLATFORM_ADMIN') && messages.some((m: any) => m.authorType === 'CLIENT'),
      JSON.stringify(messages.map((m: any) => m.authorType)));

    // ─── ISOLATION ──────────────────────────────────────────────────────────
    console.log('\nONE SHOP CANNOT READ ANOTHER SHOP\'S SUPPORT HISTORY');
    // A support thread carries whatever the customer pasted into it -- SKUs, figures,
    // sometimes credentials. It is among the most sensitive things in the database.
    const asStranger = await supportTicketService.getTicket(ticket.id, OTHER).catch(() => null);
    check('another tenant cannot open the ticket', !asStranger);
    const strangerList: any = await supportTicketService.listTicketsForClient(OTHER);
    const sl = Array.isArray(strangerList) ? strangerList : (strangerList?.data ?? strangerList?.tickets ?? []);
    check('nor see it in their list', !sl.some((t: any) => t.id === ticket.id));

    // ─── THE CRASH REPORTER ─────────────────────────────────────────────────
    console.log('\nTHE CRASH REPORTER ACCEPTS A REPORT WITHOUT A SESSION');
    // Mounted ahead of authentication on purpose: the frontend can crash before login
    // resolves, or because auth is what broke. A reporter that needs a session cannot report
    // the failure that matters most.
    const before = await prisma.clientErrorLog.count();
    const res = await fetch(`${API}/api/v1/client-errors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Pre-launch test: synthetic error, safe to ignore',
        stack: 'at verifySupportAndErrors (verify-support-and-errors.ts:1:1)',
        url: '/dashboard', userAgent: 'pre-launch-suite'
      })
    });
    check('an anonymous report is accepted', res.status >= 200 && res.status < 300, String(res.status));

    const after = await prisma.clientErrorLog.count();
    check('and is actually recorded', after === before + 1, `${before} -> ${after}`);

    console.log('\nBUT IT IS NOT AN OPEN DOOR');
    const huge = 'x'.repeat(200_000);
    const flood = await fetch(`${API}/api/v1/client-errors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: huge, stack: huge, url: '/dashboard' })
    });
    // Either refused outright, or accepted and truncated -- both are fine. What is not fine is
    // storing two hundred kilobytes because a stranger asked us to.
    const stored = await prisma.clientErrorLog.findFirst({ orderBy: { createdAt: 'desc' } });
    const storedLength = (stored?.message?.length ?? 0) + (stored?.stack?.length ?? 0);
    check('an oversized report does not land whole in the database',
      flood.status >= 400 || storedLength < 100_000,
      `status ${flood.status}, stored ${storedLength} chars`);

    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } finally {
    await prisma.clientErrorLog.deleteMany({ where: { message: { contains: 'Pre-launch test' } } }).catch(() => {});
    await prisma.supportTicketMessage.deleteMany({ where: { ticket: { clientId: CLIENT } } }).catch(() => {});
    await prisma.supportTicket.deleteMany({ where: { clientId: { in: [CLIENT, OTHER] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { clientId: { in: [CLIENT, OTHER] } } }).catch(() => {});
    console.log('\n(test tenant removed)');
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error('\nSuite did not finish:', e?.message ?? e); process.exitCode = 1; });
