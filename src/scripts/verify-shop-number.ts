/**
 * THE SHOP'S OWN NUMBER: seeing it, and changing it without asking anybody.
 *
 *   S  the Settings screen can tell whether the linked WhatsApp is the shop's own number
 *   C  changing the number: the code goes to the NEW phone, and everyone is told afterwards
 *   B  nothing blocks: every refusal here leaves a way forward
 *
 *   npx tsx src/scripts/verify-shop-number.ts      (needs the local backend running)
 *
 * Makes only throwaway workspaces and deletes them afterwards. Nothing goes out on WhatsApp: no
 * number is linked on a developer's machine, so the announcements fall through their own catches.
 * It DOES send email -- onboarding mails credentials, and a number change mails the owners -- all
 * to @example.com, the reserved domain that reaches nobody.
 */
import { prisma } from '../lib/prisma';
import { platformAdminService } from '../services/platform-admin.service';
import * as whatsapp from '../services/whatsapp/service';
import * as shopNumber from '../services/whatsapp/shop-number';
import { SignupVerifyError } from '../services/signup-verify';
import crypto from 'crypto';

const STAMP = Date.now();
const made: string[] = [];

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    failures.push(`${name} :: ${text}`);
    console.log(`  FAIL ${name} :: ${text}`);
  }
};
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return ''; }
  catch (e) { return e instanceof SignupVerifyError ? e.message : `NOT A RULE ERROR: ${(e as Error).message}`; }
};

/** A code in the table exactly as a real send would have left it. Nothing is messaged. */
async function plant(phone: string, code = '424242') {
  await prisma.signupPhoneCode.upsert({
    where: { phone },
    create: { phone, codeHash: crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex'), expiresAt: new Date(Date.now() + 600_000) },
    update: { codeHash: crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex'), expiresAt: new Date(Date.now() + 600_000), tries: 0, verifiedAt: null }
  });
}

async function main() {
  const born: any = await platformAdminService.onboardClient(
    `Number Shop ${STAMP}`, 'Owner', `number-${STAMP}@example.com`, '+91 98480 22338'
  );
  made.push(born.clientId);
  const owner = await prisma.user.findFirstOrThrow({
    where: { clientId: born.clientId }, select: { id: true, name: true }
  });
  const actor = { id: owner.id, clientId: born.clientId, name: owner.name };

  console.log('\nS. WHAT THE SCREEN CAN NOW TELL');
  const seen = await shopNumber.current(born.clientId);
  check('the shop knows its own number', seen.phone === '+91 98480 22338', seen);
  check('...and shows it masked, never in full', seen.masked === '••••2338', seen.masked);

  /*
   * The overview is what Settings > WhatsApp reads. On this machine nothing is linked, so the
   * comparison has only one side -- and it must say "cannot tell" rather than guess "wrong".
   */
  const overview: any = await whatsapp.getOverview({
    id: owner.id, clientId: born.clientId, name: owner.name,
    permissions: ['whatsapp:manage'], roles: ['SUPER_ADMIN']
  } as any);
  check('the overview carries the shop number for the screen to compare against',
    overview.shopPhone === '••••2338', overview.shopPhone);
  check('with nothing linked it says it cannot tell, rather than crying wrong number',
    overview.linkedIsShopNumber === null, overview.linkedIsShopNumber);

  console.log('\nC. CHANGING THE NUMBER');
  const NEW = '+919000055566';

  /*
   * ASKING FOR THE CODE CANNOT BE TESTED HERE, and that is said rather than faked.
   *
   * `startChange` really sends, and ScaleEzy's WhatsApp is not linked on a developer's machine, so
   * it refuses -- correctly. What IS checked is that the refusal is written for THIS screen: a
   * shop owner in Settings has no enquiry to send, so the signup module's wording must not reach
   * them. The send itself is proved on production.
   */
  const askedFor = await refusal(shopNumber.startChange(actor, NEW));
  check('asking for a code refuses in words a shop owner can act on',
    askedFor === '' || /could not send a code just now|not on WhatsApp|wait a few minutes/i.test(askedFor), askedFor);
  check('...and never in the signup form\'s words', !/enquiry/i.test(askedFor), askedFor);
  check('...and the number has not changed because a code failed to go',
    (await shopNumber.current(born.clientId)).phone === '+91 98480 22338');

  /* The change itself, with the code in the table exactly as a real send would have left it. */
  await plant(NEW);
  const done: any = await shopNumber.finishChange(actor, NEW, '424242');
  check('the right code changes the number', done.changed === true, done);
  const after = await shopNumber.current(born.clientId);
  check('...and the shop now says the new number is its own', after.phone === NEW, after);
  check('...shown masked', after.masked === '••••5566', after.masked);

  const back: any = await whatsapp.getOverview({
    id: owner.id, clientId: born.clientId, name: owner.name,
    permissions: ['whatsapp:manage'], roles: ['SUPER_ADMIN']
  } as any);
  check('the screen picks the change up at once', back.shopPhone === '••••5566', back.shopPhone);

  console.log('\nB. NOTHING LEAVES ANYBODY STUCK');
  check('a number that is not a number is refused in words',
    /does not look right/.test(await refusal(shopNumber.startChange(actor, '12'))));

  /*
   * Asking for the number they already have is not an error -- there is simply nothing to do, and
   * it answers before any code is sent, so it works even here.
   */
  const same: any = await shopNumber.startChange(actor, NEW);
  check('asking for the number they already have is not treated as a mistake',
    same.alreadyYours === true && same.sent === false, same);

  await plant(NEW);
  check('a wrong code says how many tries are left, so they can try again',
    /tries left|try left/.test(await refusal(shopNumber.finishChange(actor, NEW, '111111'))));
  check('...and the number is untouched while they get it wrong',
    (await shopNumber.current(born.clientId)).phone === NEW);

  /*
   * The important one for a shop that has lost its old phone: the code goes to the NEW number, so
   * losing the old one never locks them out of changing it.
   */
  const LOST = '+919000077788';
  await plant(LOST);
  const moved: any = await shopNumber.finishChange(actor, LOST, '424242');
  check('a shop that has lost its old phone can still move to a new one',
    moved.changed === true && (await shopNumber.current(born.clientId)).phone === LOST, moved);

  console.log('\nW. WHO MAY DO IT');
  const routes = (await import('fs')).readFileSync('src/routes/whatsapp.routes.ts', 'utf8');
  check('changing the number needs the same permission as linking one',
    /shop-number\/start[\s\S]{0,120}whatsapp:manage/.test(routes)
    && /shop-number\/finish[\s\S]{0,120}whatsapp:manage/.test(routes));
  const svc = (await import('fs')).readFileSync('src/services/whatsapp/shop-number.ts', 'utf8');
  check('the old number and the owners are told when it changes',
    /tellEverybody/.test(svc) && /SUPER_ADMIN/.test(svc) && /from: 'scaleezy'/.test(svc));
}

main()
  .catch(e => { failures.push(`suite stopped: ${(e as Error).stack ?? e}`); console.log(`\nSTOPPED: ${(e as Error).message}`); })
  .finally(async () => {
    for (const c of made) await platformAdminService.deleteClientCompletely(c, c).catch(() => {});
    await prisma.signupPhoneCode.deleteMany({
      where: { phone: { in: ['+919000055566', '+919000077788'] } }
    }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
