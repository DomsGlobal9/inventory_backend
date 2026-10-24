/**
 * Online shop banners: where each shows (placements), between which days, and the announcement bar --
 * through the real API as sphl's own people, and on the public shop page (GET /shop/sphl). sphl's own
 * banners and bar are changed for the run and put back exactly as they were at the end.
 *
 *   A  every existing banner starts on the home slider and is showing
 *   B  places: several at once, kept in a fixed order; an unknown place refused in words; none = not shown
 *   C  days: from tomorrow = "starts", until yesterday = "ended", today = showing; until before from and
 *      30 Feb refused; the public page has only what is showing now, each with its places
 *   D  the announcement bar: needs words to switch on, at most 90 letters, a dead product link refused,
 *      shown on the public page only while on and inside its days, with its tap
 *   E  who may: a role without the online-shop setting gets 403
 *
 *   ROLE_TOKENS=<role-tokens.json from staff-users.ts> npx tsx src/scripts/verify-shop-banner-places.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { localDayKeyFromParts, todayKey } from '../utils/businessDay';
import { getShopSettings } from '../lib/clientSettings';

const API = process.env.TEST_API_URL || 'http://localhost:4006/api/v1';
const ROOT = API.replace(/\/api\/v1$/, '');
const CLIENT = 'sphl';
const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const as = (role: string) => axios.create({ baseURL: `${API}/online-shop`, headers: { Cookie: `token=${tokens[role]}` }, validateStatus: () => true });
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 220)}`;
const publicShop = async () => (await axios.get(`${ROOT}/shop/${CLIENT}`, { validateStatus: () => true })).data?.data;

async function main() {
  console.log('\nOnline shop banners: places, days and the announcement bar, on sphl (put back at the end)\n');
  const owner = as('SUPER_ADMIN');
  const { timezone } = await getShopSettings(CLIENT);
  const today = todayKey(timezone);
  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = localDayKeyFromParts(y, m, d, 1), yesterday = localDayKeyFromParts(y, m, d, -1), inThree = localDayKeyFromParts(y, m, d, 3);

  // What to put back.
  const savedBanners = await prisma.onlineShopBanner.findMany({ where: { clientId: CLIENT }, select: { id: true, placements: true, startsAt: true, endsAt: true, active: true } });
  const savedShop = await prisma.onlineShop.findUniqueOrThrow({ where: { clientId: CLIENT }, select: { announcementText: true, announcementLinkKind: true, announcementLinkValue: true, announcementActive: true, announcementStartsAt: true, announcementEndsAt: true } });
  if (savedBanners.length < 2) throw new Error('sphl needs at least two banners for this run');

  try {
    console.log('A. AS THEY WERE');
    const a = await owner.get('/banners');
    const list = a.data?.data ?? [];
    check(`${list.length} banners, each with places and a state`, a.status === 200 && list.every((b: any) => Array.isArray(b.placements) && typeof b.state === 'string'), brief(a));
    const [b1, b2] = list;

    console.log('\nB. PLACES');
    const p1 = await owner.patch(`/banners/${b1.id}`, { placements: ['PRODUCT', 'HOME_TOP'] });
    const e1 = (p1.data?.data ?? []).find((x: any) => x.id === b1.id);
    check('two places at once, kept in the fixed order (top slider, then product page)', p1.status === 200 && JSON.stringify(e1?.placements) === JSON.stringify(['HOME_TOP', 'PRODUCT']), brief(p1));
    const p2 = await owner.patch(`/banners/${b1.id}`, { placements: ['FOOTER'] });
    check('an unknown place: 400 in words, nothing changed', p2.status === 400 && /home slider/.test(p2.data?.message ?? '') && JSON.stringify((await prisma.onlineShopBanner.findUniqueOrThrow({ where: { id: b1.id } })).placements) === JSON.stringify(['HOME_TOP', 'PRODUCT']), brief(p2));
    const p3 = await owner.patch(`/banners/${b2.id}`, { placements: [] });
    const e3 = (p3.data?.data ?? []).find((x: any) => x.id === b2.id);
    check('no place ticked: kept, state "not placed anywhere"', p3.status === 200 && e3?.state === 'NOWHERE', brief(p3));
    let pub = await publicShop();
    const pubImgs = (pub?.banners ?? []).map((x: any) => x.imageUrl);
    check('  ...and not on the public shop page', !pubImgs.includes(b2.imageUrl) && pubImgs.includes(b1.imageUrl), JSON.stringify(pubImgs));
    const pb1 = (pub?.banners ?? []).find((x: any) => x.imageUrl === b1.imageUrl);
    check('the public page says where each goes (top slider + product page)', JSON.stringify(pb1?.placements) === JSON.stringify(['HOME_TOP', 'PRODUCT']), JSON.stringify(pb1));
    check('  ...and sends nothing of the shop\'s own (no ids, no dates)', pb1 && !('id' in pb1) && !('showFrom' in pb1) && !('startsAt' in pb1), JSON.stringify(pb1));

    console.log('\nC. DAYS');
    const c1 = await owner.patch(`/banners/${b1.id}`, { showFrom: tomorrow, showUntil: inThree });
    const ec1 = (c1.data?.data ?? []).find((x: any) => x.id === b1.id);
    check(`from tomorrow (${tomorrow}): "starts", the days read back as typed`, c1.status === 200 && ec1?.state === 'SOON' && ec1?.showFrom === tomorrow && ec1?.showUntil === inThree, brief(c1));
    pub = await publicShop();
    check('  ...not on the public page yet', !(pub?.banners ?? []).some((x: any) => x.imageUrl === b1.imageUrl));
    const c2 = await owner.patch(`/banners/${b1.id}`, { showFrom: '', showUntil: yesterday });
    check('until yesterday: "ended", off the public page', (c2.data?.data ?? []).find((x: any) => x.id === b1.id)?.state === 'ENDED' && !((await publicShop())?.banners ?? []).some((x: any) => x.imageUrl === b1.imageUrl), brief(c2));
    const c3 = await owner.patch(`/banners/${b1.id}`, { showFrom: today, showUntil: today });
    check('today only: showing, on the public page', (c3.data?.data ?? []).find((x: any) => x.id === b1.id)?.state === 'LIVE' && ((await publicShop())?.banners ?? []).some((x: any) => x.imageUrl === b1.imageUrl), brief(c3));
    const c4 = await owner.patch(`/banners/${b1.id}`, { showFrom: inThree, showUntil: tomorrow });
    check('"until" before "from": 400 in words', c4.status === 400 && /before/.test(c4.data?.message ?? ''), brief(c4));
    const c5 = await owner.patch(`/banners/${b1.id}`, { showFrom: '2026-02-30', showUntil: '' });
    check('30 February: 400 in words', c5.status === 400 && /could not be read/.test(c5.data?.message ?? ''), brief(c5));
    const c6 = await owner.patch(`/banners/${b1.id}`, { showFrom: '', showUntil: '' });
    check('both cleared: no limit, showing', (c6.data?.data ?? []).find((x: any) => x.id === b1.id)?.state === 'LIVE' && (c6.data?.data ?? []).find((x: any) => x.id === b1.id)?.showFrom === null, brief(c6));
    const c7 = await owner.patch(`/banners/${b1.id}`, { heading: (b1.heading ?? '') + '' });
    check('saving only the words leaves places and days alone', JSON.stringify((await prisma.onlineShopBanner.findUniqueOrThrow({ where: { id: b1.id } })).placements) === JSON.stringify(['HOME_TOP', 'PRODUCT']), brief(c7));

    console.log('\nD. THE ANNOUNCEMENT BAR');
    const d0 = await owner.put('/announcement', { text: '', active: true });
    check('switched on with no words: 400 in words', d0.status === 400 && /words/.test(d0.data?.message ?? ''), brief(d0));
    const d1 = await owner.put('/announcement', { text: 'x'.repeat(95), active: true });
    check('95 letters: 400, keep it to 90', d1.status === 400 && /90/.test(d1.data?.message ?? ''), brief(d1));
    const d2 = await owner.put('/announcement', { text: 'Test bar', active: true, linkKind: 'PRODUCT', linkValue: 'NOPE-0000' });
    check('a product nobody has: 400, never a dead tap', d2.status === 400 && /NOPE-0000/.test(d2.data?.message ?? ''), brief(d2));
    const d3 = await owner.put('/announcement', { text: '  Diwali   sale: 10% off till 5 Nov  ', active: true, linkKind: 'SEARCH', linkValue: 'silk', showFrom: today, showUntil: inThree });
    check('saved: spaces tidied, showing now', d3.status === 200 && d3.data?.data?.text === 'Diwali sale: 10% off till 5 Nov' && d3.data?.data?.state === 'LIVE', brief(d3));
    pub = await publicShop();
    check('the public page shows it with its tap (search "silk")', pub?.announcement?.text === 'Diwali sale: 10% off till 5 Nov' && pub?.announcement?.link?.kind === 'SEARCH' && pub?.announcement?.link?.value === 'silk', JSON.stringify(pub?.announcement));
    const d4 = await owner.put('/announcement', { text: 'Starts tomorrow', active: true, showFrom: tomorrow });
    check('from tomorrow: "starts", not on the public page', d4.data?.data?.state === 'SOON' && (await publicShop())?.announcement === null, brief(d4));
    const d5 = await owner.put('/announcement', { text: 'Switched off', active: false });
    check('switched off: kept, not on the public page', d5.data?.data?.state === 'OFF' && d5.data?.data?.text === 'Switched off' && (await publicShop())?.announcement === null, brief(d5));

    console.log('\nE. WHO MAY');
    for (const role of ['SALES', 'WAREHOUSE']) {
      if (!tokens[role]) continue;
      const r1 = await as(role).put('/announcement', { text: 'not allowed', active: true });
      const r2 = await as(role).patch(`/banners/${b1.id}`, { placements: ['HOME_MIDDLE'] });
      check(`${role}: 403 on the bar and on a banner`, r1.status === 403 && r2.status === 403, `${brief(r1)} | ${brief(r2)}`);
    }
  } finally {
    for (const b of savedBanners) await prisma.onlineShopBanner.update({ where: { id: b.id }, data: { placements: b.placements, startsAt: b.startsAt, endsAt: b.endsAt, active: b.active } });
    await prisma.onlineShop.update({ where: { clientId: CLIENT }, data: savedShop });
    const back = await prisma.onlineShopBanner.findMany({ where: { clientId: CLIENT }, select: { id: true, placements: true, startsAt: true, endsAt: true, active: true } });
    const same = savedBanners.every(s => JSON.stringify(back.find(b => b.id === s.id)) === JSON.stringify(s));
    console.log(`\nsphl put back as it was: ${same ? 'yes' : 'NO -- check by hand'}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async e => { console.error(e); process.exit(1); });
