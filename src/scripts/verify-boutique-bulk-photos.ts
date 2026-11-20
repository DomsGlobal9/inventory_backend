/**
 * Photos for many items at once through the boutique API (20 Nov 2026), against the REAL local server and database:
 * file names matched to items by the boutique's codes (colour and position from the name; not-a-photo and unknown
 * names said), and a photo from a link refused for a private address, a non-web link and an unknown item.
 * NOT proved here: a photo from a link actually stored -- this machine's photo storage is not reachable (the same local
 * limit as the online-shop picture checks).
 *
 * Throwaway accounts only (bptest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-bulk-photos.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `bptest-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const pass = (can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant: TEN, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, can = ['products:write']) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `bp-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}

async function main() {
  await call('POST', '/link', { shopName: 'Bulk Photos Test' });
  const SILK = `SLK${S}`.toUpperCase().slice(0, 12), BL = `BLS${S}`.toUpperCase().slice(0, 12);
  await call('PUT', `/items/${SILK}`, { name: 'Kanchi silk', kind: 'FABRIC', unit: 'METER', color: 'Green', sellingPrice: 450, sellInShop: true });
  await call('PUT', `/items/${BL}`, { name: 'Ready blouse', category: 'FINISHED', unit: 'PIECE', color: 'Maroon', sellingPrice: 1499, sellInShop: true });

  console.log('\nMATCHING FILE NAMES');
  check('without products:write: 403', (await call('POST', '/photos/match', { fileNames: [`${SILK}.jpg`] }, ['stock:write'])).status === 403);
  check('no file names: 400', (await call('POST', '/photos/match', {})).status === 400);
  const m = await call('POST', '/photos/match', { fileNames: [`${SILK}.jpg`, `${BL}-maroon-2.jpg`, 'holiday.jpg', 'notes.txt'] });
  const by = Object.fromEntries((m.data?.files ?? []).map((f: any) => [f.name, f]));
  check('"<code>.jpg": matched to that item by the boutique\'s code', by[`${SILK}.jpg`]?.status === 'MATCHED' && by[`${SILK}.jpg`]?.itemCodes?.includes(SILK), by[`${SILK}.jpg`]);
  check('"<code>-maroon-2.jpg": that colour, position 2', by[`${BL}-maroon-2.jpg`]?.status === 'MATCHED' && /maroon/i.test(by[`${BL}-maroon-2.jpg`]?.colour ?? '') && by[`${BL}-maroon-2.jpg`]?.position === 2, by[`${BL}-maroon-2.jpg`]);
  check('a name that is no item: UNMATCHED, with a reason', by['holiday.jpg']?.status === 'UNMATCHED' && !!by['holiday.jpg']?.reason, by['holiday.jpg']);
  check('a file that is not a photo: NOT_A_PHOTO', by['notes.txt']?.status === 'NOT_A_PHOTO', by['notes.txt']);
  check('drafts still without a photo: 0 (both items are live, and this folder covers them)', m.data?.draftsStillWithoutPhotos === 0, m.data?.draftsStillWithoutPhotos);

  console.log('\nA PHOTO FROM A LINK (refusals)');
  check('without products:write: 403', (await call('POST', '/photos/from-link', { itemCode: SILK, url: 'https://example.com/a.jpg' }, ['stock:write'])).status === 403);
  check('an item not in the shop: 404', (await call('POST', '/photos/from-link', { itemCode: 'NOPE-1', url: 'https://example.com/a.jpg' })).status === 404);
  const local = await call('POST', '/photos/from-link', { itemCode: SILK, url: 'http://127.0.0.1/secret.jpg' });
  check('a private or local address: refused in words (never fetched)', local.status === 400 && (local.message ?? '').length > 10, local);
  check('not a web link: 400', (await call('POST', '/photos/from-link', { itemCode: SILK, url: 'not a link' })).status === 400);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'bptest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const t of tables) { try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); } catch { left++; } }
    if (!left) break;
  }
  console.log(`\ncleaned up ${ids.length} clients`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${good} passed, ${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
