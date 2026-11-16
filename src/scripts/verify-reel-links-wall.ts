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
