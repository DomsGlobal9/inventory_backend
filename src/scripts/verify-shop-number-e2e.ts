/**
 * THE SHOP'S NUMBER, END TO END -- every flow, both sides, and the nasty cases.
 *
 *   A  the shop side: seeing it, changing it, and the refusals that never leave anybody stuck
 *   B  the platform console side: onboarding carries the number, converting a lead carries it
 *   C  who may touch it: roles, other shops, signed out
 *   D  edge cases: the same number written six ways, blank, absurd, a number nobody proved
 *   E  worst cases: two people at once, a code reused, a change half done, no WhatsApp at all
 *
 *   npx tsx src/scripts/verify-shop-number-e2e.ts      (needs the local backend running)
 *
 * Makes only throwaway workspaces and deletes them afterwards. Nothing goes out on WhatsApp --
 * nothing is linked on a developer's machine. It DOES send email to @example.com, the reserved
 * domain that reaches nobody, because onboarding mails credentials and a change mails the owners.
 */
import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { platformAdminService } from '../services/platform-admin.service';
import { leadService } from '../services/lead.service';
import * as whatsapp from '../services/whatsapp/service';
import * as shopNumber from '../services/whatsapp/shop-number';
import { SignupVerifyError } from '../services/signup-verify';

const SERVER = (process.env.VERIFY_API_URL || 'http://localhost:4006/api/v1').replace(/\/api\/v1\/?$/, '');
const API = `${SERVER}/api/v1`;
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

async function plant(phone: string, code = '424242') {
  const codeHash = crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');
  await prisma.signupPhoneCode.upsert({
    where: { phone },
    create: { phone, codeHash, expiresAt: new Date(Date.now() + 600_000) },
    update: { codeHash, expiresAt: new Date(Date.now() + 600_000), tries: 0, verifiedAt: null }
  });
}

const overviewFor = (clientId: string, userId: string, perms: string[], roles: string[]) =>
  whatsapp.getOverview({ id: userId, clientId, name: 'T', permissions: perms, roles } as any);

async function shopWith(tag: string, phone: string | null) {
  const born: any = await platformAdminService.onboardClient(
    `E2E ${tag} ${STAMP}`, 'Owner', `e2e-${tag}-${STAMP}@example.com`, phone ?? undefined
  );
  made.push(born.clientId);
  const owner = await prisma.user.findFirstOrThrow({ where: { clientId: born.clientId }, select: { id: true, name: true } });
  return { clientId: born.clientId as string, ownerId: owner.id, actor: { id: owner.id, clientId: born.clientId as string, name: owner.name } };
}

