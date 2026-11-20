/**
 * Barcodes, scanning and label sheets for boutique items, and the till's boutique-link lookup (20 Nov 2026,
 * PLAN-boutique-backend.md part 1), against the REAL local server and database.
 *
 * Every new boutique item gets an SVM barcode (like Inventory's own items) or keeps the maker's; a barcode is never
 * on two items (in any shop) and never another item's code in the same shop; a save without one keeps it; old items
 * get theirs from /items/barcodes/fill; /items/scan finds by barcode first, then item code / SKU / BV- code, and only
 * this shop's boutique items; /labels makes the 50 x 25 mm PDF (prices per metre for cloth, a store's own price), with
 * bars identical to JsBarcode's (what the Inventory app prints with); /pos/v1/boutique-link tells a till its shop's
 * boutique, and that it ended.
 *
 * Throwaway accounts only (labtest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-labels.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { generateCredential } from '../utils/storefrontCredential';
import { POS_BASE_URL } from '../utils/posConnection';
import { code128B } from '../services/boutique/code128';
import { labelItems } from '../services/boutique/labels';
import { disableForClient, enableForClient } from '../services/boutique';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `labtest-${S}`, TEN2 = `labtest-${S}-b`;
const PLAIN = `labtest-plain-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const ALL = ['products:write', 'stock:write'];
const pass = (tenant: string, can = ALL) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[]; raw?: boolean } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    responseType: o.raw ? 'arraybuffer' : 'json',
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `lab-${S}-${++n}` } : {}) } });
  if (o.raw) return { status: r.status, body: Buffer.from(r.data), type: String(r.headers['content-type'] ?? ''), data: undefined as any, message: undefined as string | undefined };
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, body: Buffer.alloc(0), type: '' };
}
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const silk = (extra: Record<string, unknown> = {}) => ({ name: 'Kanchi silk', kind: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, sellInShop: true, ...extra });
const saree = (extra: Record<string, unknown> = {}) => ({ name: 'Finished saree', category: 'FINISHED', unit: 'PIECE', color: 'Gold', sellingPrice: 2499.5, sellInShop: true, ...extra });
const till = (key: string) => (p: string) => axios.get(`${BASE}/pos/v1${p}`, { headers: key ? { 'X-Storefront-Key': key } : {}, validateStatus: () => true });

async function main() {
  console.log('\nBARS ARE THE SAME AS THE APP PRINTS');
  {
    // JsBarcode is the Inventory app's (frontend) barcode maker; its CODE128B gives the same 1/0 modules.
    const jsb = require(path.resolve(__dirname, '../../../frontend/node_modules/jsbarcode/bin/barcodes')).default ?? require(path.resolve(__dirname, '../../../frontend/node_modules/jsbarcode/bin/barcodes'));
    const values = ['SVM-AB12CD34', 'SVM-00000000', '8901234567890', 'PRD-0001', 'a.b/c-d', 'Z', '~}|{', 'SVM-zz99yy88'];
    const diff = values.filter(v => new jsb.CODE128B(v, {}).encode().data !== code128B(v));
    check('8 values: bar for bar identical to JsBarcode CODE128B', diff.length === 0, diff);
  }

  console.log('\nA NEW ITEM GETS A BARCODE');
  const link = await call('POST', '/link', { shopName: 'Label Test Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  const A = `${S}-A`, M = `${S}-M`, F = `${S}-F`;
  const a = await call('PUT', `/items/${A}`, silk());
  check('new cloth item: 201 with an SVM barcode', a.status === 201 && /^SVM-[A-Z0-9]{8}$/.test(a.data?.barcode ?? ''), a);
  const aCode = a.data?.barcode as string;
  const a2 = await call('PUT', `/items/${A}`, silk({ sellingPrice: 460 }));
  check('saved again without a barcode: the same barcode stays', a2.status === 200 && a2.data?.barcode === aCode, a2.data?.barcode);
  const a3 = await call('PUT', `/items/${A}`, silk({ barcode: '' }));
  check('an empty barcode does not take it off', a3.status === 200 && a3.data?.barcode === aCode, a3.data?.barcode);
  check('GET /items/:code shows the barcode', (await call('GET', `/items/${A}`)).data?.barcode === aCode);
  const row = await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: A }, select: { barcodeType: true } });
  check('stored as Code 128, like the app\'s own items', row?.barcodeType === 'INTERNAL_CODE128');

  console.log('\nTHE MAKER\'S OWN BARCODE');
  const EAN = `89${String(Date.now()).slice(-11)}`;
  const m = await call('PUT', `/items/${M}`, silk({ barcode: EAN, color: 'Green' }));
  check('an item with the maker\'s barcode keeps it', m.status === 201 && m.data?.barcode === EAN, m);
  const dup = await call('PUT', `/items/${S}-X`, silk({ barcode: EAN }));
  check('the same barcode on a second item: 409, and the item is not made', dup.status === 409 && /already on another item/.test(dup.message ?? '')
    && !(await prisma.productVariant.count({ where: { clientId, boutiqueRef: `${S}-X` } })), dup);
  const link2 = await call('POST', '/link', { shopName: 'Second' }, { tenant: TEN2 });
  const other = await call('PUT', `/items/${S}-O`, silk({ barcode: EAN }), { tenant: TEN2 });
  check('...in ANOTHER shop too (barcodes are unique everywhere), without saying whose', link2.status === 201 && other.status === 409 && !/Label Test|labtest/.test(other.message ?? ''), other);
  const asCode = await call('PUT', `/items/${S}-Y`, silk({ barcode: A }));
  check('a barcode that is another item\'s code in this shop: 409', asCode.status === 409 && /another item's code/.test(asCode.message ?? ''), asCode);
  const codeAsBarcode = await call('PUT', `/items/${EAN}`, silk());
  check('an item code that is already a barcode in this shop: 409', codeAsBarcode.status === 409, codeAsBarcode);
  for (const [v, why] of [['ab', 'too short'], ['has space', 'a space'], ['x'.repeat(49), 'too long'], ['Ã„Ã–Ãœ1234', 'not plain letters']]) {
    const r = await call('PUT', `/items/${S}-Z`, silk({ barcode: v }));
    check(`a barcode ${why}: 400`, r.status === 400 && /4 to 48/.test(r.message ?? ''), r);
  }
  const NEW = `SHOP-${S}`.toUpperCase();
  const ch = await call('PUT', `/items/${M}`, silk({ barcode: NEW, color: 'Green' }));
  check('a barcode can be changed', ch.status === 200 && ch.data?.barcode === NEW, ch);
  const reuse = await call('PUT', `/items/${S}-R`, silk({ barcode: EAN }));
  check('...and the old one is free again', reuse.status === 201 && reuse.data?.barcode === EAN, reuse);
  const same = await call('PUT', `/items/${M}`, silk({ barcode: NEW, color: 'Green' }));
  check('sending an item its own barcode again is fine', same.status === 200 && same.data?.barcode === NEW, same);
  // Deleted, then the same cloth added again with the maker's barcode (found 20 Nov: the deleted item kept it).
  const DEL = `${S}-DEL`, BACK = `${S}-BACK`, DEL_BAR = `DELBAR-${S}`.toUpperCase();
  await call('PUT', `/items/${DEL}`, silk({ barcode: DEL_BAR, color: 'Blue' }));
  const gone = await call('DELETE', `/items/${DEL}`, undefined, { can: [...ALL, 'products:delete'] });
  const back = await call('PUT', `/items/${BACK}`, silk({ barcode: DEL_BAR, color: 'Blue' }));
  check('an item deleted, then added again with its maker barcode: allowed', gone.status === 200 && back.status === 201 && back.data?.barcode === DEL_BAR, [gone.status, gone.message, back.status, back.message]);
  check('...the scan finds the new item, not the deleted one', (await call('GET', `/items/scan?code=${DEL_BAR}`)).data?.item?.itemCode === BACK);
  // Two new items with the same barcode at the same moment: one gets it, the other is told -- never a crash.
  const RACE = `RACE-${S}`.toUpperCase();
  const race = await Promise.all([1, 2].map(i => call('PUT', `/items/${S}-RC${i}`, silk({ barcode: RACE, color: `C${i}` }))));
  check('two saves racing for one barcode: one 201, one 409, no 500', race.map(r => r.status).sort().join() === '201,409', race.map(r => [r.status, r.message]));
  const race2 = await Promise.all([call('PUT', `/items/${S}-RD1`, silk({ barcode: `${RACE}-2` })), call('PUT', `/items/${S}-RD2`, silk({ barcode: `${RACE}-2` }), { tenant: TEN2 })]);
  check('...and across two shops', race2.map(r => r.status).sort().join() === '201,409', race2.map(r => [r.status, r.message]));
  const f = await call('PUT', `/items/${F}`, saree());
  check('a finished garment gets one too', f.status === 201 && /^SVM-/.test(f.data?.barcode ?? ''), f);

  console.log('\nSCANNING');
  const byBar = await call('GET', `/items/scan?code=${encodeURIComponent(NEW)}`);
  check('by barcode: the item, matched by barcode', byBar.status === 200 && byBar.data?.item?.itemCode === M && byBar.data?.matchedBy === 'barcode', byBar);
  const bySvm = await call('GET', `/items/scan?code=${aCode}`);
  check('by an SVM barcode', bySvm.data?.item?.itemCode === A && bySvm.data?.item?.stockText !== undefined, bySvm);
  const byCode = await call('GET', `/items/scan?code=${A}`);
  check('by the item code typed in: matched by code', byCode.data?.item?.itemCode === A && byCode.data?.matchedBy === 'code', byCode);
  check('by the BV- code', (await call('GET', `/items/scan?code=BV-${F}`)).data?.item?.itemCode === F);
  const none = await call('GET', '/items/scan?code=NOPE-123');
  check('an unknown code: 404 saying so', none.status === 404 && /NOPE-123/.test(none.message ?? ''), none);
  check('no code: 400', (await call('GET', '/items/scan')).status === 400);
  const theirs = await call('GET', `/items/scan?code=${aCode}`, undefined, { tenant: TEN2 });
  check('another shop cannot scan this shop\'s item', theirs.status === 404, theirs);
  // One of the shop's own items (added in Inventory, not by the boutique).
  const prod = await prisma.product.create({ data: { clientId, productCode: `OWN-${S}`, slug: `own-${S}`, title: 'Own kurta', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, status: 'ACTIVE' as any, basePrice: 999 } as any });
  await prisma.productVariant.create({ data: { clientId, productId: prod.id, sku: `OWN-${S}-1`, variantCode: `OWNV-${S}`, colorName: 'Blue', size: 'M', barcode: `SVM-OWN${S}`.slice(0, 20), sellingPrice: 999 } as any });
  const own = await call('GET', `/items/scan?code=OWN-${S}-1`);
  check('the shop\'s own (non-boutique) item: 404 that says what it is', own.status === 404 && /own items/.test(own.message ?? ''), own);

  console.log('\nOLD ITEMS WITHOUT A BARCODE');
  await prisma.productVariant.updateMany({ where: { clientId, boutiqueRef: { in: [A, F] } }, data: { barcode: null } });
  check('an old item reads back with barcode null', (await call('GET', `/items/${A}`)).data?.barcode === null);
  const noPerm = await call('POST', '/items/barcodes/fill', {}, { can: ['stock:write'] });
  check('fill without products:write: 403', noPerm.status === 403, noPerm);
  const fill = await call('POST', '/items/barcodes/fill', {});
  check('fill: 2 given, none left', fill.status === 200 && fill.data?.given === 2 && fill.data?.stillWithout === 0, fill);
  const aNew = (await call('GET', `/items/${A}`)).data?.barcode;
  check('...the item has a fresh SVM barcode', /^SVM-/.test(aNew ?? '') && aNew !== aCode, aNew);
  const again = await call('POST', '/items/barcodes/fill', {});
  check('fill again: nothing to give', again.data?.given === 0 && again.data?.stillWithout === 0, again);
  check('the shop\'s own item was not touched by fill', (await prisma.productVariant.findFirst({ where: { clientId, sku: `OWN-${S}-1` } }))?.barcode === `SVM-OWN${S}`.slice(0, 20));
  await prisma.productVariant.updateMany({ where: { clientId, boutiqueRef: F }, data: { barcode: null } });
  const saved = await call('PUT', `/items/${F}`, saree({ sellingPrice: 2600 }));
  check('an old item saved again gets its barcode then', /^SVM-/.test(saved.data?.barcode ?? ''), saved.data);

  console.log('\nLABELS');
  const pdf = await call('POST', '/labels', { itemCodes: [A, M] }, { raw: true });
  check('two items: a PDF with 2 labels', pdf.status === 200 && /application\/pdf/.test(pdf.type) && pdf.body.subarray(0, 4).toString() === '%PDF' && pages(pdf.body) === 2, { status: pdf.status, type: pdf.type, pages: pages(pdf.body) });
  const three = await call('POST', '/labels', { itemCodes: [A, M], copies: 3 }, { raw: true });
  check('3 copies of each: 6 labels', three.status === 200 && pages(three.body) === 6, pages(three.body));
  const twice = await call('POST', '/labels', { itemCodes: [A, A] }, { raw: true });
  check('the same code twice prints it once (copies says how many)', twice.status === 200 && pages(twice.body) === 1, pages(twice.body));
  const miss = await call('POST', '/labels', { itemCodes: [A, 'NOPE-1'] });
  check('a code not in the shop: 404 naming it', miss.status === 404 && /NOPE-1/.test(miss.message ?? ''), miss);
  const otherShop = await call('POST', '/labels', { itemCodes: [A] }, { tenant: TEN2 });
  check('another shop cannot print this shop\'s labels', otherShop.status === 404, otherShop);
  await prisma.productVariant.updateMany({ where: { clientId, boutiqueRef: F }, data: { barcode: null } });
  const nob = await call('POST', '/labels', { itemCodes: [F] });
  check('an item with no barcode yet: 409 that says how to give it one', nob.status === 409 && /barcodes\/fill/.test(nob.message ?? ''), nob);
  for (const [body, why] of [[{ itemCodes: [] }, 'no codes'], [{ itemCodes: [A], copies: 0 }, 'copies 0'], [{ itemCodes: [A], copies: 51 }, 'copies 51'], [{ itemCodes: [A], copies: 1.5 }, 'copies 1.5'], [{ itemCodes: Array.from({ length: 101 }, (_, i) => `C${i}`) }, '101 codes']] as const) {
    const r = await call('POST', '/labels', body);
    check(`${why}: 400`, r.status === 400, r);
  }
  const badStore = await call('POST', '/labels', { itemCodes: [A], storeId: '00000000-0000-0000-0000-000000000000' });
  check('a store not in this shop: 404', badStore.status === 404, badStore);
  check('a label without permissions still prints (a read)', (await call('POST', '/labels', { itemCodes: [A] }, { can: [], raw: true })).status === 200);

  console.log('\nLABEL PRICES');
  const store = await prisma.stockLocation.findFirst({ where: { clientId, active: true } });
  const li = await labelItems(clientId, [A, `${S}-R`], null);
  const la = li.items.find(i => i.sku === A);
  check('cloth: the price per metre (450, its last saved price), marked per m', la?.price === 450 && la?.per === 'm', la);
  const vA = await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: A } });
  // A store's own price is stored like every price: per base unit (a centimetre), so 5.2 a cm is 520 a metre.
  await prisma.variantLocationProfile.create({ data: { variantId: vA!.id, locationId: store!.id, priceOverride: 5.2 } as any });
  const atStore = (await labelItems(clientId, [A], store!.id)).items[0];
  check('at a store with its own price: that price (520 a metre)', atStore?.price === 520, atStore);
  const sareeLabel = (await labelItems(clientId, [M, F], null));
  check('a piece item: price as is, no "per"', sareeLabel.items.length === 1 && sareeLabel.noBarcode.join() === F, sareeLabel);
  const withStore = await call('POST', '/labels', { itemCodes: [A], storeId: store!.id }, { raw: true });
  check('the PDF at that store is made', withStore.status === 200 && pages(withStore.body) === 1);

  console.log('\nTHE TILL ASKS WHICH BOUTIQUE');
  const cred = generateCredential();
  await prisma.storefrontConnection.create({ data: { clientId, name: 'Till 1', baseUrl: POS_BASE_URL, credentialHash: cred.hash, credentialPrefix: cred.prefix, status: 'ACTIVE' as any, locationIds: [] } });
  const t = till(cred.plaintext);
  const l1 = await t('/boutique-link');
  check('linked: tenant (as stored), linkedAt, active true', l1.status === 200 && l1.data?.data?.tenant === TEN && !!l1.data?.data?.linkedAt && l1.data?.data?.active === true, l1.data);
  check('no key: refused', [401, 403].includes((await till('')('/boutique-link')).status));
  const web = generateCredential();
  await prisma.storefrontConnection.create({ data: { clientId, name: 'Website', type: 'GENERIC' as any, baseUrl: 'https://example.invalid/hook', credentialHash: web.hash, credentialPrefix: web.prefix, status: 'ACTIVE' as any, locationIds: [] } });
  check('a website key: refused (tills only)', [401, 403].includes((await till(web.plaintext)('/boutique-link')).status));
  await disableForClient(clientId);
  const l2 = await t('/boutique-link');
  check('turned off: active false, still naming the account it was', l2.status === 200 && l2.data?.data?.active === false && l2.data?.data?.tenant === TEN, l2.data);
  await enableForClient(clientId, TEN);
  const l3 = await t('/boutique-link');
  check('turned on again: active true', l3.data?.data?.active === true && l3.data?.data?.tenant === TEN, l3.data);
  // A shop that never had a boutique.
  const plain = generateCredential();
  await prisma.storefrontConnection.create({ data: { clientId: PLAIN, name: 'Till', baseUrl: POS_BASE_URL, credentialHash: plain.hash, credentialPrefix: plain.prefix, status: 'ACTIVE' as any, locationIds: [] } });
  const l4 = await till(plain.plaintext)('/boutique-link');
  check('a shop with no boutique: tenant null, active false', l4.status === 200 && l4.data?.data?.tenant === null && l4.data?.data?.active === false, l4.data);
}

async function cleanup() {
  const ids = [...(await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'labtest-' } }, select: { clientId: true } })).map(l => l.clientId), PLAIN];
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM variant_location_profiles WHERE variant_id IN (SELECT id FROM inventory_product_variants WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM storefront_deliveries WHERE connection_id IN (SELECT id FROM storefront_connections WHERE client_id = ANY($1))`, ids).catch(() => undefined);
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
