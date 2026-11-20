/**
 * The rest of Inventory's offer screen through the boutique API (20 Nov 2026, the owner: "offers also should be used by
 * them"): the choices an offer can be for, finding a design or item by name (answered with the boutique's codes),
 * copying an offer, and the offer's Shopify copy -- against the REAL local server and database.
 *
 * Shopify is not connected on this machine, so the Shopify calls are proved for: who may, another shop's offer,
 * "not connected", a draft refused, "not on Shopify". A real Shopify round trip is not made here.
 *
 * Throwaway accounts only (omtest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-offers-more.ts
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
const TEN = `omtest-${S}`, TEN2 = `omtest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const OWNER = ['products:write', 'products:delete', 'stock:write', 'offers:write'];
const STAFF = ['products:write', 'stock:write'];
const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[]; key?: string } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can ?? OWNER)}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `om-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, raw: r.data, replay: r.headers['idempotent-replay'] };
}
const since = new Date(Date.now() - 3600_000).toISOString();

async function main() {
  const link = await call('POST', '/link', { shopName: 'Offers More Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  const B = `${S}-BL`, K = `${S}-KR`, GONE = `${S}-GN`;
  await call('PUT', `/items/${B}`, { name: 'Ready blouse', category: 'FINISHED', unit: 'PIECE', sellingPrice: 1000, gstPercent: 5, hsnCode: '6206', sellInShop: true });
  await call('PUT', `/items/${K}`, { name: `Kurta ${S}`, category: 'FINISHED', unit: 'PIECE', sellingPrice: 2000, gstPercent: 5, hsnCode: '6211', sellInShop: true });
  await call('PUT', `/items/${GONE}`, { name: `Kurta gone ${S}`, category: 'FINISHED', unit: 'PIECE', sellingPrice: 1500, sellInShop: true });
  await call('POST', '/link', { shopName: 'Other' }, { tenant: TEN2 });
  const O2 = `${S}-O2`;
  await call('PUT', `/items/${O2}`, { name: `Kurta theirs ${S}`, category: 'FINISHED', unit: 'PIECE', sellingPrice: 900, sellInShop: true }, { tenant: TEN2 });

  console.log('\nCHOICES: WHAT AN OFFER CAN BE FOR');
  const ch = await call('GET', '/offers/choices', undefined, { can: [] });
  const d = ch.data;
  check('anyone of the boutique may read: 200', ch.status === 200, ch);
  check('departments, each with a name and how many designs', Array.isArray(d?.departments) && d.departments.length > 0 && d.departments.every((x: any) => typeof x.name === 'string' && typeof x.designs === 'number'), d?.departments);
  check('...our three items are counted under one department', d?.departments?.reduce((s: number, x: any) => s + x.designs, 0) === 3, d?.departments);
  check('stores with storeId and name (what storeIds takes)', Array.isArray(d?.stores) && d.stores.length >= 1 && d.stores.every((s: any) => s.storeId && s.name), d?.stores);
  check('channels: the till and the online store', JSON.stringify(d?.channels?.map((c: any) => c.value)) === '["POS","ONLINE"]', d?.channels);
  check('dress types and customer groups are lists', Array.isArray(d?.dressTypes) && Array.isArray(d?.customerTags), d);
  check('no internal ids leak as "id" or "value" keys', !/"(id|value)":/.test(JSON.stringify({ ...d, channels: [] })), d);
  const dept = d?.departments?.find((x: any) => x.designs === 3)?.name;
  const made = await call('POST', '/offers', { name: `Dept ${S}`, valueType: 'PERCENTAGE', value: 10, scope: 'CATEGORY', targets: [{ scope: 'CATEGORY', name: dept }], startsAt: since });
  check('a department name from choices works as a target', made.status === 201 && made.data?.targets?.[0]?.name === String(dept).toUpperCase(), made);

  console.log('\nFIND A DESIGN OR AN ITEM, BY NAME');
  const fv = await call('GET', `/offers/find?scope=VARIANT&q=${encodeURIComponent(`Kurta ${S}`)}`, undefined, { can: [] });
  check('an item by name: answered with the boutique\'s own code', fv.status === 200 && fv.data?.some((r: any) => r.code === K && r.scope === 'VARIANT' && r.name === `Kurta ${S}`), fv);
  check('...never another shop\'s item', !JSON.stringify(fv.data).includes(O2), fv.data);
  const pc = (await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: K }, select: { product: { select: { productCode: true } } } }))!.product.productCode;
  const fp = await call('GET', `/offers/find?scope=product&q=${encodeURIComponent(`Kurta ${S}`)}`);
  check('a design by name (scope in any case): its product code', fp.status === 200 && fp.data?.some((r: any) => r.code === pc && r.scope === 'PRODUCT'), fp);
  const used = await call('POST', '/offers', { name: `Found ${S}`, valueType: 'FIXED_AMOUNT', value: 100, scope: 'VARIANT', targets: [{ scope: 'VARIANT', code: fv.data?.[0]?.code }], startsAt: since });
  check('a found code works as a target straight away', used.status === 201, used);
  const del = await call('DELETE', `/items/${GONE}`);
  const fg = await call('GET', `/offers/find?scope=VARIANT&q=${encodeURIComponent(`Kurta gone ${S}`)}`);
  check('a deleted item is not found', [200, 204].includes(del.status) && fg.status === 200 && !JSON.stringify(fg.data).includes(GONE), { del: del.status, fg: fg.data });
  check('a scope that is not PRODUCT or VARIANT: 400 in words', (await call('GET', '/offers/find?scope=SHELF&q=x')).status === 400);
  const weird = await call('GET', `/offers/find?scope=VARIANT&q=${encodeURIComponent("%_\\'; drop")}`);
  check('odd characters in the search: 200, an empty list, no crash', weird.status === 200 && Array.isArray(weird.data) && weird.data.length === 0, weird);
  const empty = await call('GET', '/offers/find?scope=VARIANT');
  check('no search words: up to 20 of the shop\'s items', empty.status === 200 && Array.isArray(empty.data) && empty.data.length >= 2 && empty.data.length <= 20, empty);

  console.log('\nCOPY AN OFFER');
  const CODE = `OM${S}`.toUpperCase().slice(0, 12);
  const coded = await call('POST', '/offers', { name: `Code ${S}`, trigger: 'CODE', couponCode: CODE, valueType: 'FIXED_AMOUNT', value: 100, scope: 'VARIANT', targets: [{ scope: 'VARIANT', code: B }], startsAt: since });
  await call('POST', `/offers/${coded.data?.id}/status`, { status: 'ACTIVE' });
  const noPerm = await call('POST', `/offers/${coded.data?.id}/copy`, {}, { can: STAFF });
  check('without offers:write: 403', noPerm.status === 403, noPerm);
  const cp = await call('POST', `/offers/${coded.data?.id}/copy`, {}, { key: `om-${S}-copy` });
  check('copied: 201, a new draft "Copy of ...", same rule and target', cp.status === 201 && cp.data?.id !== coded.data?.id && cp.data?.status === 'DRAFT'
    && cp.data?.name === `Copy of Code ${S}` && cp.data?.value === 100 && cp.data?.targets?.[0]?.code === B, cp);
  check('...with its own code (<code>-COPY), never the original\'s', cp.data?.couponCode === `${CODE}-COPY`, cp.data?.couponCode);
  const again = await call('POST', `/offers/${coded.data?.id}/copy`, {}, { key: `om-${S}-copy` });
  check('the same request again: the same copy, not a second one', again.status === 201 && again.data?.id === cp.data?.id && (await prisma.offer.count({ where: { clientId, name: `Copy of Code ${S}` } })) === 1, again);
  const ver = await prisma.offerVersion.findFirst({ where: { offerId: cp.data?.id }, select: { changedBy: true } });
  check('its history names the person: "Lakshmi (Boutique)"', ver?.changedBy === 'Lakshmi (Boutique)', ver);
  check('another shop cannot copy it: 404', (await call('POST', `/offers/${coded.data?.id}/copy`, {}, { tenant: TEN2 })).status === 404);
  check('an offer id that is not one: 404', (await call('POST', '/offers/nope-not-an-offer/copy', {})).status === 404);

  console.log('\nTHE OFFER ON SHOPIFY (no Shopify connected here)');
  const id = coded.data?.id;
  const ov = await call('GET', `/offers/${id}/shopify`, undefined, { can: [] });
  check('anyone may look: { connected: false } for a shop without Shopify', ov.status === 200 && ov.data?.connected === false, ov);
  check('another shop\'s offer: 404', (await call('GET', `/offers/${id}/shopify`, undefined, { tenant: TEN2 })).status === 404);
  check('put on Shopify without offers:write: 403', (await call('POST', `/offers/${id}/shopify`, {}, { can: STAFF })).status === 403);
  const on = await call('POST', `/offers/${id}/shopify`, {});
  check('put on Shopify with no store connected: 400 saying so', on.status === 400 && /Shopify/i.test(on.message ?? '') && /connected/i.test(on.message ?? ''), on);
  const draftOn = await call('POST', `/offers/${cp.data?.id}/shopify`, {});
  check('a draft: 400 "start the offer first"', draftOn.status === 400 && /start the offer/i.test(draftOn.message ?? ''), draftOn);
  const off = await call('DELETE', `/offers/${id}/shopify`);
  check('take off when it is not on Shopify: 404 in words', off.status === 404 && /not on Shopify/i.test(off.message ?? ''), off);
  check('push ours when it is not on Shopify: 404', (await call('POST', `/offers/${id}/shopify/push`, {})).status === 404);
  check('accept theirs when it is not on Shopify: 404', (await call('POST', `/offers/${id}/shopify/accept`, {})).status === 404);
  check('push/accept for another shop\'s offer: 404', (await call('POST', `/offers/${id}/shopify/push`, {}, { tenant: TEN2 })).status === 404 && (await call('POST', `/offers/${id}/shopify/accept`, {}, { tenant: TEN2 })).status === 404);
  check('nothing was recorded for Shopify', (await prisma.offerExternalMirror.count({ where: { clientId } })) === 0);

  console.log('\nOLD CALLS STILL WORK');
  check('GET /offers/{id} still answers (choices/find did not swallow it)', (await call('GET', `/offers/${id}`)).data?.id === id);
  check('GET /offers lists all four', (await call('GET', '/offers')).data?.length === 4);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'omtest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  await prisma.$executeRawUnsafe(`DELETE FROM offers WHERE client_id = ANY($1)`, ids).catch(e => console.error('offers', e.message));
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
