/**
 * What POS asked of the boutique API on 25 Nov 2026, so a boutique-run shop (no Inventory login) is never told "do it
 * in Inventory": gift vouchers on/off and limits, "cut cloth can be returned" and "price includes GST" per item, the
 * shop logo, and the vouchers still owed for the till's day close. Against the REAL local server and database; the
 * till's side is read with a real till key, as POS reads it. The logo test makes an upload address but uploads no file.
 * Local only; throwaway shops (pasks-*) are removed.
 *   (the 4036 runner's env, BOUTIQUE_KEY_DIR) npx tsx src/scripts/verify-boutique-pos-asks.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import { prisma } from '../lib/prisma';
import { posConnectionService } from '../services/pos/pos-connection.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `pasks-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const OWNER = ['products:write', 'stock:write', 'settings:write'];
const STAFF = ['products:write', 'stock:write'];
const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, can = OWNER) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(TEN, can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `pa-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}

async function main() {
  const link = await call('POST', '/link', { shopName: 'Asks Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  const store = await prisma.stockLocation.findFirstOrThrow({ where: { clientId, active: true } });
  const till = await posConnectionService.create(clientId, { locationId: store.id, name: 'Asks till' });
  const tillGet = async (p: string, units = false) => (await axios.get(`${BASE}/pos/v1${p}`, { headers: { 'x-storefront-key': till.key, ...(units ? { 'X-Pos-Units': '1' } : {}) }, validateStatus: () => true })).data?.data;

  console.log('\nGIFT VOUCHERS');
  const v0 = await call('GET', '/settings/vouchers');
  check('read: off by default, limits in rupees (500 to 50,000), 12 months, nothing owed', v0.status === 200 && v0.data?.enabled === false && v0.data?.minAmount === 500 && v0.data?.maxAmount === 50000 && v0.data?.validMonths === 12 && v0.data?.owed === 0, v0);
  check('also inside GET /settings', (await call('GET', '/settings')).data?.vouchers?.enabled === false);
  check('a member without settings:write: 403', (await call('PUT', '/settings/vouchers', { enabled: true }, STAFF)).status === 403);
  // The live line hears it (the till is told at once).
  const pg = new Client({ connectionString: process.env.DIRECT_URL }); await pg.connect(); await pg.query('LISTEN inventory_live');
  const heard: string[] = []; pg.on('notification', m => { try { const j = JSON.parse(m.payload ?? '{}'); if (j.c === clientId) heard.push(j.t); } catch { /* */ } });
  const on = await call('PUT', '/settings/vouchers', { enabled: true, minAmount: 1000, maxAmount: 25000.5, validMonths: 6 });
  check('switched on with limits: answered as saved', on.status === 200 && on.data?.enabled === true && on.data?.minAmount === 1000 && on.data?.maxAmount === 25000.5 && on.data?.validMonths === 6, on);
  await new Promise(r => setTimeout(r, 500)); await pg.end();
  check('...the till is told at once (live line: settings)', heard.includes('settings'), heard);
  const cat = await tillGet('/catalogue?limit=1');
  check('...and the till reads them in its catalogue (paise)', cat?.giftVouchers?.enabled === true && cat?.giftVouchers?.minPaise === 100000 && cat?.giftVouchers?.maxPaise === 2500050, cat?.giftVouchers);
  check('only some fields: the rest kept', (await call('PUT', '/settings/vouchers', { validMonths: 9 })).data?.minAmount === 1000);
  const r1 = await call('PUT', '/settings/vouchers', { maxAmount: 500 });
  check('largest below smallest: 400 in words', r1.status === 400 && /largest/i.test(r1.message ?? ''), r1);
  const r2 = await call('PUT', '/settings/vouchers', { validMonths: 61 });
  check('61 months: 400 in words', r2.status === 400 && /60 months/.test(r2.message ?? ''), r2);
  const r3 = await call('PUT', '/settings/vouchers', { minAmount: '12.345' });
  check('an amount past paise: 400', r3.status === 400, r3);
  const r4 = await call('PUT', '/settings/vouchers', { enabled: 'yes' });
  check('"enabled" not true/false: 400', r4.status === 400, r4);
  const r5 = await call('PUT', '/settings/vouchers', { minPaise: 100 });
  check('an unknown field (minPaise): refused, naming the fields', r5.status === 400 && /minAmount/.test(r5.message ?? ''), r5);
  check('nothing changed by the refusals', (await call('GET', '/settings/vouchers')).data?.maxAmount === 25000.5);

  console.log('\nVOUCHERS STILL OWED (the till\'s day close)');
  const sold = await axios.post(`${BASE}/pos/v1/vouchers`, { amountPaise: 150000, idempotencyKey: `pa-${S}-v1`, payments: [{ method: 'CASH', amountPaise: 150000 }] }, { headers: { 'x-storefront-key': till.key }, validateStatus: () => true });
  check('a ₹1,500 voucher sold at the till', sold.status === 200, { status: sold.status, msg: sold.data?.message });
  const sum = await tillGet('/vouchers-summary');
  check('GET /pos/v1/vouchers-summary: ₹1,500 owed, 1 open voucher', sum?.owedPaise === 150000 && sum?.openVouchers === 1, sum);
  check('...and the boutique sees the same in rupees', (await call('GET', '/settings/vouchers')).data?.owed === (sum?.owedPaise ?? 0) / 100);

  console.log('\nPER ITEM: CUT CLOTH RETURNABLE, PRICE INCLUDES GST');
  const CL = `${S}-CL`, PC = `${S}-PC`;
  const a = await call('PUT', `/items/${CL}`, { name: `Silk ${S}`, category: 'FABRIC', unit: 'METER', sellingPrice: 450, gstPercent: 5, sellInShop: true, cutReturnable: true });
  check('a cloth item with cutReturnable true: saved and shown', a.status === 201 && a.data?.cutReturnable === true && a.data?.priceIncludesGst === true, a);
  const b = await call('PUT', `/items/${PC}`, { name: `Kurta ${S}`, category: 'FINISHED', sellingPrice: 1000, gstPercent: 12, sellInShop: true, priceIncludesGst: false });
  check('a piece priced before GST: priceIncludesGst false, shown', b.status === 201 && b.data?.priceIncludesGst === false && b.data?.cutReturnable === false, b);
  const c = await call('PUT', `/items/${PC}`, { name: `Kurta ${S}` });
  check('saved again without the fields: both kept', c.data?.priceIncludesGst === false, c);
  check('"cutReturnable" not true/false: 400', (await call('PUT', `/items/${CL}`, { name: 'x', cutReturnable: 'yes' })).status === 400);
  check('"priceIncludesGst" not true/false: 400', (await call('PUT', `/items/${PC}`, { name: 'x', priceIncludesGst: 1 })).status === 400);
  await call('POST', '/movements', { itemCode: CL, kind: 'PURCHASE', quantity: 20 });
  await call('POST', '/movements', { itemCode: PC, kind: 'PURCHASE', quantity: 2 });
  const all = await tillGet('/catalogue?limit=100', true);
  const vs = (all?.products ?? []).flatMap((p: any) => p.variants.map((v: any) => ({ ...v, p })));
  const cl = vs.find((v: any) => v.sku === CL), pc = vs.find((v: any) => v.sku === PC);
  check('the till reads the cloth as returnable (unit.returnable)', cl?.unit?.returnable === true, cl?.unit);
  check('the till reads the kurta as priced before GST (priceIsExclusive)', pc?.priceIsExclusive === true, pc && { priceIsExclusive: pc.priceIsExclusive });
  const d = await call('PUT', `/items/${PC}`, { name: `Kurta ${S}`, priceIncludesGst: true });
  check('switched to "includes GST": saved', d.data?.priceIncludesGst === true, d);
  const pc2 = ((await tillGet('/catalogue?limit=100', true))?.products ?? []).flatMap((p: any) => p.variants).find((v: any) => v.sku === PC);
  check('...and the till reads it at once', pc2?.priceIsExclusive === false, pc2 && { priceIsExclusive: pc2.priceIsExclusive });

  console.log('\nTHE LOGO');
  check('a member without settings:write: 403', (await call('POST', '/settings/logo/upload-url', { fileName: 'logo.png' }, STAFF)).status === 403);
  const nf = await call('POST', '/settings/logo/upload-url', { fileName: 'logo.gif' });
  check('not PNG/JPEG/WebP: 400 in words', nf.status === 400 && /png/.test(nf.message ?? ''), nf);
  // The upload address comes from picture storage, which this PC's server cannot reach; it is Inventory's own
  // logo code (live since October). Checked only when asked: VERIFY_STORAGE=1 against a server that reaches storage.
  let up: { status: number; data?: any; message?: string } = { status: 0, data: { storagePath: `${clientId}/branding/${Date.now()}_logo.png` } };
  if (process.env.VERIFY_STORAGE === '1') {
    up = await call('POST', '/settings/logo/upload-url', { fileName: 'my logo.png' });
    check('upload address: uploadUrl + storagePath in this shop\'s own folder', up.status === 200 && typeof up.data?.uploadUrl === 'string' && String(up.data?.storagePath).startsWith(`${clientId}/branding/`), { status: up.status, path: up.data?.storagePath, msg: up.message });
  }
  const other = await call('PUT', '/settings/logo', { storagePath: `someone-else/branding/x.png` });
  check('another shop\'s path: refused (400)', other.status === 400, other);
  check('no path: 400', (await call('PUT', '/settings/logo', {})).status === 400);
  if (up.data?.storagePath) {
    const set = await call('PUT', '/settings/logo', { storagePath: up.data.storagePath });
    check('saved: the shop\'s logoUrl is that picture', set.status === 200 && typeof set.data?.logoUrl === 'string' && set.data.logoUrl.includes(encodeURI(up.data.storagePath).split('/').pop()!.slice(0, 10)), set);
    check('...shown in GET /settings (shop.logoUrl)', !!(await call('GET', '/settings')).data?.shop?.logoUrl);
    const del = await call('DELETE', '/settings/logo');
    check('removed: logoUrl null', del.status === 200 && del.data?.logoUrl === null, del);
  }
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'pasks-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM gift_voucher_entries WHERE voucher_id IN (SELECT id FROM gift_vouchers WHERE client_id = ANY($1))`, ids).catch(() => undefined);
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
