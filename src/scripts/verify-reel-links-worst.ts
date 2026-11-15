/**
 * Reel links, the small flows and the worst cases (16 Nov, "test every case small small flows gaps"), against the REAL
 * local server and database. verify-reel-links.ts is the main road; this is everything around it:
 *
 *   search typed with % _ \ ' and a barcode; a colour the piece no longer has; the shop changing its address after
 *   the reel was posted; the shop closed; a person who may only look; a shop with no online address; cloth by the
 *   metre; preview robots of Instagram and Facebook; two people filling the last places at once; titles in Telugu,
 *   Hindi and emoji; the longest title and reel address; a full reel of 12.
 *
 * Everything it changes is put back exactly as it was; every reel link it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-reel-links-worst.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import * as reelLinks from '../services/reel-links';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const SERVER = BASE.replace(/\/api\/v1\/?$/, '');
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }

const demo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../PLAN-help/robot/demo-localcopy.json'), 'utf8'));
const CLIENT: string = demo.clientId;
const OWNER: string = demo.people.owner.token;
const SALES: string = demo.people.sales.token;
const SLUG = 'localshop';
const PORT = new URL(SERVER).port;
const STAMP = Date.now().toString(36);
const T = (s: string) => `RLWORST ${STAMP} ${s}`;
const restore: (() => Promise<unknown>)[] = [];

let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
};
async function api(method: string, p: string, body?: unknown, token: string | null = OWNER) {
  const r = await axios.request({ method, url: `${BASE}${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: 'http://localhost:5183' } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const shop = async (p: string, ua = 'Mozilla/5.0 (iPhone) Instagram 350.0') => {
  const r = await axios.get(`http://127.0.0.1:${PORT}${p}`, { validateStatus: () => true, maxRedirects: 0, timeout: 60_000, headers: { Host: `shop.localhost:${PORT}`, 'User-Agent': ua } });
  return { status: r.status, data: r.data, location: r.headers.location as string | undefined };
};
const tap = (url: string, ua: string) => axios.get(url, { maxRedirects: 0, validateStatus: () => true, headers: { 'User-Agent': ua } });
const search = async (q: string, token = OWNER) => api('GET', `/reel-links/pieces?q=${encodeURIComponent(q)}`, undefined, token);

async function main() {
  const pieces = await prisma.product.findMany({
    where: { clientId: CLIENT, status: 'ACTIVE', trashedAt: null, sellInShop: true, soldBy: 'PIECE', variants: { some: { colorName: { not: null } } } },
    select: { id: true, title: true, productCode: true, variants: { select: { id: true, colorName: true, barcode: true, sku: true } } },
    orderBy: { createdAt: 'asc' }, take: 20
  });
  check('at least 14 published pieces with colours to test with', pieces.length >= 14, pieces.length);
  const [A, B] = pieces;

  console.log('SEARCH, TYPED BADLY');
  const all = (await search('')).data?.length ?? 0;
  for (const q of ['%', '_', '%%', '__', '\\', '\\%', 'saree%', `x'y`, '"', '<script>']) {
    const r = await search(q);
    check(`"${q}" is searched for as typed: no error, not "everything"`, r.status === 200 && Array.isArray(r.data) && (r.data.length === 0 || r.data.length < all || /saree/i.test(q)), { status: r.status, n: r.data?.length, all, m: r.message });
  }
  const pct = await search('saree%');
  check('"saree%" finds only pieces with a real "saree%" in them (none here)', pct.data?.length === 0, pct.data?.map((p: any) => p.title));
  const withBarcode = pieces.flatMap(p => p.variants.map(v => ({ p, v }))).find(x => x.v.barcode);
  if (withBarcode) {
    const r = await search(withBarcode.v.barcode!);
    check('a scanned barcode finds its piece', r.data?.some((p: any) => p.productId === withBarcode.p.id), r.data?.map((p: any) => p.productCode));
  }
  const sku = A.variants[0].sku;
  check('an exact SKU finds its piece, in any letter case', (await search(sku.toLowerCase())).data?.some((p: any) => p.productId === A.id));
  check('a search 500 letters long is cut short, not refused', (await search('a'.repeat(500))).status === 200);

  console.log('\nTITLES AND ADDRESSES AT THEIR LIMITS');
  const telugu = `${STAMP} కంచి పట్టు చీరలు దీపావళి 🪔 दिवाली`;
  const t1 = await api('POST', '/reel-links', { title: telugu, pieces: [A.id] });
  check('a title in Telugu, Hindi and emoji is kept exactly', t1.status === 201 && t1.data.title === telugu, t1);
  const html = (await shop(`/${SLUG}/look/${t1.data.code}`)).data as string;
  check('...and reaches the preview tags intact', String(html).includes(`content="${telugu} · `));
  const long = 'x'.repeat(80);
  const t2 = await api('POST', '/reel-links', { title: long, reelUrl: `https://www.instagram.com/reel/${'a'.repeat(460)}`, pieces: [A.id] });
  check('the longest title (80, no spaces) and a 491-letter reel address are taken', t2.status === 201, t2);
  check('a reel address of 501 letters is refused', (await api('POST', '/reel-links', { title: T('x'), reelUrl: `https://a.com/${'a'.repeat(490)}`, pieces: [A.id] })).status === 400);
  const twelve = await api('POST', '/reel-links', { title: T('twelve'), pieces: pieces.slice(0, 12).map(p => p.id) });
  check('a full reel of 12 pieces is made', twelve.status === 201 && twelve.data.pieces.length === 12, twelve.message);
  const page12 = (await shop(`/_api/shop/${SLUG}/looks/${twelve.data.code}`)).data?.data;
  check('...and the shopper sees all 12', page12?.pieces?.length === 12, page12?.pieces?.length);
  const bio = (await shop(`/_api/shop/${SLUG}/reels`)).data?.data?.reels ?? [];
  check('the bio page lists them all, newest first', bio.slice(0, 3).map((r: any) => r.code).join() === [twelve.data.code, t2.data.code, t1.data.code].join(), bio.slice(0, 3));

  console.log('\nTWO PEOPLE FILLING THE LAST PLACES AT ONCE');
  const ten = await api('POST', '/reel-links', { title: T('ten'), pieces: pieces.slice(0, 10).map(p => p.id) });
  const [x, y] = await Promise.all([
    api('POST', '/reel-links/add', { reelLinkId: ten.data.id, productIds: [pieces[10].id, pieces[11].id] }),
    api('POST', '/reel-links/add', { reelLinkId: ten.data.id, productIds: [pieces[12].id, pieces[13].id] })
  ]);
  const n = (await api('GET', `/reel-links/${ten.data.id}`)).data.pieces.length;
  check('one fits (12), the other is told there is no room; never 14', n === 12 && [x.status, y.status].sort().join() === '200,400', { n, x: x.status, y: y.status, m: x.message || y.message });

  console.log('\nA COLOUR THE PIECE NO LONGER COMES IN');
  const c1 = await api('POST', '/reel-links', { title: T('colour'), pieces: [{ productId: A.id, colour: A.variants.find(v => v.colorName)!.colorName }, B.id] });
  await prisma.reelLinkItem.updateMany({ where: { reelLinkId: c1.data.id, productId: A.id }, data: { colour: 'Ghost colour' } });
  const got = (await api('GET', `/reel-links/${c1.data.id}`)).data;
  check('the screen shows no colour for it (not a colour it cannot save)', got.pieces[0].colour === null, got.pieces[0]);
  const resave = await api('PUT', `/reel-links/${c1.data.id}`, { title: T('colour v2'), pieces: got.pieces.map((p: any) => ({ productId: p.productId, colour: p.colour })) });
  check('...so the reel link can still be saved', resave.status === 200, resave);
  await prisma.reelLinkItem.updateMany({ where: { reelLinkId: c1.data.id, productId: A.id }, data: { colour: 'Ghost colour' } });
  const pubC = (await shop(`/_api/shop/${SLUG}/looks/${c1.data.code}`)).data?.data;
  check('the shopper\'s page gives no reel colour for it (the piece opens on its own first)', pubC?.pieces?.find((p: any) => p.productCode === A.productCode)?.reelColour === null);

  console.log('\nPREVIEW ROBOTS ARE NOT PEOPLE');
  const r0 = (await api('GET', `/reel-links/${t1.data.id}`)).data;
  for (const ua of ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'WhatsApp/2.24.21.80 A', 'Twitterbot/1.0', 'TelegramBot (like TwitterBot)']) await tap(r0.shortUrl, ua);
  check('Instagram/Facebook, WhatsApp, X and Telegram previews: opened still 0', (await api('GET', `/reel-links/${t1.data.id}`)).data.opened === 0);
  await tap(r0.shortUrl, 'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36 Instagram 350.0.0.37.92 Android');
  // The open is written just after the shopper is sent on, so the count may take a moment.
  let opened = 0;
  for (let i = 0; i < 20 && opened !== 1; i++) { await new Promise(r => setTimeout(r, 250)); opened = (await api('GET', `/reel-links/${t1.data.id}`)).data.opened; }
  check('a person in Instagram\'s own browser: opened 1', opened === 1, opened);

  console.log('\nCLOTH BY THE METRE');
  const metre = await prisma.product.findFirst({ where: { clientId: CLIENT, status: 'ACTIVE', trashedAt: null, sellInShop: true, soldBy: 'METRE' }, select: { id: true, productCode: true } });
  if (!metre) check('there is a published fabric sold by the metre', false);
  else {
    const m = await api('POST', '/reel-links', { title: T('metre'), pieces: [metre.id] });
    check('a fabric by the metre can go in a reel link', m.status === 201 && m.data.pieces[0].soldBy === 'METRE', m);
    const pubM = (await shop(`/_api/shop/${SLUG}/looks/${m.data.code}`)).data?.data;
    check('...and the shopper\'s page knows it is by the metre (the page asks for a length)', pubM?.pieces?.[0]?.soldBy === 'METRE');
  }

  console.log('\nA PERSON WHO MAY ONLY LOOK');
  // Through the owner's own roles screen (PATCH /roles/:id), which is what refreshes signed-in people's permissions.
  const rolesNow = (await api('GET', '/roles')).data;
  const salesRole = (rolesNow?.roles ?? rolesNow)?.find((r: any) => r.name === 'SALES');
  if (!salesRole) check('the shop has a SALES role', false, rolesNow);
  else {
    const was: string[] = salesRole.permissions;
    const granted = await api('PATCH', `/roles/${salesRole.id}`, { permissions: [...was, 'reel_link:view'] });
    check('the owner gives Sales "See reel links" on the roles screen', granted.status === 200, granted);
    restore.push(() => api('PATCH', `/roles/${salesRole.id}`, { permissions: was }));
    check('with reel_link:view: sees the list', (await api('GET', '/reel-links', undefined, SALES)).status === 200);
    check('...and one reel link', (await api('GET', `/reel-links/${t1.data.id}`, undefined, SALES)).status === 200);
    const tries = await Promise.all([
      api('POST', '/reel-links', { title: T('sales'), pieces: [A.id] }, SALES),
      api('PUT', `/reel-links/${t1.data.id}`, { title: 'changed by sales' }, SALES),
      api('POST', `/reel-links/${t1.data.id}/off`, undefined, SALES),
      api('DELETE', `/reel-links/${t1.data.id}`, undefined, SALES),
      api('POST', '/reel-links/add', { reelLinkId: t1.data.id, productIds: [B.id] }, SALES),
      search('saree', SALES),
      api('GET', '/reel-links/next-title', undefined, SALES)
    ]);
    check('...but cannot make, change, switch off, delete, add, search pieces or ask for a title (all 403)', tries.every(r => r.status === 403), tries.map(r => r.status));
    check('...and nothing changed', (await prisma.reelLink.findUnique({ where: { id: t1.data.id } }))?.title === telugu);
    await restore.pop()!();
    check('the key taken away again: the list is refused at once', (await api('GET', '/reel-links', undefined, SALES)).status === 403);
  }

  console.log('\nA SHOP WITH NO ONLINE ADDRESS');
  const withShop = (await prisma.onlineShop.findMany({ select: { clientId: true } })).map(s => s.clientId);
  const otherId = (await prisma.product.findFirst({ where: { clientId: { notIn: [CLIENT, ...withShop] } }, select: { clientId: true } }))!.clientId;
  const has = await prisma.onlineShop.findUnique({ where: { clientId: otherId } });
  if (has) check('found a shop without an online address to test with', false, otherId);
  else {
    const ov = await reelLinks.overview(otherId);
    check('overview: not ready, no bio link', ov.shopReady === false && ov.bioUrl === null, ov);
    let msg = '';
    try { await reelLinks.create({ id: 'x', clientId: otherId }, { title: 'x', pieces: [] }); } catch (e: any) { msg = `${e.statusCode} ${e.message}`; }
    check('making one is refused first of all with where to set the address', /^409 .*Settings, Online shop/.test(msg), msg);
  }

  console.log('\nTHE SHOP CHANGES ITS ADDRESS AFTER THE REEL WAS POSTED');
  const os = await prisma.onlineShop.findUnique({ where: { clientId: CLIENT }, select: { slug: true, isLive: true } });
  const newSlug = `rl-${STAMP}`.slice(0, 30);
  restore.push(async () => {
    await api('POST', '/online-shop/address', { slug: os!.slug });
    if (os!.isLive) await api('POST', '/online-shop/open');
  });
  const closed = await api('POST', '/online-shop/close');
  check('the shop is closed (needed to change an address)', closed.status === 200, closed);
  const closedLook = await shop(`/_api/shop/${SLUG}/looks/${t1.data.code}`);
  check('while closed, the reel page says the shop is not open', closedLook.status === 503 && closedLook.data?.state === 'CLOSED', closedLook.data);
  const moved = await api('POST', '/online-shop/address', { slug: newSlug });
  check('the address changed', moved.status === 200, moved);
  const tapped = await tap(r0.shortUrl, 'Mozilla/5.0 (iPhone) Instagram 350.0');
  const hop = await shop(tapped.headers.location!.replace(/^https?:\/\/[^/]+/, ''));
  check('the OLD short link now leads to the NEW address', hop.status === 302 && hop.location?.startsWith(`/${newSlug}/look/${t1.data.code}`), { tap: tapped.headers.location, hop: hop.location });
  check('the screen\'s page address and bio link follow the new address', (await api('GET', `/reel-links/${t1.data.id}`)).data.pageUrl.includes(`/${newSlug}/look/`) && (await api('GET', '/reel-links/overview')).data.bioUrl.endsWith(`/${newSlug}/reels`));
  check('the old address no longer answers for it', (await shop(`/_api/shop/${SLUG}/looks/${t1.data.code}`)).status === 404);
  await restore.pop()!();
  const back = await prisma.onlineShop.findUnique({ where: { clientId: CLIENT }, select: { slug: true, isLive: true } });
  check('the shop is back at its address and open, exactly as before', back?.slug === os!.slug && back?.isLive === os!.isLive, back);
  check('...and the reel page answers there again', (await shop(`/_api/shop/${SLUG}/looks/${t1.data.code}`)).data?.data?.available === true);
}

async function cleanup() {
  while (restore.length) await restore.pop()!().catch(e => console.error('restore failed', e));
  const mine = await prisma.reelLink.findMany({ where: { clientId: CLIENT, OR: [{ title: { startsWith: `RLWORST ${STAMP}` } }, { title: { startsWith: STAMP } }, { title: 'x'.repeat(80) }] }, select: { id: true } });
  const ids = mine.map(m => m.id);
  await prisma.shortLink.deleteMany({ where: { ownerModule: 'reel-links', ownerRef: { in: ids } } });
  await prisma.reelLink.deleteMany({ where: { id: { in: ids } } });
  console.log(`\ncleaned up ${ids.length} reel links`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
