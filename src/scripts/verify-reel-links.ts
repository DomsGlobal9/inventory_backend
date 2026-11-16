/**
 * Reel links end to end against the REAL local server and database (PLAN-reel-links.md): the shop's screens' API,
 * the short link a shopper taps, the /_look hop, the shopper's page and the bio page, and the worst cases -- other
 * shops' pieces and codes, pieces that stop being sellable after the reel was made, switched-off and deleted links,
 * two people saving at once, robots counted apart, and the link never changing.
 *
 * Uses the local test shop (verify-suites-tenant, online shop "localshop") and the people in
 * PLAN-help/robot/demo-localcopy.json. Every reel link it makes is removed at the end, and every product it touches is
 * put back exactly as it was. Local database and server only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-reel-links.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import * as R from '../services/links/rules';

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
const SHOP_HOST = `http://shop.localhost:${new URL(SERVER).port}`;
const STAMP = Date.now().toString(36);
const T = (s: string) => `RLTEST ${STAMP} ${s}`;
const made: string[] = [];
const restore: (() => Promise<unknown>)[] = [];

let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
};

async function api(method: string, path: string, body?: unknown, token: string | null = OWNER) {
  const r = await axios.request({
    method, url: `${BASE}${path}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: 'http://localhost:5183' }
  });
  if (r.status < 300 && r.data?.data?.id && method === 'POST' && !made.includes(r.data.data.id)) made.push(r.data.data.id);
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const shop = async (path: string, opts: { ua?: string; follow?: boolean } = {}) => {
  // Node cannot look up *.localhost names (browsers can): reach this computer and name the shop host, as the shop's
  // own development server does.
  const r = await axios.get(`http://127.0.0.1:${new URL(SERVER).port}${path}`, {
    validateStatus: () => true, maxRedirects: opts.follow ? 5 : 0, timeout: 60_000,
    headers: { Host: new URL(SHOP_HOST).host, 'User-Agent': opts.ua ?? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36 Instagram 350.0' }
  });
  return { status: r.status, data: r.data, location: r.headers.location as string | undefined };
};
const look = async (code: string, slug = SLUG) => (await shop(`/_api/shop/${slug}/looks/${code}`)).data?.data;
const tap = (shortUrl: string, ua: string) => axios.get(shortUrl, { maxRedirects: 0, validateStatus: () => true, headers: { 'User-Agent': ua } });
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 350.0';
const WHATSAPP_BOT = 'WhatsApp/2.24.21.80 A';

async function main() {
  console.log('PIECES FOR THE TEST');
  const all = (await api('GET', '/reel-links/pieces?q=')).data as any[];
  const many = (await prisma.product.findMany({
    where: { clientId: CLIENT, status: 'ACTIVE', trashedAt: null, sellInShop: true, soldBy: 'PIECE' },
    select: { id: true, productCode: true, title: true, variants: { select: { colorName: true, stocks: { select: { quantity: true, reservedQty: true } } } } }, take: 40, orderBy: { createdAt: 'asc' }
  }));
  // A, B and C must have something to sell: the "sold-out piece is shown last" check counts on only that one being out.
  const free = (p: (typeof many)[number]) => p.variants.some(v => v.stocks.some(s => s.quantity - s.reservedQty > 0));
  const withColour = many.filter(p => p.variants.some(v => v.colorName) && free(p));
  check('the test shop has at least 16 published pieces to use', many.length >= 16 && withColour.length >= 3, { many: many.length, withColour: withColour.length });
  const [A, B, C] = withColour;
  const rest = many.filter(p => ![A.id, B.id, C.id].includes(p.id));
  check('piece search answers for the shop (published pieces only)', Array.isArray(all) && all.length > 0 && all.every(p => p.hidden === null), all?.slice?.(0, 2));
  const soldOutId = (all ?? []).find(p => p.inStock === 0 && p.soldBy === 'PIECE')?.productId
    ?? (await prisma.product.findFirst({ where: { clientId: CLIENT, status: 'ACTIVE', trashedAt: null, sellInShop: true, soldBy: 'PIECE', variants: { every: { stocks: { every: { quantity: { lte: 0 } } } } } }, select: { id: true } }))?.id;
  check('there is a sold-out published piece to test with', !!soldOutId);
  const other = await prisma.product.findFirst({ where: { clientId: { not: CLIENT }, status: 'ACTIVE', trashedAt: null }, select: { id: true } });

  console.log('\nWHO MAY DO WHAT');
  check('no sign-in: refused', (await api('GET', '/reel-links', undefined, null)).status === 401);
  const salesList = await api('GET', '/reel-links', undefined, SALES);
  check('a salesperson (no reel link permission) cannot see the list', salesList.status === 403, salesList);
  const salesMake = await api('POST', '/reel-links', { title: T('sales'), pieces: [A.id] }, SALES);
  check('...or make one', salesMake.status === 403, salesMake);
  check('...or search pieces', (await api('GET', '/reel-links/pieces?q=a', undefined, SALES)).status === 403);
  const ov = await api('GET', '/reel-links/overview');
  check('the owner sees the overview: shop ready, bio link on the shop address', ov.status === 200 && ov.data.shopReady === true && ov.data.bioUrl === `${SHOP_HOST}/${SLUG}/reels` && ov.data.shortLinks === true, ov);

  console.log('\nMAKING ONE: WHAT IS REFUSED');
  const before = await prisma.reelLink.count({ where: { clientId: CLIENT } });
  const tries: [string, any, RegExp][] = [
    ['no title', { title: '   ', pieces: [A.id] }, /title/i],
    ['a title of 81 letters', { title: 'x'.repeat(81), pieces: [A.id] }, /80 letters/],
    ['no pieces', { title: T('x'), pieces: [] }, /at least one piece/],
    ['pieces not a list', { title: T('x'), pieces: 'abc' }, /Choose the pieces/],
    ['13 pieces', { title: T('x'), pieces: [A, B, C, ...rest].slice(0, 13).map(p => p.id) }, /up to 12/],
    ['a reel address on plain http', { title: T('x'), reelUrl: 'http://www.instagram.com/reel/abc', pieces: [A.id] }, /https/],
    ['a reel address that is not one', { title: T('x'), reelUrl: 'instagram reel 12', pieces: [A.id] }, /not a web address/],
    ['a reel address with a password in it', { title: T('x'), reelUrl: 'https://me:secret@instagram.com/reel/abc', pieces: [A.id] }, /password/],
    ['a colour the piece does not come in', { title: T('x'), pieces: [{ productId: A.id, colour: 'Ultraviolet' }] }, /does not come in Ultraviolet/],
    ['a piece id that does not exist', { title: T('x'), pieces: ['00000000-0000-0000-0000-000000000000'] }, /no longer in your products/]
  ];
  if (other) tries.push(['ANOTHER shop\'s piece (reads exactly like a missing one)', { title: T('x'), pieces: [other.id] }, /no longer in your products/]);
  for (const [name, body, msg] of tries) {
    const r = await api('POST', '/reel-links', body);
    check(`${name}: refused in words`, r.status === 400 && msg.test(r.message ?? ''), r);
  }
  check('...and none of those made anything', before === (await prisma.reelLink.count({ where: { clientId: CLIENT } })));

  // A piece that is in the bin, a material and a draft: changed for a moment, put back at the end.
  const D = rest[0], E = rest[1], F = rest[2];
  const orig = await prisma.product.findMany({ where: { id: { in: [D.id, E.id, F.id] } }, select: { id: true, status: true, trashedAt: true, sellInShop: true } });
  restore.push(() => Promise.all(orig.map(o => prisma.product.update({ where: { id: o.id }, data: { status: o.status, trashedAt: o.trashedAt, sellInShop: o.sellInShop } }))));
  await prisma.product.update({ where: { id: D.id }, data: { trashedAt: new Date() } });
  await prisma.product.update({ where: { id: E.id }, data: { sellInShop: false } });
  await prisma.product.update({ where: { id: F.id }, data: { status: 'DRAFT' } });
  check('a piece in the bin is refused', /in the bin/.test((await api('POST', '/reel-links', { title: T('x'), pieces: [D.id] })).message ?? ''));
  check('a material is refused', /material/.test((await api('POST', '/reel-links', { title: T('x'), pieces: [E.id] })).message ?? ''));
  check('a draft is refused', /not published/.test((await api('POST', '/reel-links', { title: T('x'), pieces: [F.id] })).message ?? ''));
  const search = (await api('GET', `/reel-links/pieces?q=${encodeURIComponent(D.productCode)}`)).data as any[];
  check('search leaves out the piece in the bin', !search.some(p => p.productId === D.id), search);
  await restore.pop()!();

  console.log('\nMAKING ONE');
  const colA = A.variants.find(v => v.colorName)!.colorName!;
  const r1 = await api('POST', '/reel-links', {
    title: `  ${T('Diwali')}   edit `, reelUrl: 'https://www.instagram.com/reel/C0ffee123/',
    pieces: [{ productId: A.id, colour: colA.toUpperCase() }, B.id, B.id, C.id, ...(soldOutId ? [soldOutId] : [])]
  });
  const L1 = r1.data;
  check('made: 201, the title tidied, the reel address kept', r1.status === 201 && L1.title === `${T('Diwali')} edit` && L1.reelUrl === 'https://www.instagram.com/reel/C0ffee123/', r1);
  check('the same piece twice is kept once', L1.pieces.filter((p: any) => p.productId === B.id).length === 1, L1.pieces.map((p: any) => p.productId));
  check('the colour is kept in the piece\'s own spelling ("MAROON" -> its colour)', L1.pieces[0].colour === colA, L1.pieces[0]);
  check('the pieces are in the order sent', L1.pieces.map((p: any) => p.productId).join() === [A.id, B.id, C.id, ...(soldOutId ? [soldOutId] : [])].join());
  check('it has a short link on this server (/l/<7 letters>)', /^http:\/\/localhost:\d+\/l\/[A-Za-z0-9]{7}$/.test(L1.shortUrl ?? ''), L1.shortUrl);
  check('...and the full page address on the shop', L1.pageUrl === `${SHOP_HOST}/${SLUG}/look/${L1.code}`, L1.pageUrl);
  const sl = await prisma.shortLink.findFirst({ where: { ownerModule: 'reel-links', ownerRef: L1.id } });
  check('the short link never ends (year 2100), points at /_look/<code>, owned by reel-links', !!sl && sl.expiresAt.getUTCFullYear() === 2100 && sl.target === `${SHOP_HOST}/_look/${L1.code}` && sl.targetType === 'CAMPAIGN', sl);

  console.log('\nTHE SHOPPER: TAP, HOP, PAGE');
  const robot = await tap(L1.shortUrl, WHATSAPP_BOT);
  const human = await tap(L1.shortUrl, PHONE);
  check('a tap sends the shopper to /_look/<code> with the tap mark (?sz=)', human.status === 302 && human.headers.location === `${SHOP_HOST}/_look/${L1.code}?sz=${sl!.code}`, { s: human.status, l: human.headers.location });
  const hop = await shop(`/_look/${L1.code}?sz=${sl!.code}`);
  check('/_look sends it on to the shop\'s current address, keeping the mark', hop.status === 302 && hop.location === `/${SLUG}/look/${L1.code}?sz=${sl!.code}`, hop);
  const hopJunk = await shop(`/_look/${L1.code}?sz=<script>`);
  check('...a mark that is not a link code is dropped', hopJunk.status === 302 && hopJunk.location === `/${SLUG}/look/${L1.code}`, hopJunk);
  check('an unknown code on /_look gets the app, not an error or a redirect', (await shop('/_look/ZZZZZZZ')).status === 200);
  check('a made-up shape on /_look gets the app too', (await shop('/_look/..%2F..%2Fetc')).status !== 302);
  const listed = (await api('GET', '/reel-links')).data.find((r: any) => r.id === L1.id);
  check('the list counts the person, not WhatsApp\'s preview robot (opened = 1)', listed?.opened === 1 && robot.status !== 500, listed);

  const page1 = await look(L1.code);
  check('the page: available, the title, every piece', page1.available === true && page1.title === L1.title && page1.pieces.length === L1.pieces.length, page1);
  check('each piece carries the colour worn in the reel', page1.pieces.find((p: any) => p.productCode === A.productCode)?.reelColour === colA);
  if (soldOutId) {
    const last = page1.pieces[page1.pieces.length - 1];
    check('the sold-out piece is shown, last', !last.variants.some((v: any) => v.sellable) && page1.pieces.slice(0, -1).every((p: any) => p.variants.some((v: any) => v.sellable)), page1.pieces.map((p: any) => [p.productCode, p.variants.some((v: any) => v.sellable)]));
  }
  check('nothing the shop keeps to itself is on the page (no cost, no stock count, no client id)', !/costPrice|averageCost|purchase|clientId|quantity"/i.test(JSON.stringify(page1)));
  const html = (await shop(`/${SLUG}/look/${L1.code}`)).data as string;
  check('the preview tags name the reel and the shop', typeof html === 'string' && html.includes(`<meta property="og:title" content="${L1.title} · `), String(html).slice(0, 200));
  check('another shop\'s address with this code: not found', (await shop(`/_api/shop/not-a-shop-${STAMP}/looks/${L1.code}`)).status === 404);
  check('a code of the wrong shape: not found', (await shop(`/_api/shop/${SLUG}/looks/abc`)).status === 404);
  check('a code that does not exist: not found', (await shop(`/_api/shop/${SLUG}/looks/ZZZZZZZ`)).status === 404);

  console.log('\nCHANGING IT: THE LINK STAYS THE SAME');
  const r2 = await api('PUT', `/reel-links/${L1.id}`, { title: T('Diwali v2'), pieces: [C.id, A.id] });
  check('saved: new title, new order, same code, same short link', r2.status === 200 && r2.data.title === T('Diwali v2') && r2.data.code === L1.code && r2.data.shortUrl === L1.shortUrl && r2.data.pieces.map((p: any) => p.productId).join() === [C.id, A.id].join(), r2);
  check('the colour of a piece not sent again is dropped with it; A\'s colour back to its own first', r2.data.pieces[1].colour === null);
  const page2 = await look(L1.code);
  check('the shopper\'s page follows at once', page2.pieces.map((p: any) => p.productCode).join() === [C.productCode, A.productCode].join() && page2.title === T('Diwali v2'), page2.pieces?.map((p: any) => p.productCode));
  check('only the title: the pieces stay', (await api('PUT', `/reel-links/${L1.id}`, { title: T('Diwali v3') })).data?.pieces?.length === 2);
  check('saving with no pieces is refused (the reel link would be empty)', (await api('PUT', `/reel-links/${L1.id}`, { pieces: [] })).status === 400);

  console.log('\nPIECES THAT STOP BEING SELLABLE AFTER THE REEL');
  const origC = await prisma.product.findUnique({ where: { id: C.id }, select: { status: true } });
  restore.push(() => prisma.product.update({ where: { id: C.id }, data: { status: origC!.status } }));
  await prisma.product.update({ where: { id: C.id }, data: { status: 'DRAFT' } });
  const page3 = await look(L1.code);
  check('a piece unpublished since: left out of the page, the rest still there', page3.available === true && page3.pieces.map((p: any) => p.productCode).join() === A.productCode, page3.pieces?.map((p: any) => p.productCode));
  const ed = (await api('GET', `/reel-links/${L1.id}`)).data;
  check('...and the shop\'s screen says why', ed.pieces.find((p: any) => p.productId === C.id)?.hidden === 'Not published', ed.pieces);
  const origA = await prisma.product.findUnique({ where: { id: A.id }, select: { sellInShop: true } });
  restore.push(() => prisma.product.update({ where: { id: A.id }, data: { sellInShop: origA!.sellInShop } }));
  await prisma.product.update({ where: { id: A.id }, data: { sellInShop: false } });
  const page4 = await look(L1.code);
  check('every piece gone: "no longer available" with new arrivals, never empty', page4.available === false && page4.pieces.length === 0 && Array.isArray(page4.newArrivals) && page4.newArrivals.length > 0, page4);
  check('...and it leaves the bio page', !(await shop(`/_api/shop/${SLUG}/reels`)).data.data.reels.some((r: any) => r.code === L1.code));
  while (restore.length) await restore.pop()!();
  check('pieces put back: the page is whole again', (await look(L1.code)).pieces.length === 2);

  console.log('\nSWITCH OFF, ON, DELETE');
  const off = await api('POST', `/reel-links/${L1.id}/off`);
  check('switched off', off.status === 200 && off.data.active === false);
  const pOff = await look(L1.code);
  check('...the page says no longer available, with new arrivals', pOff.available === false && pOff.newArrivals?.length > 0 && pOff.title === null, pOff);
  check('...the short link itself still works (the page explains)', (await tap(L1.shortUrl, PHONE)).status === 302);
  check('...gone from the bio page', !(await shop(`/_api/shop/${SLUG}/reels`)).data.data.reels.some((r: any) => r.code === L1.code));
  check('switched on: back', (await api('POST', `/reel-links/${L1.id}/on`)).data.active === true && (await look(L1.code)).available === true);

  console.log('\nTHE BIO PAGE');
  const r3 = await api('POST', '/reel-links', { title: T('Second'), pieces: [B.id] });
  const bio = (await shop(`/_api/shop/${SLUG}/reels`)).data.data.reels as any[];
  const i1 = bio.findIndex(r => r.code === L1.code), i3 = bio.findIndex(r => r.code === r3.data.code);
  check('both reels listed, newest first', i3 >= 0 && i1 > i3, bio.map(r => r.title));
  check('the bio page shows titles and photos only', bio.every(r => Object.keys(r).sort().join() === 'code,cover,title'));
  const bioHtml = (await shop(`/${SLUG}/reels`)).data as string;
  check('its preview tags say "Shop our reels"', String(bioHtml).includes('og:title" content="Shop our reels · '));

  console.log('\nADDING FROM THE PRODUCTS LIST');
  const add1 = await api('POST', '/reel-links/add', { reelLinkId: r3.data.id, productIds: [B.id, A.id, C.id] });
  check('added after the pieces already in it; the one already there is not doubled', add1.status === 200 && add1.data.pieces.map((p: any) => p.productId).join() === [B.id, A.id, C.id].join(), add1);
  const tooMany = await api('POST', '/reel-links/add', { reelLinkId: r3.data.id, productIds: rest.slice(3, 13).map(p => p.id) });
  check('more than 12 in all: refused, saying how many more fit', tooMany.status === 400 && /has 3 pieces.*add at most 9 more/.test(tooMany.message ?? ''), tooMany);
  check('...and nothing was added', (await api('GET', `/reel-links/${r3.data.id}`)).data.pieces.length === 3);
  const fresh = await api('POST', '/reel-links/add', { productIds: [C.id] });
  check('"New reel link" from Products: made with the next "Reel N" title', fresh.status === 200 && /^Reel \d+$/.test(fresh.data.title) && fresh.data.pieces.length === 1, fresh);
  if (fresh.data?.id && !made.includes(fresh.data.id)) made.push(fresh.data.id);
  // Another shop's reel link, made here so this is always tested.
  const otherClient = (await prisma.product.findFirst({ where: { clientId: { not: CLIENT } }, select: { clientId: true } }))!.clientId;
  const otherReel = await prisma.reelLink.create({ data: { clientId: otherClient, code: R.newCode(), title: T('other shop') }, select: { id: true, code: true } });
  made.push(otherReel.id);
  check('another shop\'s reel link: cannot be added to', (await api('POST', '/reel-links/add', { reelLinkId: otherReel.id, productIds: [A.id] })).status === 404);
  check('...read, changed, switched or deleted (all "not found")', (await Promise.all([
    api('GET', `/reel-links/${otherReel.id}`), api('PUT', `/reel-links/${otherReel.id}`, { title: 'mine now' }),
    api('POST', `/reel-links/${otherReel.id}/off`), api('DELETE', `/reel-links/${otherReel.id}`)
  ])).every(r => r.status === 404));
  check('...and its code under this shop\'s address: not found', (await shop(`/_api/shop/${SLUG}/looks/${otherReel.code}`)).status === 404);
  check('...and it is untouched', (await prisma.reelLink.findUnique({ where: { id: otherReel.id } }))?.title === T('other shop'));
  check('a reel link id that does not exist: not found', (await api('POST', '/reel-links/add', { reelLinkId: '00000000-0000-0000-0000-000000000000', productIds: [A.id] })).status === 404);

  console.log('\nTWO PEOPLE AT ONCE');
  const [s1, s2] = await Promise.all([
    api('PUT', `/reel-links/${r3.data.id}`, { pieces: [A.id, B.id] }),
    api('PUT', `/reel-links/${r3.data.id}`, { pieces: [C.id] })
  ]);
  const after = (await api('GET', `/reel-links/${r3.data.id}`)).data.pieces.map((p: any) => p.productId).join();
  check('two saves of the same reel link: both answer, and the list is one whole list, never a mix', s1.status === 200 && s2.status === 200 && (after === [A.id, B.id].join() || after === C.id), { after });
  const twins = await Promise.all([1, 2, 3].map(n => api('POST', '/reel-links', { title: T(`twin ${n}`), pieces: [A.id] })));
  check('three made at the same moment: three links, three different codes and short links', twins.every(t => t.status === 201) && new Set(twins.map(t => t.data.code)).size === 3 && new Set(twins.map(t => t.data.shortUrl)).size === 3, twins.map(t => t.status));

  console.log('\nDELETE');
  const del = await api('DELETE', `/reel-links/${r3.data.id}`);
  check('deleted', del.status === 200);
  check('...gone from the list', !(await api('GET', '/reel-links')).data.some((r: any) => r.id === r3.data.id));
  check('...its page: no longer available (the code is never reused)', (await look(r3.data.code)).available === false);
  check('...cannot be changed or switched on again', (await api('PUT', `/reel-links/${r3.data.id}`, { title: 'x' })).status === 404 && (await api('POST', `/reel-links/${r3.data.id}/on`)).status === 404);
  check('...deleting twice: not found, not a crash', (await api('DELETE', `/reel-links/${r3.data.id}`)).status === 404);

  console.log('\nSHORT LINK RULES');
  const ctx = (production: boolean) => ({ blockedHosts: [], production });
  check('on this computer a link may point at the local shop (shop.localhost)', R.checkTarget('http://shop.localhost:4036/_look/abc1234', 'CAMPAIGN', ctx(false)) === 'http://shop.localhost:4036/_look/abc1234');
  let refused = false; try { R.checkTarget('http://shop.localhost:4036/_look/abc1234', 'CAMPAIGN', ctx(true)); } catch { refused = true; }
  check('...never on the live server', refused);
  refused = false; try { R.checkTarget('https://evil.localhost/x', 'EXTERNAL', ctx(true)); } catch { refused = true; }
  check('...not even over https', refused);
  check('the live shop address is still allowed live', R.checkTarget('https://shop.scaleezy.com/_look/abc1234', 'CAMPAIGN', ctx(true)) === 'https://shop.scaleezy.com/_look/abc1234');
}

async function cleanup() {
  while (restore.length) await restore.pop()!().catch(e => console.error('restore failed', e));
  const mine = await prisma.reelLink.findMany({ where: { OR: [{ id: { in: made } }, { title: { startsWith: `RLTEST ${STAMP}` } }] }, select: { id: true } });
  const ids = mine.map(m => m.id);
  await prisma.shortLink.deleteMany({ where: { ownerModule: 'reel-links', ownerRef: { in: ids } } });
  await prisma.reelLink.deleteMany({ where: { id: { in: ids } } });
  console.log(`\ncleaned up ${ids.length} reel links`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
