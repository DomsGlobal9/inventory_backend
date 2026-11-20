/**
 * Reel links through the boutique API (20 Nov 2026, PLAN-boutique-backend.md #17), against the REAL local server and
 * database: made with pieces named by the boutique's codes, changed, switched off and on, deleted -- and what a
 * shopper then sees on the shop's own reel page (live, "no longer available" when off or deleted).
 * Who may (reels:write), another shop never reachable, replay safe, refusals in words.
 *
 * Throwaway accounts only (rltest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-reels.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
const ROOT = BASE.replace(/\/api\/v1\/?$/, '');
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `rltest-${S}`, TEN2 = `rltest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const OWNER = ['products:write', 'stock:write', 'reels:write'];
const STAFF = ['products:write', 'stock:write'];
const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[]; key?: string } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can ?? OWNER)}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `rl-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, raw: r.data, replay: r.headers['idempotent-replay'] };
}
const shopper = async (slug: string, code: string) => {
  const r = await axios.get(`${ROOT}/shop/${slug}/looks/${code}`, { validateStatus: () => true, timeout: 60_000 });
  return { status: r.status, data: r.data?.data };
};

async function main() {
  const link = await call('POST', '/link', { shopName: 'Reels Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  const B = `${S}-BL`, K = `${S}-KR`, MAT = `${S}-MT`;
  await call('PUT', `/items/${B}`, { name: `Blouse ${S}`, category: 'FINISHED', unit: 'PIECE', color: 'Maroon', size: '38', sellingPrice: 1499, sellInShop: true });
  await call('PUT', `/items/${K}`, { name: `Kurta ${S}`, category: 'FINISHED', unit: 'PIECE', color: 'Teal', size: 'M', sellingPrice: 2000, sellInShop: true });
  await call('PUT', `/items/${MAT}`, { name: `Lining ${S}`, category: 'FABRIC', unit: 'METRE', sellingPrice: 120 });
  await call('POST', '/movements', { itemCode: B, kind: 'PURCHASE', quantity: 3 });
  await call('POST', '/movements', { itemCode: K, kind: 'PURCHASE', quantity: 3 });
  await call('POST', '/link', { shopName: 'Other' }, { tenant: TEN2 });

  console.log('\nBEFORE THE SHOP HAS AN ADDRESS');
  const early = await call('POST', '/reel-links', { pieces: [{ code: B }] });
  check('no online shop address yet: 409 saying to choose one first', early.status === 409 && /online shop address/i.test(early.message ?? ''), early);
  const ov0 = await call('GET', '/reel-links/overview', undefined, { can: [] });
  check('overview says reel links cannot be made yet (shopReady false)', ov0.status === 200 && ov0.data?.shopReady === false, ov0);

  const store = await prisma.stockLocation.findFirst({ where: { clientId }, select: { id: true } });
  const slug = `rl-${S}`;
  await prisma.onlineShop.create({ data: { clientId, slug, isLive: true, acceptsOrders: true, payOnDelivery: true, locationIds: [store!.id], deliverPincodes: [] } as any });

  console.log('\nMAKE ONE, BY THE BOUTIQUE\'S CODES');
  check('without reels:write: 403, nothing made', (await call('POST', '/reel-links', { pieces: [{ code: B }] }, { can: STAFF })).status === 403
    && (await prisma.reelLink.count({ where: { clientId } })) === 0);
  const kurtaProduct = (await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: K }, select: { product: { select: { productCode: true } } } }))!.product.productCode;
  const mk = await call('POST', '/reel-links', { reelUrl: 'https://www.instagram.com/reel/C0abcdEFGH/', pieces: [{ code: B }, { code: kurtaProduct, colour: 'teal' }] }, { key: `rl-${S}-same` });
  const r = mk.data;
  check('made: 201, titled "Reel 1" when no title is sent, switched on', mk.status === 201 && r?.title === 'Reel 1' && r?.active === true && typeof r?.code === 'string', mk);
  check('pieces in order: the blouse (by item code) then the kurta (by product code)', r?.pieces?.length === 2 && r.pieces[0].title === `Blouse ${S}` && r.pieces[1].productCode === kurtaProduct, r?.pieces);
  check('...each piece also carries the boutique\'s item codes', r?.pieces?.[0]?.itemCodes?.includes(B) && r?.pieces?.[1]?.itemCodes?.includes(K), r?.pieces);
  check('...the blouse takes its item\'s colour (Maroon); "teal" is kept in the item\'s spelling (Teal)', r?.pieces?.[0]?.colour === 'Maroon' && r?.pieces?.[1]?.colour === 'Teal', r?.pieces);
  check('the shop\'s page address is given', typeof r?.pageUrl === 'string' && r.pageUrl.includes(`/${slug}/look/${r.code}`), r?.pageUrl);
  const again = await call('POST', '/reel-links', { reelUrl: 'https://www.instagram.com/reel/C0abcdEFGH/', pieces: [{ code: B }, { code: kurtaProduct, colour: 'teal' }] }, { key: `rl-${S}-same` });
  check('the same request again: the same reel link, still one', again.status === 201 && again.data?.id === r?.id && (await prisma.reelLink.count({ where: { clientId } })) === 1, again.status);
  const row = await prisma.reelLink.findUnique({ where: { id: r.id }, select: { createdById: true } });
  check('"made by" is empty (the boutique\'s person is not an Inventory user)', row?.createdById === null, row);
  const s1 = await shopper(slug, r.code);
  check('a shopper opening it sees both pieces', s1.status === 200 && s1.data?.available === true && s1.data?.pieces?.length === 2, s1);

  console.log('\nREFUSED IN WORDS');
  const unknown = await call('POST', '/reel-links', { pieces: [{ code: 'NOPE-9' }] });
  check('a code not in the shop: 404 naming it', unknown.status === 404 && /NOPE-9/.test(unknown.message ?? ''), unknown);
  check('no pieces: 400', (await call('POST', '/reel-links', { pieces: [] })).status === 400);
  check('13 pieces: 400 (up to 12)', (await call('POST', '/reel-links', { pieces: Array.from({ length: 13 }, () => ({ code: B })) })).status === 400);
  const mat = await call('POST', '/reel-links', { pieces: [{ code: MAT }] });
  check('a material (not for sale): 400 saying so', mat.status === 400 && /material/i.test(mat.message ?? ''), mat);
  const http = await call('POST', '/reel-links', { reelUrl: 'http://instagram.com/reel/x', pieces: [{ code: B }] });
  check('a reel address without https: 400 in words', http.status === 400 && /https/.test(http.message ?? ''), http);
  const colour = await call('POST', '/reel-links', { pieces: [{ code: B, colour: 'Purple' }] });
  check('a colour the piece does not come in: 400 naming it', colour.status === 400 && /Purple/.test(colour.message ?? ''), colour);
  check('pieces that is not a list: 400', (await call('POST', '/reel-links', { pieces: 'B' })).status === 400);
  check('none of these made anything', (await prisma.reelLink.count({ where: { clientId } })) === 1);

  console.log('\nLIST, ONE, CHANGE');
  const ls = await call('GET', '/reel-links', undefined, { can: [] });
  check('anyone may list: it is there, 2 pieces', ls.status === 200 && ls.data?.length === 1 && ls.data[0].pieces === 2, ls);
  const ch = await call('PUT', `/reel-links/${r.id}`, { title: 'Diwali blouses', pieces: [{ code: K }] });
  check('changed: new title, only the kurta now; the link (code) is the same', ch.status === 200 && ch.data?.title === 'Diwali blouses' && ch.data?.pieces?.length === 1 && ch.data?.code === r.code, ch);
  check('a change with no pieces at all: 400, nothing lost', (await call('PUT', `/reel-links/${r.id}`, { pieces: [] })).status === 400
    && (await call('GET', `/reel-links/${r.id}`)).data?.pieces?.length === 1);
  check('changing without reels:write: 403', (await call('PUT', `/reel-links/${r.id}`, { title: 'x' }, { can: STAFF })).status === 403);

  console.log('\nANOTHER SHOP');
  check('another shop cannot read it: 404', (await call('GET', `/reel-links/${r.id}`, undefined, { tenant: TEN2 })).status === 404);
  check('...nor switch it off: 404', (await call('POST', `/reel-links/${r.id}/off`, {}, { tenant: TEN2 })).status === 404);
  check('...nor delete it: 404', (await call('DELETE', `/reel-links/${r.id}`, undefined, { tenant: TEN2 })).status === 404);
  check('...nor use this shop\'s item in its own: 404', (await call('POST', '/reel-links', { pieces: [{ code: B }] }, { tenant: TEN2 })).status === 404);
  check('...and it is still on', (await call('GET', `/reel-links/${r.id}`)).data?.active === true);

  console.log('\nSWITCH OFF AND ON');
  const off = await call('POST', `/reel-links/${r.id}/off`, {});
  check('switched off', off.status === 200 && off.data?.active === false, off);
  const s2 = await shopper(slug, r.code);
  check('...a shopper sees "no longer available" with new arrivals instead', s2.status === 200 && s2.data?.available === false && Array.isArray(s2.data?.newArrivals), s2);
  check('switching off without reels:write: 403', (await call('POST', `/reel-links/${r.id}/on`, {}, { can: STAFF })).status === 403);
  const on = await call('POST', `/reel-links/${r.id}/on`, {});
  check('switched on again: shoppers see it again', on.data?.active === true && (await shopper(slug, r.code)).data?.available === true, on);

  console.log('\nDELETE');
  check('deleting without reels:write: 403', (await call('DELETE', `/reel-links/${r.id}`, undefined, { can: STAFF })).status === 403);
  const del = await call('DELETE', `/reel-links/${r.id}`, undefined, { key: `rl-${S}-del` });
  check('deleted: 200 { deleted: true }', del.status === 200 && del.data?.deleted === true, del);
  const delAgain = await call('DELETE', `/reel-links/${r.id}`, undefined, { key: `rl-${S}-del` });
  check('the same delete again: the same answer, not an error', delAgain.status === 200 && delAgain.data?.deleted === true, delAgain);
  check('gone from the list', (await call('GET', '/reel-links')).data?.length === 0);
  check('reading it now: 404 in words', (await call('GET', `/reel-links/${r.id}`)).status === 404);
  const s3 = await shopper(slug, r.code);
  check('a shopper with the old link sees "no longer available", not an error page', s3.status === 200 && s3.data?.available === false, s3);
  check('a new delete of a deleted one (new key): 404', (await call('DELETE', `/reel-links/${r.id}`)).status === 404);
  const next = await call('POST', '/reel-links', { pieces: [{ code: B }] });
  check('the next one is "Reel 2" (titles keep counting, never reused)', next.status === 201 && next.data?.title === 'Reel 2', next);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'rltest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  await prisma.$executeRawUnsafe(`DELETE FROM reel_link_items WHERE reel_link_id IN (SELECT id FROM reel_links WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 8; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} clients`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