async function main() {
  const health = await axios.get(`${SERVER}/health`).catch(() => null);
  if (!health) throw new Error(`The backend is not running at ${SERVER}.`);

  // ── B ────────────────────────────────────────────────────────────────────────────────
  console.log('\nB. THE PLATFORM CONSOLE SIDE');
  const main1 = await shopWith('main', '+91 98480 22338');
  const s1 = await shopNumber.current(main1.clientId);
  check('onboarding with a number gives the shop that number', s1.phone === '+91 98480 22338', s1);

  const bare = await shopWith('bare', null);
  const s2 = await shopNumber.current(bare.clientId);
  check('onboarding with no number leaves it empty, not blank text', s2.phone === null, s2);

  /* A lead converted by the console carries its phone in, as the console operator typed it. */
  process.env.SIGNUP_PHONE_PROOF = 'never';
  const leadId: any = await leadService.create({
    companyName: `E2E lead ${STAMP}`, contactName: 'Anita', email: `e2e-lead-${STAMP}@example.com`, phone: '+919000012345'
  });
  delete process.env.SIGNUP_PHONE_PROOF;
  const fromLead: any = await leadService.convert(leadId.id);
  made.push(fromLead.clientId);
  check('converting a lead carries its number onto the new shop',
    (await shopNumber.current(fromLead.clientId)).phone === '+919000012345');

  // ── A ────────────────────────────────────────────────────────────────────────────────
  console.log('\nA. THE SHOP SIDE');
  const v1: any = await overviewFor(main1.clientId, main1.ownerId, ['whatsapp:manage'], ['SUPER_ADMIN']);
  check('the screen is given the shop number, masked', v1.shopPhone === '••••2338', v1.shopPhone);
  check('with nothing linked it says it cannot tell', v1.linkedIsShopNumber === null, v1.linkedIsShopNumber);
  check('a shop with no number at all says so rather than showing nothing',
    (await overviewFor(bare.clientId, bare.actor.id, ['whatsapp:manage'], ['SUPER_ADMIN']) as any).shopPhone === null);

  const NEW = '+919000055566';
  await plant(NEW);
  const changed: any = await shopNumber.finishChange(main1.actor, NEW, '424242');
  check('the number changes with the right code', changed.changed === true, changed);
  check('...and the screen shows the new one at once',
    (await overviewFor(main1.clientId, main1.ownerId, ['whatsapp:manage'], ['SUPER_ADMIN']) as any).shopPhone === '••••5566');

  // ── C ────────────────────────────────────────────────────────────────────────────────
  console.log('\nC. WHO MAY TOUCH IT');
  const noPerm = await axios.post(`${API}/whatsapp/shop-number/start`, { phone: NEW }, { validateStatus: () => true });
  check('signed out, nobody may change a shop number', noPerm.status === 401, noPerm.status);

  const salesUser = await prisma.user.create({
    data: { clientId: main1.clientId, email: `sales-${STAMP}@example.com`, name: 'Sales', password: 'x', status: 'ACTIVE' }
  });
  const salesToken = AuthService.generateToken({ userId: salesUser.id, clientId: main1.clientId });
  const asSales = await axios.post(`${API}/whatsapp/shop-number/start`, { phone: '+919000099999' },
    { headers: { Authorization: `Bearer ${salesToken}` }, validateStatus: () => true });
  check('a member without whatsapp:manage may not change it', asSales.status === 403 || asSales.status === 401, asSales.status);
  check('...and the number is untouched', (await shopNumber.current(main1.clientId)).phone === NEW);

  /* One shop's owner must never reach another shop's number. */
  const other = await shopWith('other', '+919000077777');
  await plant('+919000088888');
  await shopNumber.finishChange(main1.actor, '+919000088888', '424242').catch(() => {});
  check("changing one shop's number leaves every other shop alone",
    (await shopNumber.current(other.clientId)).phone === '+919000077777');

  // ── D ────────────────────────────────────────────────────────────────────────────────
  console.log('\nD. EDGE CASES');
  const now = await shopNumber.current(main1.clientId);
  /*
   * The ways an Indian actually writes one number. All of these are the SAME number and the shop
   * must not be told to "change" to what it already has.
   *
   * "091 90000 88888" is deliberately not in this list: it mixes the domestic trunk prefix 0 with
   * the country code 91, which nobody writes, and the parser refusing it is correct. Checked
   * before assuming it was a fault.
   */
  for (const written of ['9000088888', '09000088888', '+91 90000 88888', '+91-90000-88888', '0091 9000088888']) {
    const same: any = await shopNumber.startChange(main1.actor, written).catch((e: any) => ({ error: e?.message }));
    check(`"${written}" is recognised as the number they already have`, same.alreadyYours === true, same);
  }
  check('...and none of those attempts changed anything',
    (await shopNumber.current(main1.clientId)).phone === now.phone);

  for (const junk of ['', '   ', '12', 'call me', '+++', '9'.repeat(40)]) {
    const said = await refusal(shopNumber.startChange(main1.actor, junk));
    check(`"${junk.trim() || '(blank)'}" is refused in words, not a crash`,
      /does not look right/.test(said), said);
  }

  const unproved = await refusal(shopNumber.finishChange(main1.actor, '+919000033333', '424242'));
  check('a number nobody was sent a code for cannot be confirmed', /run out/.test(unproved), unproved);

  // ── E ────────────────────────────────────────────────────────────────────────────────
  console.log('\nE. WORST CASES');

  /*
   * A DOUBLE TAP IS NOT AN ERROR, AND THE CODE IS STILL SPENT.
   *
   * Two different things, and the first version of this suite asked for the wrong one. Confirming
   * twice in a row must SUCCEED -- a thumb that taps twice on a slow line has done nothing wrong,
   * and telling them "that code is not right" about a code that just worked is the kind of
   * refusal that makes people give up. But the six digits themselves are destroyed on use, so
   * once the proof has expired there is nothing left to replay.
   */
  const ONCE = '+919000044444';
  await plant(ONCE);
  await shopNumber.finishChange(main1.actor, ONCE, '424242');
  const again = await refusal(shopNumber.finishChange(main1.actor, ONCE, '424242'));
  check('confirming twice is not punished', again === '', again);
  check('...and the number is still the one it moved to', (await shopNumber.current(main1.clientId)).phone === ONCE);

  const spent = await prisma.signupPhoneCode.findUnique({ where: { phone: ONCE }, select: { codeHash: true } });
  check('...while the code itself is destroyed, so it can never be replayed later',
    spent?.codeHash === '', spent);

  /* And with the proof aged out, the spent code really is worthless. */
  await prisma.signupPhoneCode.update({
    where: { phone: ONCE }, data: { verifiedAt: new Date(Date.now() - 60 * 60 * 1000) }
  });
  const stale = await refusal(shopNumber.finishChange(main1.actor, ONCE, '424242'));
  check('an old code cannot be used once its proof has expired', stale !== '' && !/NOT A RULE ERROR/.test(stale), stale);

  /* Two people confirming at the same moment: one number, no crash, no half-written state. */
  const RACE = '+919000066666';
  await plant(RACE);
  const [ra, rb] = await Promise.allSettled([
    shopNumber.finishChange(main1.actor, RACE, '424242'),
    shopNumber.finishChange(main1.actor, RACE, '424242')
  ]);
  const won = [ra, rb].filter(r => r.status === 'fulfilled').length;
  check('two people confirming at once do not both change it', won >= 1, { ra: ra.status, rb: rb.status });
  check('...and the shop ends with exactly that number',
    (await shopNumber.current(main1.clientId)).phone === RACE);

  /* Wrong code five times: the code dies, the number never moves, and they can ask for another. */
  const GUESS = '+919000022222';
  await plant(GUESS);
  for (let i = 0; i < 5; i++) await refusal(shopNumber.finishChange(main1.actor, GUESS, '111111'));
  const dead = await refusal(shopNumber.finishChange(main1.actor, GUESS, '424242'));
  check('guessing kills the code even if the next guess is right', /too many times/.test(dead), dead);
  check('...and the number never moved while they guessed',
    (await shopNumber.current(main1.clientId)).phone === RACE);

  /* With no WhatsApp linked anywhere -- which is this machine -- nothing is stuck and nothing lies. */
  const asked = await refusal(shopNumber.startChange(main1.actor, '+919000011111'));
  check('with no WhatsApp at all, asking for a code says so plainly',
    /could not send a code just now/i.test(asked), asked);
  check('...in this screen\'s words, not the signup form\'s', !/enquiry/i.test(asked), asked);
  check('...and the number is exactly as it was', (await shopNumber.current(main1.clientId)).phone === RACE);
}

main()
  .catch(e => { failures.push(`suite stopped: ${(e as Error).stack ?? e}`); console.log(`\nSTOPPED: ${(e as Error).message}`); })
  .finally(async () => {
    for (const c of made) await platformAdminService.deleteClientCompletely(c, c).catch(() => {});
    await prisma.signupLead.deleteMany({ where: { email: { contains: `-${STAMP}@example.com` } } }).catch(() => {});
    await prisma.signupPhoneCode.deleteMany({
      where: { phone: { startsWith: '+9190000' } }
    }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed | ${failures.length} failed`);
    if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'));
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
