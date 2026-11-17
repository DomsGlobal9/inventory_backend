/**
 * The reel links redesign (16 Nov, option A: a wall of reel cards and a three-column studio), its new numbers and
 * filters against the REAL local server and database, with the answer each SHOULD give:
 *  - covers: the first three pieces' photos, in reel order, skipping pieces with none; none at all = an empty list
 *  - soldOut: pieces in the reel with nothing free to sell (and only those)
 *  - openedWeek: people (not link-preview robots) who opened the link in the last 7 days; an open 8 days ago is not
 *    this week but still counts in "opened"
 *  - the piece picker: filter=new (made in the last 7 days), filter=instock (only with stock), an unknown filter is
 *    ignored, at most 36 pieces, and a person who may only look cannot search
 * Uses the local test shop (verify-suites-tenant, online shop "localshop"); every reel link, photo and date it
 * touches is removed or put back. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 npx tsx src/scripts/verify-reel-links-wall.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { instagramPlayer } from '../services/reel-links';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const demo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../PLAN-help/robot/demo-localcopy.json'), 'utf8'));
const CLIENT: string = demo.clientId;
const OWNER: string = demo.people.owner.token;
const SALES: string = demo.people.sales.token;
const STAMP = Date.now().toString(36);
const T = (s: string) => `RLWALL ${STAMP} ${s}`;
const restore: (() => Promise<unknown>)[] = [];
const madeImages: string[] = [];

let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
async function api(method: string, p: string, body?: unknown, token: string | null = OWNER) {
  const r = await axios.request({ method, url: `${BASE}${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: 'http://localhost:5183' } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 350.0';
const ROBOT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const tap = (url: string, ua: string) => axios.get(url, { maxRedirects: 0, validateStatus: () => true, headers: { 'User-Agent': ua } });
const card = async (id: string) => ((await api('GET', '/reel-links')).data ?? []).find((r: any) => r.id === id);

async function main() {
  const free = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM inventory_products p
     WHERE p.client_id = ${CLIENT} AND p.status = 'ACTIVE' AND p.trashed_at IS NULL AND p.sell_in_shop AND p.sold_by = 'PIECE'
       AND EXISTS (SELECT 1 FROM inventory_stocks s JOIN inventory_product_variants v ON v.id = s.variant_id WHERE v.product_id = p.id AND s.quantity - s.reserved_qty > 0)
     ORDER BY p.created_at LIMIT 6`;
  const gone = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM inventory_products p
     WHERE p.client_id = ${CLIENT} AND p.status = 'ACTIVE' AND p.trashed_at IS NULL AND p.sell_in_shop
       AND NOT EXISTS (SELECT 1 FROM inventory_stocks s JOIN inventory_product_variants v ON v.id = s.variant_id WHERE v.product_id = p.id AND s.quantity - s.reserved_qty > 0)
     LIMIT 1`;
  check('test data: 6 published pieces in stock and one sold out', free.length >= 6 && gone.length === 1, { free: free.length, gone: gone.length });
  const [a, b, c, d, e] = free.map(f => f.id);

  console.log('COVERS: THE FIRST THREE PHOTOS, IN REEL ORDER');
  for (const [pid, n] of [[a, 'a'], [c, 'c'], [d, 'd'], [e, 'e']] as const) {
    const img = await prisma.productImage.create({ data: { productId: pid, url: `https://example.invalid/${STAMP}-${n}.jpg`, imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: true } as any });
    madeImages.push(img.id);
  }
  // a (photo), b (none), c (photo), d (photo), e (photo): the collage is a, c, d -- b is skipped, e is the fourth.
  const r1 = await api('POST', '/reel-links', { title: T('covers'), pieces: [a, b, c, d, e] });
  check('a reel link of five pieces is made', r1.status === 201, r1);
  const c1 = await card(r1.data.id);
  check('covers: a, c, d -- in reel order, the piece without a photo skipped, at most three', JSON.stringify(c1?.covers) === JSON.stringify([`https://example.invalid/${STAMP}-a.jpg`, `https://example.invalid/${STAMP}-c.jpg`, `https://example.invalid/${STAMP}-d.jpg`]), c1?.covers);
  check('...and the old single "cover" still answers (the first photo)', c1?.cover === `https://example.invalid/${STAMP}-a.jpg`, c1?.cover);
  const r2 = await api('POST', '/reel-links', { title: T('no photos'), pieces: [b] });
  const c2 = await card(r2.data.id);
  check('a reel whose pieces have no photo: covers is an empty list (the card says "No photos yet")', Array.isArray(c2?.covers) && c2.covers.length === 0, c2?.covers);

  console.log('\nSOLD OUT');
  check('five pieces in stock: soldOut 0', c1?.soldOut === 0, c1?.soldOut);
  const r3 = await api('POST', '/reel-links', { title: T('sold out'), pieces: [a, gone[0].id] });
  check('one sold-out piece among two: soldOut 1', (await card(r3.data.id))?.soldOut === 1, await card(r3.data.id));

  console.log('\nTHE SHOPPER\'S REELS PAGE: EVERY REEL WITH ITS PIECES (17 Nov)');
  const slugNow = (await prisma.onlineShop.findFirst({ where: { clientId: CLIENT }, select: { slug: true } }))?.slug;
  const ROOT = BASE.replace(/\/api\/v1$/, '');
  const shopGet = async (q: string) => (await axios.get(`${ROOT}/shop/${slugNow}${q}`, { validateStatus: () => true })).data?.data;
  const strips = async () => ((await shopGet('/reels'))?.reels ?? []) as any[];
  const codeOf = new Map((await prisma.product.findMany({ where: { id: { in: [a, b, c, d, e, gone[0].id] } }, select: { id: true, productCode: true } })).map(x => [x.id, x.productCode]));
  const photoOf = (n: string) => `https://example.invalid/${STAMP}-${n}.jpg`;
  let bio = await strips();
  const s1 = bio.find(r => r.code === r1.data.code), s2 = bio.find(r => r.code === r2.data.code), s3 = bio.find(r => r.code === r3.data.code);
  const look1 = await shopGet(`/looks/${r1.data.code}`);
  check('each reel says exactly: code, title, cover, count, pieces', bio.length >= 3 && bio.every(r => Object.keys(r).sort().join() === 'code,count,cover,pieces,title'), bio[0] && Object.keys(bio[0]));
  check('each piece says exactly: code, name, photo, price, from, unit, currency, sold out -- nothing else of the product', bio.every(r => r.pieces.every((x: any) => Object.keys(x).sort().join() === 'currency,from,photo,price,productCode,soldOut,title,unit')), s1?.pieces?.[0]);
  check('the five-piece reel: count 5, its pieces in the order its own page shows them', s1?.count === 5 && JSON.stringify(s1.pieces.map((x: any) => x.productCode)) === JSON.stringify(look1.pieces.map((x: any) => x.productCode)),
    [s1?.pieces?.map((x: any) => x.productCode), look1?.pieces?.map((x: any) => x.productCode)]);
  check('...which is the shop\'s order with the unphotographed piece (b) moved behind the photographed ones: a, c, d, e, b', JSON.stringify(look1.pieces.map((x: any) => x.productCode)) === JSON.stringify([a, c, d, e, b].map(x => codeOf.get(x))), look1.pieces.map((x: any) => x.productCode));
  // The price a shopper reads on the piece's page: the lowest of the colour worn in the reel, or of all its colours.
  const pagePrice = (x: any) => Math.min(...x.variants.filter((v: any) => !x.reelColour || v.colour === x.reelColour).map((v: any) => Number(v.price)));
  check('every price on the strip is the price on the piece\'s own page, in the shop\'s currency', s1.pieces.every((x: any, i: number) => x.price === pagePrice(look1.pieces[i]) && x.price > 0 && x.currency === look1.pieces[i].variants[0].currency && x.title === look1.pieces[i].title),
    s1.pieces.map((x: any, i: number) => [x.price, pagePrice(look1.pieces[i])]));
  const at = (strip: any, id: string) => strip?.pieces?.find((x: any) => x.productCode === codeOf.get(id));
  check('photos: a, c, d and e carry theirs; b (no photo) says null', at(s1, a)?.photo === photoOf('a') && at(s1, c)?.photo === photoOf('c') && at(s1, d)?.photo === photoOf('d') && at(s1, e)?.photo === photoOf('e') && at(s1, b)?.photo === null, s1.pieces.map((x: any) => x.photo));
  check('the cover is the first photo (a)', s1.cover === photoOf('a'), s1.cover);
  check('nothing in stock is marked sold out', s1.pieces.every((x: any) => x.soldOut === false && x.unit === null), s1.pieces);
  check('a reel with no photo at all: cover null, its one piece still listed with its price', s2?.cover === null && s2.count === 1 && s2.pieces.length === 1 && s2.pieces[0].photo === null && s2.pieces[0].price > 0, s2);
  check('a sold-out piece is in the strip, marked sold out, after the one in stock', s3?.count === 2 && at(s3, a)?.soldOut === false && s3.pieces[0].productCode === codeOf.get(a) && s3.pieces[1].productCode === codeOf.get(gone[0].id) && s3.pieces[1].soldOut === true, s3?.pieces);

  const bFirst = await api('POST', '/reel-links', { title: T('no photo first'), pieces: [b, a] });
  const goneFirst = await api('POST', '/reel-links', { title: T('sold out first'), pieces: [gone[0].id, a] });
  bio = await strips();
  const s4 = bio.find(r => r.code === bFirst.data.code), s5 = bio.find(r => r.code === goneFirst.data.code);
  check('a reel the shop OPENS with an unphotographed piece: the photographed one leads (strip, cover and the reel\'s page), never an empty first screen', s4?.cover === photoOf('a') && s4.pieces[0].productCode === codeOf.get(a) && s4.pieces[1].productCode === codeOf.get(b) && s4.pieces[1].photo === null
    && (await shopGet(`/looks/${bFirst.data.code}`))?.pieces?.[0]?.productCode === codeOf.get(a), s4);
  check('a reel that opens with a sold-out piece: the strip leads with the one in stock (as its page does)', s5?.pieces?.[0]?.productCode === codeOf.get(a) && s5.pieces[1].soldOut === true, s5?.pieces);
  check('newest reel first', bio.findIndex(r => r.code === goneFirst.data.code) < bio.findIndex(r => r.code === bFirst.data.code) && bio.findIndex(r => r.code === bFirst.data.code) < bio.findIndex(r => r.code === r1.data.code), bio.map(r => r.title).slice(0, 6));
  const preview = await axios.get(`${ROOT}/${slugNow}/look/${bFirst.data.code}`, { headers: { host: `shop.localhost:${new URL(BASE).port}` }, validateStatus: () => true });
  check('...and the picture beside its link in WhatsApp is that photo too (it was the shop\'s banner)', String(preview.data).includes(`og:image" content="${photoOf('a')}"`), String(preview.data).match(/og:image" content="[^"]*"/)?.[0]);

  const twelveIds = (await prisma.product.findMany({ where: { clientId: CLIENT, status: 'ACTIVE', trashedAt: null, sellInShop: true, soldBy: 'PIECE' }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: 12 })).map(x => x.id);
  const twelve = await api('POST', '/reel-links', { title: T('twelve'), pieces: twelveIds });
  const cloth = await prisma.product.findFirst({ where: { clientId: CLIENT, status: 'ACTIVE', trashedAt: null, sellInShop: true, soldBy: 'METRE' }, select: { id: true, productCode: true } });
  const two = (await prisma.product.findMany({ where: { clientId: CLIENT, status: 'ACTIVE', trashedAt: null, sellInShop: true, soldBy: 'PIECE' }, select: { id: true, productCode: true, variants: { select: { id: true, colorName: true } } } }))
    .find(x => new Set(x.variants.map(v => v.colorName).filter(Boolean)).size >= 2);
  check('test data: twelve pieces, cloth sold by the metre, a piece in two colours', twelveIds.length === 12 && twelve.status === 201 && !!cloth && !!two, { twelve: twelveIds.length, cloth: !!cloth, two: !!two });
  const second = two!.variants.find(v => v.colorName && v.colorName !== two!.variants[0].colorName)!;
  madeImages.push((await prisma.productImage.create({ data: { productId: two!.id, variantId: second.id, url: photoOf('colour'), imageType: 'GALLERY' as any, orderIndex: 0, isPrimary: false } as any })).id);
  const mixed = await api('POST', '/reel-links', { title: T('cloth and colour'), pieces: [cloth!.id, { productId: two!.id, colour: second.colorName }] });
  bio = await strips();
  const s12 = bio.find(r => r.code === twelve.data.code), s6 = bio.find(r => r.code === mixed.data?.code);
  check('a reel of twelve: count 12, the strip carries ten (the rest are on the reel\'s page)', s12?.count === 12 && s12.pieces.length === 10, [s12?.count, s12?.pieces?.length]);
  const lookMixed = await shopGet(`/looks/${mixed.data?.code}`);
  const clothPage = lookMixed?.pieces?.find((x: any) => x.productCode === cloth!.productCode), clothStrip = s6?.pieces?.find((x: any) => x.productCode === cloth!.productCode);
  check('cloth: priced per metre (100 x the per-centimetre price its page holds), unit "m"', !!clothStrip && clothStrip.unit === 'm' && clothStrip.price === Math.round(pagePrice(clothPage) * 100 * 100) / 100 && clothStrip.price >= 1, [clothStrip, clothPage && pagePrice(clothPage)]);
  const twoStrip = s6?.pieces?.find((x: any) => x.productCode === two!.productCode), twoPage = lookMixed?.pieces?.find((x: any) => x.productCode === two!.productCode);
  check('a piece worn in its second colour: the strip shows THAT colour\'s photo and price', twoStrip?.photo === photoOf('colour') && twoPage?.reelColour === second.colorName && twoStrip.price === pagePrice(twoPage), [twoStrip, twoPage?.reelColour]);

  const wasC = await prisma.product.findUnique({ where: { id: c }, select: { sellInShop: true } });
  restore.push(() => prisma.product.update({ where: { id: c }, data: { sellInShop: wasC!.sellInShop } }));
  await prisma.product.update({ where: { id: c }, data: { sellInShop: false } });
  const hidden = (await strips()).find(r => r.code === r1.data.code);
  check('a piece the shop took out of its online shop leaves the strip and the count (4 left, in order)', hidden?.count === 4 && !hidden.pieces.some((x: any) => x.productCode === codeOf.get(c)) && JSON.stringify(hidden.pieces.map((x: any) => x.productCode)) === JSON.stringify([a, d, e, b].map(x => codeOf.get(x))), hidden?.pieces?.map((x: any) => x.productCode));
  await prisma.product.update({ where: { id: c }, data: { sellInShop: wasC!.sellInShop } });
  check('...and comes back when it is put back', (await strips()).find(r => r.code === r1.data.code)?.count === 5);
  await api('POST', `/reel-links/${r2.data.id}/off`);
  check('a reel switched off is not on the page', !(await strips()).some(r => r.code === r2.data.code));
  await api('POST', `/reel-links/${r2.data.id}/on`);
  check('...and is back when switched on', (await strips()).some(r => r.code === r2.data.code));
  check('a shop address that does not exist: 404, no list', (await axios.get(`${ROOT}/shop/no-such-shop-${STAMP}/reels`, { validateStatus: () => true })).status === 404);

  console.log('\nOPENED IN THE LAST 7 DAYS');
  const url = c1.shortUrl;
  check('the reel link has its short link', /\/l\/[A-Za-z0-9]+$/.test(url ?? ''), url);
  await tap(url, HUMAN); await tap(url, HUMAN); await tap(url, ROBOT);
  await new Promise(r => setTimeout(r, 800));
  let now = await card(r1.data.id);
  check('two people and one preview robot: opened 2, this week 2 (the robot left out of both)', now?.opened === 2 && now.openedWeek === 2, { opened: now?.opened, week: now?.openedWeek });
  const link = await prisma.shortLink.findFirst({ where: { clientId: CLIENT, ownerModule: 'reel-links', ownerRef: r1.data.id } });
  const first = await prisma.shortLinkTap.findFirst({ where: { linkId: link!.id, visitor: 'HUMAN' as any }, orderBy: { at: 'asc' } });
  await prisma.shortLinkTap.update({ where: { id: first!.id }, data: { at: new Date(Date.now() - 8 * 86_400_000) } });
  now = await card(r1.data.id);
  check('one of the two opens was 8 days ago: this week 1, opened (all time) still 2', now?.opened === 2 && now.openedWeek === 1, { opened: now?.opened, week: now?.openedWeek });
  check('a reel nobody opened: this week 0', (await card(r2.data.id))?.openedWeek === 0);

  console.log('\nTHE PICKER\'S FILTERS');
  const all = await api('GET', '/reel-links/pieces');
  check('no search, no filter: at most 36 pieces', all.status === 200 && all.data.length > 0 && all.data.length <= 36, all.data?.length);
  const was = await prisma.product.findUnique({ where: { id: e }, select: { createdAt: true } });
  restore.push(() => prisma.product.update({ where: { id: e }, data: { createdAt: was!.createdAt } }));
  await prisma.product.update({ where: { id: e }, data: { createdAt: new Date() } });
  const old = await prisma.product.findUnique({ where: { id: a }, select: { createdAt: true } });
  const fresh = await api('GET', '/reel-links/pieces?filter=new');
  check('filter=new: the piece made today is in', fresh.data?.some((p: any) => p.productId === e), fresh.data?.map((p: any) => p.title));
  check('...and only pieces made in the last 7 days', (old!.createdAt.getTime() < Date.now() - 7 * 86_400_000 ? !fresh.data?.some((p: any) => p.productId === a) : true));
  const inStock = await api('GET', '/reel-links/pieces?filter=instock');
  check('filter=instock: every piece has stock, the sold-out one is not there', inStock.data?.length > 0 && inStock.data.every((p: any) => p.inStock > 0) && !inStock.data.some((p: any) => p.productId === gone[0].id), inStock.data?.length);
  const odd = await api('GET', '/reel-links/pieces?filter=everything');
  check('an unknown filter is ignored (the same as none)', odd.status === 200 && odd.data?.length === all.data?.length, [odd.status, odd.data?.length, all.data?.length]);
  check('a search with a filter: both apply', ((await api('GET', `/reel-links/pieces?q=${encodeURIComponent('zzz-nothing-' + STAMP)}&filter=instock`)).data ?? []).length === 0);
  check('a person who may only look cannot search for pieces: 403', (await api('GET', '/reel-links/pieces', undefined, SALES)).status === 403);
  check('...nor read the list (no reel_link:view): 403', (await api('GET', '/reel-links', undefined, SALES)).status === 403);

  console.log('\nTHE REEL ITSELF (17 Nov): PLAYED IN INVENTORY, A LINK FOR SHOPPERS');
  const P = (u: string) => instagramPlayer(u);
  check('a reel address -> Instagram\'s player', JSON.stringify(P('https://www.instagram.com/reel/C0ffee123/')) === JSON.stringify({ url: 'https://www.instagram.com/reel/C0ffee123/', embed: 'https://www.instagram.com/reel/C0ffee123/embed/' }), P('https://www.instagram.com/reel/C0ffee123/'));
  check('...with Instagram\'s ?igsh= share tail: the tail is dropped', P('https://www.instagram.com/reel/C0ffee123/?igsh=MTZ6aWx')?.embed === 'https://www.instagram.com/reel/C0ffee123/embed/');
  check('...a username before /reel/, m.instagram.com, /reels/ and a post (/p/) all work', P('https://www.instagram.com/sphl.sarees/reel/C0ffee123/')?.url === 'https://www.instagram.com/reel/C0ffee123/' && P('https://m.instagram.com/reel/C0ffee123')?.url === 'https://www.instagram.com/reel/C0ffee123/' && P('https://www.instagram.com/reels/C0ffee123/')?.url === 'https://www.instagram.com/reel/C0ffee123/' && P('https://www.instagram.com/p/C0ffee123/')?.embed === 'https://www.instagram.com/p/C0ffee123/embed/');
  for (const [why, u] of [
    ['another site', 'https://www.youtube.com/watch?v=abc12345'],
    ['a look-alike domain', 'https://instagram.com.evil.example/reel/C0ffee123/'],
    ['plain http', 'http://www.instagram.com/reel/C0ffee123/'],
    ['a profile, not a reel', 'https://www.instagram.com/sphl.sarees/'],
    ['a path trying to climb out', 'https://www.instagram.com/reel/../../evil/'],
    ['not an address at all', 'reel 12 on insta']
  ] as const) check(`no player for ${why}`, P(u) === null, P(u));

  const withReel = await api('POST', '/reel-links', { title: T('with reel'), reelUrl: 'https://www.instagram.com/reel/C0ffee123/?igsh=xyz', pieces: [a] });
  const without = await api('POST', '/reel-links', { title: T('no reel'), pieces: [a] });
  const listRow = ((await api('GET', '/reel-links')).data ?? []).find((r: any) => r.id === withReel.data?.id);
  check('the wall\'s list carries the reel address, so a card can play it', listRow?.reelUrl === 'https://www.instagram.com/reel/C0ffee123/?igsh=xyz', listRow?.reelUrl);
  const shopSlug = (await prisma.onlineShop.findFirst({ where: { clientId: CLIENT }, select: { slug: true } }))?.slug;
  const pub = async (code: string) => (await axios.get(`${BASE.replace(/\/api\/v1$/, '')}/shop/${shopSlug}/looks/${code}`, { validateStatus: () => true })).data?.data;
  const pubWith = await pub(withReel.data.code);
  check('the shopper\'s page gets the reel as Instagram\'s address (for "Watch reel")', pubWith?.reel?.url === 'https://www.instagram.com/reel/C0ffee123/', pubWith?.reel);
  check('...and a link without a reel address gets none (no button)', (await pub(without.data.code))?.reel === null);
  const page = await axios.get(`${BASE.replace(/\/api\/v1$/, '')}/${shopSlug}/look/${withReel.data.code}`, { headers: { host: `shop.localhost:${new URL(BASE).port}` }, validateStatus: () => true });
  const csp = String(page.headers['content-security-policy'] ?? '');
  check('the shop page still lets NO Instagram frame in (shoppers get a link, not a player)', csp.length > 0 && !/frame-src[^;]*instagram/.test(csp), csp.slice(0, 200));
}

async function cleanup() {
  const ids = (await prisma.reelLink.findMany({ where: { clientId: CLIENT, title: { startsWith: `RLWALL ${STAMP}` } }, select: { id: true } })).map(r => r.id);
  await prisma.shortLink.deleteMany({ where: { clientId: CLIENT, ownerModule: 'reel-links', ownerRef: { in: ids } } });
  await prisma.reelLink.deleteMany({ where: { id: { in: ids } } });
  await prisma.productImage.deleteMany({ where: { id: { in: madeImages } } });
  for (const r of restore.reverse()) await r().catch(e => console.error('restore failed', e));
  console.log(`\ncleaned up ${ids.length} reel links, ${madeImages.length} photos`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
