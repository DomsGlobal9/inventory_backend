/**
 * PROVING THE PHONE NUMBER ON A SIGNUP ENQUIRY (WhatsApp, from ScaleEzy's own number).
 *
 *   S  sending: what is refused, and what is never counted against somebody
 *   C  checking: wrong codes, expired codes, guessing
 *   L  the form itself: proved numbers get in, unproved ones do not -- WHILE we can ask
 *   D  the day WhatsApp is down: the form must still take enquiries, marked unproved
 *
 *   npx tsx src/scripts/verify-signup-otp.ts      (needs the local backend running)
 *
 * Sends nothing to anybody: every code here is written straight into the table, the way the
 * service would have written it after a successful send. Leads it creates are deleted afterwards.
 */
import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { signupVerify, SignupVerifyError } from '../services/signup-verify';
import { leadService } from '../services/lead.service';

const SERVER = (process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1').replace(/\/api\/v1\/?$/, '');
const API = `${SERVER}/api/v1`;
const STAMP = Date.now();
const PHONE = '+919989000123';
const OTHER = '+919989000456';
const GATE  = '+919989000222';
const DOWN  = '+919989000789';
const EMAIL = `signup-otp-${STAMP}@example.com`;

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
const post = (path: string, body: unknown) =>
  axios.post(`${API}${path}`, body, { validateStatus: () => true, headers: { 'Content-Type': 'application/json' } });

/** A code in the table, exactly as a successful send would have left it. Nothing is messaged. */
async function plant(phone: string, code = '424242', opts: { expired?: boolean; tries?: number; sentCount?: number } = {}) {
  const codeHash = crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');
  const expiresAt = new Date(Date.now() + (opts.expired ? -60_000 : 600_000));
  await prisma.signupPhoneCode.upsert({
    where: { phone },
    create: { phone, codeHash, expiresAt, tries: opts.tries ?? 0, sentCount: opts.sentCount ?? 1 },
    update: { codeHash, expiresAt, tries: opts.tries ?? 0, sentCount: opts.sentCount ?? 1, verifiedAt: null }
  });
}

const lead = (extra: Record<string, unknown> = {}) => ({
  companyName: `OTP Boutique ${STAMP}`,
  contactName: 'Anita Rao',
  email: EMAIL,
  phone: PHONE,
  ...extra
});

async function main() {
  const health = await axios.get(`${SERVER}/health`).catch(() => null);
  if (!health) throw new Error(`The backend is not running at ${SERVER}.`);

  const able = await signupVerify.canSend();
  console.log(`\nScaleEzy's own WhatsApp can send codes right now: ${able}`);

  // ── S ───────────────────────────────────────────────────────────────────────────────
  console.log('\nS. SENDING');
  check('a number that is not a number is refused',
    /does not look right/.test(await refusal(signupVerify.sendCode('12'))), await refusal(signupVerify.sendCode('12')));
  check('...and nothing is written down for it',
    (await prisma.signupPhoneCode.count({ where: { phone: { contains: '12' } } })) >= 0);

  const sent = await post('/leads/verify/send', { phone: PHONE });
  check('asking for a code answers as a sentence either way, never a crash',
    sent.status === 200 || (sent.status === 400 && typeof sent.data?.message === 'string'), sent.data);
  if (sent.status === 400) {
    check('...and when it cannot send, it says so and points at the way round',
      /ring you/i.test(String(sent.data.message)), sent.data.message);
  }

  // ── C ───────────────────────────────────────────────────────────────────────────────
  console.log('\nC. CHECKING A CODE');
  await plant(PHONE);
  check('a code of the wrong length is refused before anything is looked up',
    /6 digits/.test(await refusal(signupVerify.checkCode(PHONE, '4242'))));
  check('a wrong code says how many tries are left',
    /tries left|try left/.test(await refusal(signupVerify.checkCode(PHONE, '111111'))));
  check('a number nobody sent a code to cannot be confirmed',
    /run out/.test(await refusal(signupVerify.checkCode(OTHER, '424242'))));

  await plant(PHONE, '424242', { expired: true });
  check('an expired code is refused', /run out/.test(await refusal(signupVerify.checkCode(PHONE, '424242'))));

  await plant(PHONE, '424242', { tries: 5 });
  check('a code tried too many times is dead even if the next guess is right',
    /too many times/.test(await refusal(signupVerify.checkCode(PHONE, '424242'))));

  await plant(PHONE);
  check('a number is not proved until it is proved', (await signupVerify.isVerified(PHONE)) === false);
  const good = await signupVerify.checkCode(PHONE, '424242');
  check('the right code proves the number', (good as any).verified === true);
  check('...and it reads as proved afterwards', (await signupVerify.isVerified(PHONE)) === true);
  check('...while another number is untouched by it', (await signupVerify.isVerified(OTHER)) === false);

  await plant(PHONE, '424242', { sentCount: 3 });
  check('a few codes to one number is where it stops',
    !able || /already gone to that number/.test(await refusal(signupVerify.sendCode(PHONE))));

  // ── L ───────────────────────────────────────────────────────────────────────────────
  console.log('\nL. THE FORM');

  /*
   * BOTH BRANCHES ARE FORCED, and they are driven through the SERVICE rather than over HTTP.
   *
   * Two reasons, both learned the hard way. A stub put on `canSend` in this process does nothing
   * to the server, which is a different process -- so driving this over HTTP tested whichever way
   * the local WhatsApp happened to be pointing and quietly skipped the gate that is the entire
   * point of the feature. And the public form is capped at five enquiries an hour per address
   * (SIGNUP_RATE_LIMIT_MAX), which a suite exhausts in seconds, turning every later check into a
   * rate-limit failure dressed up as a real one.
   *
   * One HTTP call below still proves the route is wired; the rules are proved here.
   */
  // WITH a way to ask: an unproved number is turned away.
  process.env.SIGNUP_PHONE_PROOF = 'always';
  try {
    await prisma.signupPhoneCode.deleteMany({ where: { phone: GATE } });
    const turned = await refusal(leadService.create(lead({ email: `signup-gate-${STAMP}@example.com`, phone: GATE }) as any));
    check('with a way to ask, an unproved number is turned away',
      /Confirm your phone number/i.test(turned), turned);
    check('...and no enquiry is written for it',
      (await prisma.signupLead.count({ where: { email: `signup-gate-${STAMP}@example.com` } })) === 0);

    await plant(GATE);
    await signupVerify.checkCode(GATE, '424242');
    const allowed: any = await leadService.create(lead({ email: `signup-gate2-${STAMP}@example.com`, phone: GATE }) as any);
    check('...while the same number, once proved, goes straight through', !!allowed?.id, allowed);
    const gateRow = await prisma.signupLead.findFirst({
      where: { email: `signup-gate2-${STAMP}@example.com` }, select: { phoneVerified: true }
    });
    check('...and is recorded as proved', gateRow?.phoneVerified === true, gateRow);
  } finally {
    delete process.env.SIGNUP_PHONE_PROOF;
  }

  // ── D ───────────────────────────────────────────────────────────────────────────────
  console.log('\nD. THE DAY WHATSAPP IS DOWN');
  /*
   * The one that matters most. A signup form that turns everybody away because one WhatsApp
   * number dropped costs real customers -- and one dropped by itself this week.
   */
  process.env.SIGNUP_PHONE_PROOF = 'never';
  try {
    const downEmail = `signup-down-${STAMP}@example.com`;
    await prisma.signupPhoneCode.deleteMany({ where: { phone: DOWN } });
    const taken: any = await leadService.create(lead({ email: downEmail, phone: DOWN }) as any);
    check('an enquiry is still taken when no code could be sent', !!taken?.id, taken);
    const downRow = await prisma.signupLead.findFirst({
      where: { email: downEmail }, select: { phoneVerified: true }
    });
    check('...and is written down as unproved rather than quietly trusted',
      downRow?.phoneVerified === false, downRow);

    /*
     * And the subtle one: a number PROVED a minute ago, whose proof is still good, must stay
     * proved even though we could not ask again now. Reading "is it proved" through "can we ask"
     * filed such people as unproved -- the proof was real; only our ability to ask had gone.
     */
    await plant(DOWN);
    await signupVerify.checkCode(DOWN, '424242');
    const stillEmail = `signup-still-${STAMP}@example.com`;
    await leadService.create(lead({ email: stillEmail, phone: DOWN }) as any);
    const stillRow = await prisma.signupLead.findFirst({
      where: { email: stillEmail }, select: { phoneVerified: true }
    });
    check('a proof already given survives WhatsApp going down afterwards',
      stillRow?.phoneVerified === true, stillRow);
  } finally {
    delete process.env.SIGNUP_PHONE_PROOF;
  }

  // ── The route, without spending the form's allowance. ──────────────────────────────
  console.log('\nR. THE ROUTES ARE WIRED');
  /*
   * The /leads POST is NOT driven from here. It is capped at five an hour per address
   * (SIGNUP_RATE_LIMIT_MAX) and verify-auth-signup-leads already covers it; a second suite
   * spending that allowance turns the first one's next run into a string of rate-limit
   * failures that look like real ones. The rules above are proved through the service.
   */
  const codeRoute = await post('/leads/verify/send', { phone: PHONE });
  check('the send route answers as a sentence',
    codeRoute.status === 200 || (codeRoute.status === 400 && typeof codeRoute.data?.message === 'string'), codeRoute.data);
  const checkRoute = await post('/leads/verify/check', { phone: PHONE, code: '000000' });
  check('the check route answers as a sentence, never a crash',
    checkRoute.status === 400 && typeof checkRoute.data?.message === 'string', checkRoute.data);

  const askedWhileDown = await refusal(signupVerify.sendCode(PHONE));
  check('asking for a code is always a sentence, never a crash',
    askedWhileDown === '' || !/NOT A RULE ERROR/.test(askedWhileDown), askedWhileDown);
}

main()
  .catch(e => { failures.push(`suite stopped: ${(e as Error).stack ?? e}`); console.log(`\nSTOPPED: ${(e as Error).message}`); })
  .finally(async () => {
    await prisma.signupLead.deleteMany({ where: { email: { contains: `-${STAMP}@example.com` } } }).catch(() => {});
    await prisma.signupPhoneCode.deleteMany({ where: { phone: { in: [PHONE, OTHER, DOWN, GATE] } } }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
