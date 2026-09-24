/**
 * THE PHONE GIVEN AT SIGNUP, AND WHERE IT ENDS UP.
 *
 * A number is asked for on the signup form and proved with a code. This is about what happens to
 * it afterwards -- it was being dropped on the floor at conversion, so a brand-new workspace had
 * no phone anywhere: not on the letterhead a purchase order prints, not as the contact the online
 * shop is legally required to publish, not as the Day Book's destination.
 *
 * Also the question underneath it: ONE WhatsApp number belongs to the shop, not to whoever is
 * logged in. This proves that every document leaves from the shop's own number, that who pressed
 * send is still recorded, and that a user's personal number is never the sender.
 *
 *   npx tsx src/scripts/verify-signup-phone-carries.ts     (needs the local backend running)
 *
 * Makes only throwaway workspaces and deletes them afterwards. Nothing goes out on WhatsApp.
 *
 * IT DOES SEND EMAIL, three of them: onboarding a workspace mails the new owner their credentials,
 * and converting a lead is onboarding. They are addressed to @example.com, which is the reserved
 * domain that reaches nobody, so no real person is written to -- but they are real sends through
 * the real provider, and anyone adding cases here should keep the addresses on that domain.
 */
import { prisma } from '../lib/prisma';
import { leadService } from '../services/lead.service';
import { platformAdminService } from '../services/platform-admin.service';
import { signupVerify } from '../services/signup-verify';

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

async function leadFor(tag: string, phone: string) {
  // Proof is off for these: what is under test is where the number GOES, not the code that proves
  // it (verify-signup-otp covers that), and no WhatsApp is linked on a developer's machine anyway.
  process.env.SIGNUP_PHONE_PROOF = 'never';
  try {
    const out: any = await leadService.create({
      companyName: `Carry ${tag} ${STAMP}`,
      contactName: 'Anita Rao',
      email: `carry-${tag}-${STAMP}@example.com`,
      phone
    });
    return out.id as string;
  } finally {
    delete process.env.SIGNUP_PHONE_PROOF;
  }
}

async function main() {
  console.log('\nP. THE NUMBER REACHES THE NEW WORKSPACE');

  const id = await leadFor('plain', '+91 98480 22338');
  const born: any = await leadService.convert(id);
  made.push(born.clientId);

  const settings = await prisma.clientSettings.findUnique({
    where: { clientId: born.clientId }, select: { businessPhone: true, businessName: true }
  });
  check('a converted lead brings its phone onto the shop', !!settings?.businessPhone, settings);
  check('...as the number that was typed, not a mangled one',
    String(settings?.businessPhone).includes('98480 22338'), settings?.businessPhone);
  check('...beside the shop name it already carried', /^Carry plain/.test(String(settings?.businessName)), settings?.businessName);

  const wa = await prisma.whatsAppSettings.findUnique({
    where: { clientId: born.clientId }, select: { dayBookTo: true, dayBookEnabled: true }
  });
  check('the nightly Day Book knows where it would go', wa?.dayBookTo === '919848022338', wa);
  check('...but is OFF until somebody asks for it: a destination is not consent',
    wa?.dayBookEnabled === false, wa);

  console.log('\nO. WHOEVER CONVERTS IT MAY CORRECT IT');
  const id2 = await leadFor('typo', '99999');
  const fixed: any = await leadService.convert(id2, { phone: '+919000011122' });
  made.push(fixed.clientId);
  const fixedSettings = await prisma.clientSettings.findUnique({
    where: { clientId: fixed.clientId }, select: { businessPhone: true }
  });
  check('an override wins over what the lead said', fixedSettings?.businessPhone === '+919000011122', fixedSettings);

  console.log('\nN. ONBOARDING WITHOUT A NUMBER STILL WORKS');
  /* The console can make a workspace from nothing but a name; that path must not have broken. */
  const bare: any = await platformAdminService.onboardClient(
    `Bare ${STAMP}`, 'Owner', `bare-${STAMP}@example.com`
  );
  made.push(bare.clientId);
  const bareSettings = await prisma.clientSettings.findUnique({
    where: { clientId: bare.clientId }, select: { businessPhone: true }
  });
  check('a workspace made with no phone is made anyway', !!bare.clientId, bare.clientId);
  check('...and simply has no number, rather than an empty string', bareSettings?.businessPhone === null, bareSettings);
  const bareWa = await prisma.whatsAppSettings.findUnique({ where: { clientId: bare.clientId } });
  check('...and no Day Book row is invented for it', bareWa === null, bareWa);

  console.log('\nW. ONE WHATSAPP NUMBER, AND IT BELONGS TO THE SHOP');
  /*
   * The question this suite was written to settle. Every document a shop sends leaves from the
   * SHOP's linked number -- `from: { clientId }` -- never from whoever happens to be logged in.
   * Checked against the source, because the alternative is a promise nobody can verify.
   */
  const fs = await import('fs');
  const waService = fs.readFileSync('src/services/whatsapp/service.ts', 'utf8');
  const sends = [...waService.matchAll(/from:\s*(\{\s*clientId[^}]*\}|'scaleezy')/g)].map(m => m[1]);
  check('every send names either the shop or ScaleEzy, and nothing else',
    sends.length > 0 && sends.every(s => s.includes('clientId') || s === "'scaleezy'"), sends);
  check('...and no send is addressed from a signed-in user',
    !/from:\s*\{\s*(userId|actor|user)\b/.test(waService));

  const permissions = (waService.match(/SEND_PERMISSION:\s*Record[\s\S]*?\};/) ?? [''])[0];
  for (const kind of ['PURCHASE_ORDER', 'GOODS_RECEIPT', 'BILL', 'RETURN_NOTE']) {
    check(`sending a ${kind.toLowerCase().replace('_', ' ')} needs its own permission`,
      permissions.includes(kind), permissions.slice(0, 80));
  }
  check('who pressed send is recorded on the message', /sentBy/.test(waService));
  check('and the recipient is stored masked, never in full', /toMasked/.test(waService));

  /*
   * The one way a document leaves from a person's own phone is the SHARE link, which opens
   * WhatsApp on their device and is a deliberate manual fallback for a shop with no number
   * linked -- not an automatic send. Worth pinning so it stays deliberate.
   */
  const client = fs.readFileSync('src/services/whatsapp/client.ts', 'utf8');
  check('a shop with nothing linked is told to share by hand, not silently sent from somewhere else',
    /Use Share on WhatsApp instead/.test(client));
}

main()
  .catch(e => { failures.push(`suite stopped: ${(e as Error).stack ?? e}`); console.log(`\nSTOPPED: ${(e as Error).message}`); })
  .finally(async () => {
    for (const c of made) await platformAdminService.deleteClientCompletely(c, c).catch(() => {});
    await prisma.signupLead.deleteMany({ where: { email: { contains: `-${STAMP}@example.com` } } }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
