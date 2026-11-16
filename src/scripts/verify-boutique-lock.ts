/**
 * One inventory for all of ScaleEzy (16 Nov): the boutique's items are the boutique's, and the boutique API must stay
 * fair and reachable for every boutique. Against the REAL local server and database:
 *  - each boutique its own 1,500 calls a minute: one boutique past it gets 429 in words, another is unaffected
 *  - GET /status: up, database connected, the limit, how fast
 *  - an item the owner puts in the bin reads IN_BIN, leaves ACTIVE lists, alerts and reorder; restored, it is back
 *  - the owner's own screens (the same service calls the routes make) cannot change a boutique item's name, price,
 *    unit, GST, colour, size or purchase price, nor add or delete its colours -- but can change its description,
 *    reorder level and publish state; a RETAIL item of the same shop can still change everything (retail unchanged)
 * Throwaway boutiques only (locktest-*); everything is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-lock.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { productService } from '../services/product.service';
import { variantService } from '../services/variant.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
let n = 0;
const shop = (tenant: string) => async (method: string, path: string, body?: unknown) => {
  const pass = jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lock', can: ['products:write', 'stock:write', 'stitching:issue', 'reports:view'] } },
    privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Authorization: `Bearer ${pass}`, ...(method !== 'GET' ? { 'Idempotency-Key': `lock-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, headers: r.headers };
};
const A = shop(`locktest-a-${S}`), B = shop(`locktest-b-${S}`), BUSY = shop(`locktest-busy-${S}`);
/** What the owner's screen would get: the service's refusal, or "saved". */
const owner = async (fn: () => Promise<unknown>) => { try { await fn(); return 'saved'; } catch (e: any) { return `${e.statusCode ?? e.status ?? '?'} ${e.message}`; } };

