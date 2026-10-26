/**
 * The onboarding emails (26 Oct): the owner gets TWO -- the login, then a welcome with no password
 * in it -- and staff get only their login. No phone number anywhere; help is the in-app support.
 *
 *   A. What each message says (pure).
 *   B. Who gets which, through the real onboarding and invite code, counting what each tried to
 *      send. LOCAL database only (it creates a client), and nothing leaves the machine: the mail
 *      sender is replaced for this run by one that records instead of sending.
 *
 *   DATABASE_URL=<local> npx tsx src/scripts/verify-onboarding-emails.ts
 */
import { loginEmail, welcomeEmail, friendlyRole } from '../services/mail-templates/onboarding';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${JSON.stringify(detail).slice(0, 300)}`); }
};
const base = 'https://inventory.scaleezy.com';

async function main() {
  console.log('\nA. WHAT EACH MESSAGE SAYS');
  const login = loginEmail({ base, recipientName: 'Lakshmi Prasanna', email: 'l@example.com', password: 'K7m#pq2Lx9', roleLabel: 'SUPER_ADMIN', shopName: 'Sri Lakshmi Silks' });
  check('owner login: subject names the shop', login.subject === 'Your ScaleEzy login for Sri Lakshmi Silks', login.subject);
  check('...holds the email and password, in HTML and text', login.html.includes('l@example.com') && login.html.includes('K7m#pq2Lx9') && login.text.includes('K7m#pq2Lx9'));
  check('...signs in at the shop login page', login.html.includes(`${base}/login"`) && login.text.includes(`${base}/login`));
  check('...calls SUPER_ADMIN "Owner"', login.html.includes('Owner') && !login.html.includes('SUPER_ADMIN'));
  check('...says where to change the password', /Settings, General/.test(login.html));

  const welcome = welcomeEmail({ base, recipientName: 'Lakshmi Prasanna', email: 'l@example.com', shopName: 'Sri Lakshmi Silks' });
  check('welcome: subject welcomes the shop', welcome.subject === 'Welcome to ScaleEzy, Sri Lakshmi Silks', welcome.subject);
  check('...holds NO password, in HTML or text', !welcome.html.includes('K7m#pq2Lx9') && !/password:/i.test(welcome.text) && !/Temporary password/i.test(welcome.html));
  check('...says the login came separately', /login came in a separate email/.test(welcome.html) && /separate email/.test(welcome.text));
  for (const path of ['/products', '/inventory', '/settings?section=POS', '/settings?section=ONLINE_SHOP', '/settings?section=USERS', '/help', '/settings?section=SUPPORT', '/dashboard']) {
    check(`...links to ${path}`, welcome.html.includes(`${base}${path.replace(/&/g, '&amp;')}`) && welcome.text.includes(`${base}${path}`));
  }
  check('...points to ScaleEzy support, with no phone number', /contact ScaleEzy support/.test(welcome.html) && !/\+?91[\s-]?\d{5}|\b\d{10}\b/.test(welcome.html + welcome.text));
  check('...greets by first name', /Welcome aboard, Lakshmi</.test(welcome.html));

  const evil = welcomeEmail({ base, recipientName: '<script>x</script>', email: 'e@example.com', shopName: '"><img src=x onerror=alert(1)>' });
  check('names typed by people cannot inject markup', !evil.html.includes('<script>x') && !evil.html.includes('<img src=x'), evil.html.slice(0, 200));

  const staff = loginEmail({ base, recipientName: 'Divya', email: 'd@example.com', password: 'p9X-2mQ7', roleLabel: 'SALES', shopName: 'Sri Lakshmi Silks' });
  check('staff login: role in words ("Sales")', staff.html.includes('Sri Lakshmi Silks · Sales'));
  check('a custom role keeps the shop\'s own name', friendlyRole('Floor manager') === 'Floor manager');
  const platform = loginEmail({ base, recipientName: 'Ravi', email: 'r@scaleezy.com', password: 'pw-123456', audience: 'platform' });
  check('platform admin: Console subject and the Console sign-in page', platform.subject === 'Your ScaleEzy Platform Console login' && platform.html.includes(`${base}/platformconsole/login`));
  const noShop = loginEmail({ base, recipientName: 'X', email: 'x@example.com', password: 'p', roleLabel: 'ADMIN' });
  check('no shop name known: the subject still reads well', noShop.subject === 'Your ScaleEzy login', noShop.subject);

  console.log('\nB. WHO GETS WHICH (real onboarding and invite, LOCAL database)');
  if (!String(process.env.DATABASE_URL).includes('localhost')) {
    console.log('  (skipped: needs the LOCAL database, because it creates a client)');
    return;
  }
  // Recording instead of sending, for this process only.
  const sent: { kind: string; to: string; subject: string }[] = [];
  const { mailService } = await import('../services/mail.service');
  (mailService as any).sendCredentials = async (i: any) => { sent.push({ kind: 'login', to: i.email, subject: loginEmail({ base, ...i }).subject }); return { sent: true }; };
  (mailService as any).sendWelcome = async (i: any) => { sent.push({ kind: 'welcome', to: i.email, subject: welcomeEmail({ base, ...i }).subject }); return { sent: true }; };

  const { platformAdminService } = await import('../services/platform-admin.service');
  const { teamService } = await import('../services/team.service');
  const { prisma } = await import('../lib/prisma');
  const S = Date.now() % 1_000_000;
  const owner = `owner${S}@example.com`;
  const result: any = await platformAdminService.onboardClient(`Welcome Test Silks ${S}`, 'Asha Rani', owner, null, {} as any);
  const toOwner = sent.filter(s => s.to === owner);
  check('onboarding sends the owner exactly two emails', toOwner.length === 2, sent);
  check('...the login first, then the welcome', toOwner[0]?.kind === 'login' && toOwner[1]?.kind === 'welcome', toOwner);
  check('...and the onboarding answer says both went', result.emailed === true && result.welcomed === true, result);

  const role = await prisma.role.findFirst({ where: { clientId: result.clientId, name: 'SALES' } })
    ?? await prisma.role.findFirst({ where: { clientId: result.clientId, NOT: { name: 'SUPER_ADMIN' } } });
  const staffEmail = `staff${S}@example.com`;
  sent.length = 0;
  await teamService.inviteMember({ clientId: result.clientId, name: 'Ravi Teja', email: staffEmail, roleId: role!.id, requesterIsSuperAdmin: true });
  check('adding a staff member sends ONE email: the login', sent.length === 1 && sent[0].kind === 'login' && sent[0].to === staffEmail, sent);
  check('...naming the shop', sent[0]?.subject === `Your ScaleEzy login for Welcome Test Silks ${S}`, sent[0]?.subject);
  check('...and NO welcome (owner only)', !sent.some(s => s.kind === 'welcome'));
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('CRASHED', e); })
  .finally(() => {
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