async function main() {
  const la = await A('POST', '/link', { shopName: 'Lock A' });
  await B('POST', '/link', { shopName: 'Lock B' });
  const cA = la.data.clientId as string;

  console.log('STATUS');
  const st = await A('GET', '/status');
  check('GET /status: up, database connected, its limit and how fast', st.status === 200 && st.data?.up === true && st.data.database === 'connected' && st.data.perMinuteLimit === 1500 && typeof st.data.answeredInMs === 'number', st.data);
  check('...an unlinked boutique may ask too (it needs no shop)', (await shop(`locktest-nolink-${S}`)('GET', '/status')).status === 200);

  console.log('\nTHE BIN');
  const SILK = `SILK-${S}`;
  await A('PUT', `/items/${SILK}`, { name: 'Kanchi silk', category: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, purchasePrice: 280, sellInShop: true, reorderLevel: 30, openingStock: [{ quantity: 5 }] });
  const v = (await prisma.productVariant.findFirst({ where: { clientId: cA, boutiqueRef: SILK } }))!;
  check('before: ACTIVE, in the ACTIVE list, reorder due, in alerts', (await A('GET', `/items/${SILK}`)).data?.status === 'ACTIVE' && (await A('GET', '/items?status=ACTIVE')).data?.total === 1 && ((await A('GET', '/alerts')).data ?? []).length === 1);
  await productService.trashProduct(v.productId, cA);
  const binned = (await A('GET', `/items/${SILK}`)).data;
  check('the owner puts it in the bin: it reads IN_BIN (inBin: true)', binned?.status === 'IN_BIN' && binned.inBin === true, binned);
  check('...gone from the ACTIVE list, listed under IN_BIN', (await A('GET', '/items?status=ACTIVE')).data?.total === 0 && (await A('GET', '/items?status=IN_BIN')).data?.total === 1);
  check('...not in alerts, not reorder due, counted in the groups as in the bin', ((await A('GET', '/alerts')).data ?? []).length === 0 && (await A('GET', '/items?reorderDue=1')).data?.total === 0 && (await A('GET', '/items/groups')).data?.inBin === 1 && (await A('GET', '/items/groups')).data?.all === 0);
  check('...the boutique saving it again does not take it out of the bin', (await A('PUT', `/items/${SILK}`, { name: 'Kanchi silk', category: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, purchasePrice: 280, sellInShop: true })).data?.status === 'IN_BIN');
  check('...its stock is still there (a bin is not a write-off)', (await A('GET', `/items/${SILK}`)).data?.stock === 5);
  await productService.restoreProduct(v.productId, cA);
  check('the owner restores it: ACTIVE again, back in the list and alerts', (await A('GET', `/items/${SILK}`)).data?.status === 'ACTIVE' && (await A('GET', '/items?status=ACTIVE')).data?.total === 1 && ((await A('GET', '/alerts')).data ?? []).length === 1);

  console.log('\nTHE OWNER\'S SCREENS AND A BOUTIQUE ITEM');
  const p = (await prisma.product.findUnique({ where: { id: v.productId } }))!;
  const whole = { title: p.title, description: p.description, basePrice: p.basePrice, soldBy: p.soldBy, kind: p.kind, widthCm: p.widthCm, hsnCode: p.hsnCode, taxRateBps: p.taxRateBps, sellInShop: p.sellInShop, productType: p.productType };
  check('saving the whole form unchanged is fine (blank and null are the same)', (await owner(() => productService.updateProduct(p.id, cA, { ...whole, description: '', hsnCode: '' }))) === 'saved');
  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ['the name', { title: 'Cheap silk' }, /The name comes from your boutique app/],
    ['the price', { basePrice: 1 }, /price comes from your boutique/],
    ['how it is sold', { soldBy: 'PIECE' }, /How it is sold comes from your boutique app/],
    ['the GST rate', { taxRateBps: 1200 }, /GST rate comes from your boutique app/],
    ['the HSN code', { hsnCode: '6204' }, /HSN code comes from your boutique app/]
  ];
  // The shop decides what it sells (rule from 13 Nov, kept): "sell in shop" stays the owner's to switch too.
  check('the owner switching "sell in shop" off: saved (the shop decides what it sells)', (await owner(() => productService.updateProduct(p.id, cA, { sellInShop: false }))) === 'saved');
  await productService.updateProduct(p.id, cA, { sellInShop: true });
  for (const [what, data, msg] of refusals) {
    const r = await owner(() => productService.updateProduct(p.id, cA, data));
    check(`the owner changing ${what}: 409 in words`, /^409 /.test(r) && msg.test(r), r);
  }
  check('the owner adding a description: saved (the boutique only sends one sometimes)', (await owner(() => productService.updateProduct(p.id, cA, { description: 'Pure silk from Kanchipuram' }))) === 'saved');
  check('the owner archiving it from the shop: saved (the shop decides what it shows)', (await owner(() => productService.updateProduct(p.id, cA, { status: 'ARCHIVED' }))) === 'saved' && (await A('GET', `/items/${SILK}`)).data?.status === 'ARCHIVED');
  await productService.updateProduct(p.id, cA, { status: 'ACTIVE' });
  const vr: [string, Record<string, unknown>, RegExp][] = [
    ['the colour', { colorName: 'Red' }, /The colour comes from your boutique app/],
    ['the size', { size: 'XL' }, /The size comes from your boutique app/],
    ['the purchase price', { costPrice: 1 }, /purchase price comes from your boutique app/],
    ['the selling price', { sellingPrice: 1 }, /price comes from your boutique/]
  ];
  for (const [what, data, msg] of vr) {
    const r = await owner(() => variantService.updateVariant(v.id, cA, data));
    check(`the owner changing ${what} of a colour: 409 in words`, /^409 /.test(r) && msg.test(r), r);
  }
  check('the owner changing its reorder level: saved', (await owner(() => variantService.updateVariant(v.id, cA, { reorderLevel: 2000 }))) === 'saved');
  check('the owner deleting the colour: 409, the colour is still there', /^409 .*Archive it in the boutique app/.test(await owner(() => variantService.deleteVariant(v.id, cA))) && !!(await prisma.productVariant.findUnique({ where: { id: v.id } })));
  check('the owner adding a colour: 409, nothing added', /^409 .*Add the colour there/.test(await owner(() => variantService.createVariant(p.id, cA, { colorName: 'Blue', size: 'Free', sku: `X-${S}`, sellingPrice: 450 })))
    && (await prisma.productVariant.count({ where: { productId: p.id } })) === 1);
  // Bulk updates answer row by row ({ updated, skipped, errors }) rather than failing the whole file.
  const bp: any = await variantService.bulkUpdateVariants(cA, [{ sku: v.sku, sellingPrice: 1 }]);
  check('a bulk price change on it: that row skipped, saying the price comes from the boutique', bp.updated === 0 && bp.skipped === 1 && /comes from your boutique/.test(bp.errors?.[0]?.reason ?? ''), bp);
  const bc: any = await variantService.bulkUpdateVariants(cA, [{ sku: v.sku, costPrice: 1 }]);
  check('a bulk cost change on it: that row skipped, in words', bc.updated === 0 && bc.skipped === 1 && /purchase price comes from your boutique app/.test(bc.errors?.[0]?.reason ?? ''), bc);
  const now = (await prisma.productVariant.findUnique({ where: { id: v.id } }))!;
  check('...the stored price and cost did not move', Number(now.sellingPrice) === Number(v.sellingPrice) && Number(now.costPrice) === Number(v.costPrice), [now.sellingPrice, now.costPrice]);
  check('...and after all that the boutique still sees its own values', (await A('GET', `/items/${SILK}`)).data?.name === 'Kanchi silk' && (await A('GET', `/items/${SILK}`)).data?.sellingPrice === 450 && (await A('GET', `/items/${SILK}`)).data?.colour === 'Maroon');

  console.log('\nA RETAIL ITEM OF THE SAME SHOP: UNCHANGED');
  const rp = await prisma.product.create({ data: { clientId: cA, productCode: `RTL-${S}`, slug: `rtl-${S}`, title: 'Ready-made kurti', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 999, status: 'ACTIVE' as any } as any });
  const rv = await prisma.productVariant.create({ data: { clientId: cA, productId: rp.id, sku: `RTL-${S}-M`, variantCode: `RTL-${S}-M`, colorName: 'Blue', size: 'M', sellingPrice: 999 } as any });
  check('the owner renames and reprices a retail item', (await owner(() => productService.updateProduct(rp.id, cA, { title: 'Cotton kurti', basePrice: 899 }))) === 'saved');
  check('...changes its colour, size and cost', (await owner(() => variantService.updateVariant(rv.id, cA, { colorName: 'Navy', size: 'L', costPrice: 400 }))) === 'saved');
  check('...adds a colour and deletes one', (await owner(() => variantService.createVariant(rp.id, cA, { colorName: 'Red', size: 'M', sku: `RTL-${S}-R`, sellingPrice: 899 }))) === 'saved'
    && (await owner(() => variantService.deleteVariant(rv.id, cA))) === 'saved');

  console.log('\nEACH BOUTIQUE ITS OWN LIMIT');
  await BUSY('POST', '/link', { shopName: 'Busy' });
  const codes: number[] = [];
  for (let wave = 0; wave < 32; wave++) codes.push(...(await Promise.all(Array.from({ length: 50 }, () => BUSY('GET', '/status')))).map(r => r.status));
  const ok = codes.filter(c => c === 200).length, slowed = codes.filter(c => c === 429).length;
  const last = await BUSY('GET', '/status');
  check(`a busy boutique sending 1,600 calls in a minute: 1,500 answered, the rest 429 (got ${ok} / ${slowed})`, ok <= 1500 && ok >= 1400 && slowed >= 100 && ok + slowed === 1600, { ok, slowed, other: codes.filter(c => c !== 200 && c !== 429) });
  check('...the 429 says what to do, in words', last.status === 429 && /Wait a few seconds and send it again with the same request id/.test(last.message ?? ''), last);
  const other = await B('GET', '/status');
  check('...while another boutique, at the same moment, is answered as usual', other.status === 200, other.status);
  check('...and the limit is announced in the answer headers', String(last.headers['ratelimit-limit'] ?? last.headers['ratelimit-policy'] ?? '').includes('1500'), last.headers);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'locktest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
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
