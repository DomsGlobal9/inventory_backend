/**
 * The boutique (CRM-B) on ScaleEzy Inventory, end to end against the REAL local server (PLAN-boutique-sync.md):
 * the signed pass, linking (new boutique-only shop, and an existing shop with the owner's code), items, stock in
 * metres, holds for stitching orders, retries, races, materials kept out of selling, and the boutique's price lock.
 *
 * Throwaway shops only (boutique-btqtest-*, btqretail-*), all removed at the end. Local database and server only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { ELIGIBLE_PRODUCT, FEED_PRODUCT } from '../services/storefront-catalogue.service';
import { makeLinkCode } from '../services/boutique';
import { productService } from '../services/product.service';
import { variantService } from '../services/variant.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const STAMP = Date.now().toString(36);
const T1 = `btqtest-${STAMP}`;            // a boutique-only client
const T2 = `btqtest2-${STAMP}`;           // a boutique that also has retail on ScaleEzy
const RETAIL = `btqretail-${STAMP}`;      // that client's existing ScaleEzy shop
let bad = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };
const ALL = ['products:write', 'stock:write', 'stitching:issue'];
// The same answer, whatever order the stored JSON keeps its keys in.
const same = (a: any, b: any) => JSON.stringify(a, Object.keys(a ?? {}).sort()) === JSON.stringify(b, Object.keys(b ?? {}).sort());

type PassOpts = { tenant?: string | null; can?: string[]; name?: string | null; scope?: string[]; life?: string; clientId?: string };
const pass = (o: PassOpts = {}) => jwt.sign({
  sub: 'crm-b', scope: o.scope ?? ['modules:boutique'],
  ...(o.tenant === null ? {} : { tenant: o.tenant ?? T1 }),
  ...(o.clientId ? { clientId: o.clientId } : {}),
  onBehalfOf: { userId: 'staff-7', ...(o.name === null ? {} : { name: o.name ?? 'Lakshmi (cutting)' }), can: o.can ?? ALL }
}, privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: (o.life ?? '5m') as any });

let reqN = 0;
const rid = () => `t-${STAMP}-${++reqN}`;
async function call(method: string, path: string, body?: unknown, o: PassOpts & { requestId?: string | null } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${pass(o)}` };
  if (method !== 'GET' && o.requestId !== null) headers['Idempotency-Key'] = o.requestId ?? rid();
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, headers, data: body, validateStatus: () => true, timeout: 90_000 });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, replay: r.headers['idempotent-replay'] };
}
const stockOf = async (clientId: string, itemCode: string) => {
  const v = await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: itemCode }, include: { stocks: true } });
  return { qty: v?.stocks.reduce((n, s) => n + s.quantity, 0) ?? 0, held: v?.stocks.reduce((n, s) => n + s.reservedQty, 0) ?? 0, v };
};

async function main() {
  console.log('THE PASS');
  const noScope = await call('GET', '/items', undefined, { scope: ['modules:crm'] });
  check('no modules:boutique scope is refused (and nothing read)', (noScope.status === 401 || noScope.status === 403) && noScope.data === undefined, noScope);
  check('a pass without the boutique account (tenant) is refused', (await call('GET', '/items', undefined, { tenant: null })).status === 401);
  check('a pass valid for an hour is refused (15 minutes at most)', (await call('GET', '/items', undefined, { life: '1h' })).status === 401);
  check('a pass not naming the person is refused', (await call('GET', '/items', undefined, { name: null })).status === 401);
  const forged = jwt.sign({ sub: 'x', scope: ['modules:boutique'], tenant: T1, onBehalfOf: { userId: 'a', name: 'b', can: ALL } }, 'not-the-key', { audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
  check('a pass not signed with the boutique key is refused', (await axios.get(`${BASE}/internal/boutique/items`, { headers: { Authorization: `Bearer ${forged}` }, validateStatus: () => true })).status === 401);
  const notLinked = await call('GET', '/items');
  check('before linking, nothing can be read', notLinked.status === 403 && /not linked/.test(notLinked.message ?? ''), notLinked);

  console.log('\nLINKING A BOUTIQUE-ONLY CLIENT');
  const l1 = await call('POST', '/link', { shopName: 'Test Boutique' });
  const C1 = l1.data?.clientId as string;
  check('linking makes a new shop for it', l1.status === 201 && /^boutique-btqtest-/.test(C1), l1);
  if (!C1) throw new Error('linking failed, nothing else can be checked');
  const l1b = await call('POST', '/link', { shopName: 'Test Boutique' });
  check('linking again is the same link (no second shop)', l1b.status === 200 && l1b.data?.clientId === C1 && l1b.data?.linked === 'already', l1b);
  const stores = await call('GET', '/stores');
  check('the new shop has one store, ready', stores.status === 200 && stores.data?.length === 1, stores);
  const st = await prisma.clientSettings.findUnique({ where: { clientId: C1 } });
  check('...and fabrics by the metre are on', st?.fabricsOn === true, st);
  check('...and no logins were made (no emails, no onboarding)', (await prisma.user.count({ where: { clientId: C1 } })) === 0);
  const sneaky = await call('POST', '/link', { linkCode: 'AAAA-BBBB' });
  check('a made-up link code cannot attach it to some other shop', sneaky.status === 403, sneaky);

  console.log('\nITEMS');
  const silk = { name: 'Kanchi silk, maroon', designGroup: 'KANCHI-01', kind: 'FABRIC', unit: 'METER', color: 'Maroon', colorHex: '#800000', widthCm: 112, sellingPrice: 450, purchasePrice: 280, gstPercent: 5, hsnCode: '5007', sellInShop: true };
  const a1 = await call('PUT', '/items/KS-MAR', silk);
  check('an item by the metre is added', a1.status === 201 && a1.data?.unit === 'METRE' && a1.data?.sellingPrice === 450, a1);
  const db1 = await stockOf(C1, 'KS-MAR');
  const prod = db1.v ? await prisma.product.findUnique({ where: { id: db1.v.productId } }) : null;
  check('...stored per centimetre (₹4.50/cm), price owned by the boutique', Number(db1.v?.sellingPrice) === 4.5 && prod?.priceOwner === 'BOUTIQUE', { sp: db1.v?.sellingPrice, owner: prod?.priceOwner });
  const a2 = await call('PUT', '/items/KS-GRN', { ...silk, color: 'Green', colorHex: '#006400' });
  const gv = await stockOf(C1, 'KS-GRN');
  check('a second colour of the same design joins the same product', a2.status === 201 && gv.v?.productId === db1.v?.productId, a2);
  const again = await call('PUT', '/items/KS-MAR', { ...silk, name: 'Kanchi silk' });
  check('sending the same item again changes it, never duplicates it', again.status === 200 && (await prisma.productVariant.count({ where: { clientId: C1, boutiqueRef: 'KS-MAR' } })) === 1, again);
  check('₹450.50 per metre is refused in words (whole rupees)', (await call('PUT', '/items/KS-X', { ...silk, sellingPrice: 450.5 })).status === 400);
  check('an unknown unit (YARD) is refused in words', /not known/.test((await call('PUT', '/items/KS-Y', { ...silk, unit: 'YARD' })).message ?? ''));
  check('an item without a name is refused', (await call('PUT', '/items/KS-Z', { ...silk, name: '' })).status === 400);
  const noWrite = await call('PUT', '/items/KS-Q', silk, { can: ['stock:write'] });
  check('a person the boutique did not allow to add items is refused', noWrite.status === 403, noWrite);
  const weird = await call('PUT', '/items/KS-W', silk, { can: ['*', 'admin:everything'] });
  check('made-up permissions in the pass give nothing', weird.status === 403, weird);
  const thread = await call('PUT', '/items/THR-RED', { name: 'Red thread', unit: 'PIECE', kind: 'NOTION', sellingPrice: 0 });
  check('a material (thread) is added, not for sale by default', thread.status === 201 && thread.data?.sellInShop === false, thread);
  check('...its unknown kind (NOTION) is kept as Other, and the answer says so', thread.data?.kind === 'OTHER' && /not known here yet/.test(thread.data?.note ?? ''), thread.data);
  check('no request id: the change is refused (a retry could repeat it)', (await call('PUT', '/items/KS-MAR', silk, { requestId: null })).status === 400);

  console.log('\nSTOCK IN METRES');
  const r1 = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'PURCHASE', quantity: '12.500', unitCost: 280 });
  check('12.500 m received = 1250 cm', r1.status === 200 && (await stockOf(C1, 'KS-MAR')).qty === 1250, r1);
  check('12.505 m is refused (not whole centimetres)', (await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'PURCHASE', quantity: 12.505 })).status === 400);
  check('0 m is refused', (await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'PURCHASE', quantity: 0 })).status === 400);
  check('a movement for an item never added is refused', (await call('POST', '/movements', { itemCode: 'NOPE', kind: 'PURCHASE', quantity: 1 })).status === 404);
  check('an unknown movement kind is refused', (await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'STEAL', quantity: 1 })).status === 400);
  const issueNoPerm = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'ISSUE', quantity: 1 }, { can: ['stock:write'] });
  check('cutting cloth for stitching needs that permission', issueNoPerm.status === 403, issueNoPerm);
  const over = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'ISSUE', quantity: 20 });
  check('issuing more than is there is refused, stock unchanged', over.status >= 400 && over.status < 500 && (await stockOf(C1, 'KS-MAR')).qty === 1250, over);
  const smallSale = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'SALE', quantity: 0.1 });
  check('a 10 cm sale is refused (smallest cut 25 cm)', smallSale.status === 400 || smallSale.status === 409 || smallSale.status === 422, smallSale);

  console.log('\nRETRIES AND RACES');
  const id = rid();
  const once1 = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'ISSUE', quantity: 1, orderRef: 'ORD-9' }, { requestId: id });
  const once2 = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'ISSUE', quantity: 5, orderRef: 'ORD-9' }, { requestId: id });
  check('the same request again gets the first answer, marked as a replay', once1.status === 200 && once2.status === 200 && once2.replay === 'true' && same(once1.data, once2.data), { once1, once2 });
  check('...and cut the cloth only once (1250 -> 1150)', (await stockOf(C1, 'KS-MAR')).qty === 1150, await stockOf(C1, 'KS-MAR'));
  const sameId = rid();
  const three = await Promise.all([1, 2, 3].map(() => call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'ISSUE', quantity: 0.5 }, { requestId: sameId })));
  check('three copies at the same moment cut 50 cm once', three.every(r => r.status === 200) && (await stockOf(C1, 'KS-MAR')).qty === 1100, three.map(r => r.status));
  const n = await prisma.inventoryTransaction.count({ where: { clientId: C1, notes: { contains: 'issue by' } } });
  check('...one movement row for each real change (2), not one per copy', n === 2, n);

  console.log('\nHOLDING CLOTH FOR A STITCHING ORDER');
  const h1 = await call('POST', '/holds', { itemCode: 'KS-MAR', quantity: 5, orderRef: 'ORD-1' });
  check('5 m held for ORD-1', h1.status === 201 && (await stockOf(C1, 'KS-MAR')).held === 500, h1);
  check('a hold without an order is refused', (await call('POST', '/holds', { itemCode: 'KS-MAR', quantity: 1 })).status === 400);
  const tooMuch = await call('POST', '/holds', { itemCode: 'KS-MAR', quantity: 7, orderRef: 'ORD-2' });
  check('holding more than is free (6 m free) is refused in metres', tooMuch.status === 409 && /6\.00 m|6 m/.test(tooMuch.message ?? ''), tooMuch);
  const eatHeld = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'SALE', quantity: 7 });
  check('a boutique sale cannot take cloth held for an order', eatHeld.status === 409 && /held/.test(eatHeld.message ?? ''), eatHeld);
  const eatHeld2 = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'DAMAGE', quantity: 7 });
  check('...nor a damage write-off', eatHeld2.status === 409, eatHeld2);
  const race = await Promise.all([1, 2].map(i => call('POST', '/holds', { itemCode: 'KS-MAR', quantity: 4, orderRef: `ORD-R${i}` })));
  check('two holds of 4 m racing for 6 m free: exactly one wins', race.filter(r => r.status === 201).length === 1 && race.filter(r => r.status === 409).length === 1, race.map(r => [r.status, r.message]));
  const winner = race.find(r => r.status === 201)!.data.reservationId;
  const rel = await call('POST', `/holds/${winner}/release`);
  check('an order cancelled before cutting lets its hold go', rel.status === 200 && (await stockOf(C1, 'KS-MAR')).held === 500, rel);
  check('releasing it again is refused', (await call('POST', `/holds/${winner}/release`)).status === 409);
  const iss = await call('POST', `/holds/${h1.data.reservationId}/issue`, { quantity: 3 });
  const after = await stockOf(C1, 'KS-MAR');
  check('cutting 3 of the 5 m held: 3 m off the shelf, 2 m back on sale', iss.status === 200 && iss.data?.backOnSale === 2 && after.qty === 800 && after.held === 0, { iss, after: { qty: after.qty, held: after.held } });
  check('issuing the same hold twice is refused', (await call('POST', `/holds/${h1.data.reservationId}/issue`)).status === 409);
  check('a hold from another shop cannot be touched', (await call('POST', `/holds/00000000-0000-0000-0000-000000000000/issue`)).status === 404);

  console.log('\nCOUNTS, MOVES, RETURNS');
  const cnt = await call('POST', '/counts', { itemCode: 'KS-MAR', counted: 7.25 });
  check('counted 7.25 m on the shelf: difference -0.75 m recorded', cnt.status === 200 && cnt.data?.difference === -0.75 && (await stockOf(C1, 'KS-MAR')).qty === 725, cnt);
  const store2 = await prisma.stockLocation.create({ data: { clientId: C1, name: 'Tailor unit', code: `TU-${STAMP}`, type: 'STORE' } });
  const first = stores.data[0].id;
  const tr = await call('POST', '/transfers', { itemCode: 'KS-MAR', quantity: 2, fromLocationId: first, toLocationId: store2.id });
  const rows = await prisma.inventoryStock.findMany({ where: { variant: { boutiqueRef: 'KS-MAR', clientId: C1 } } });
  check('2 m moved to the tailor unit: 5.25 m + 2 m', tr.status === 200 && rows.find(r => r.locationId === first)?.quantity === 525 && rows.find(r => r.locationId === store2.id)?.quantity === 200, { tr, rows: rows.map(r => [r.locationId === first ? 'main' : 'tailor', r.quantity]) });
  check('moving to the same store is refused', (await call('POST', '/transfers', { itemCode: 'KS-MAR', quantity: 1, fromLocationId: first, toLocationId: first })).status === 400);
  const ret = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'CUSTOMER_RETURN', quantity: 1 });
  check('cut cloth handed back by a customer is refused (cut cloth cannot be returned)', ret.status >= 400 && ret.status < 500, ret);
  const unused = await call('POST', '/movements', { itemCode: 'KS-MAR', kind: 'RETURN_UNUSED', quantity: 0.5, orderRef: 'ORD-1' });
  check('the tailor\'s unused 0.5 m comes back', unused.status === 200 && (await stockOf(C1, 'KS-MAR')).qty === 775, unused);
  const hist = await call('GET', '/items/KS-MAR/history');
  const kinds = (hist.data ?? []).map((h: any) => h.kind);
  check('history names each movement as the boutique called it, with the person', ['PURCHASE', 'ISSUE', 'COUNT', 'TRANSFER', 'RETURN_UNUSED'].every(k => kinds.includes(k)) && hist.data.every((h: any) => h.by === 'Lakshmi (cutting)'), kinds);
  check('...and the order it was for', hist.data.some((h: any) => h.kind === 'ISSUE' && h.orderRef === 'ORD-1'), hist.data.filter((h: any) => h.kind === 'ISSUE'));
  const unitChange = await call('PUT', '/items/KS-MAR', { ...silk, unit: 'PIECE' });
  check('the unit cannot change once there is stock', unitChange.status === 409, unitChange);

  console.log('\nSELLING: MATERIALS STAY OUT, THE BOUTIQUE PRICE STAYS');
  const thrV = (await stockOf(C1, 'THR-RED')).v!;
  const inShop = async (productId: string, where: any) => (await prisma.product.count({ where: { ...where, id: productId } })) === 1;
  check('the silk (sell in shop) is in the online shop', await inShop(db1.v!.productId, ELIGIBLE_PRODUCT));
  check('the thread (a material) is not in the online shop', !(await inShop(thrV.productId, ELIGIBLE_PRODUCT)));
  check('...nor in the feed for other websites and the till', !(await inShop(thrV.productId, FEED_PRODUCT)));
  const priceTry = await productService.updateProduct(db1.v!.productId, C1, { basePrice: 5 }).then(() => 'changed', (e: any) => e.message);
  check('Inventory cannot change a boutique price (product)', /comes from your boutique/.test(priceTry), priceTry);
  const vTry = await variantService.updateVariant(db1.v!.id, C1, { sellingPrice: 5 }).then(() => 'changed', (e: any) => e.message);
  check('...nor a colour\'s price', /comes from your boutique/.test(vTry), vTry);
  const costOk = await variantService.updateVariant(db1.v!.id, C1, { reorderLevel: 300 }).then(() => 'ok', (e: any) => e.message);
  check('...but other details stay editable', costOk === 'ok', costOk);
  const switchOk = await productService.updateProduct(thrV.productId, C1, { sellInShop: true }).then(() => 'ok', (e: any) => e.message);
  check('the owner can switch "Sell in shop" on for a material', switchOk === 'ok' && await inShop(thrV.productId, ELIGIBLE_PRODUCT), switchOk);
  await productService.updateProduct(thrV.productId, C1, { sellInShop: false });
  const newPrice = await call('PUT', '/items/KS-MAR', { ...silk, sellingPrice: 520 });
  check('the boutique changes the price and it lands at once (₹520/m = ₹5.20/cm)', newPrice.status === 200 && Number((await stockOf(C1, 'KS-MAR')).v?.sellingPrice) === 5.2, newPrice);

  console.log('\nIMPORT');
  const batch = rid();
  const imp = await call('POST', '/items/import', { items: [
    { itemCode: 'LIN-1', name: 'Lining, cream', unit: 'METER', kind: 'LINING', sellingPrice: 60 },
    { itemCode: 'LIN-2', name: 'Lining, black', unit: 'METER', kind: 'LINING', sellingPrice: 60.5 },
    { itemCode: 'BTN-1', name: 'Gold buttons', unit: 'PACKET', sellingPrice: 40 }
  ] }, { requestId: batch });
  check('a batch with one bad row: 2 added, the bad one refused with its reason', imp.status === 200 && imp.data?.added === 2 && imp.data?.refused === 1 && /whole rupees/.test(imp.data?.results?.[1]?.message ?? ''), imp.data);
  const imp2 = await call('POST', '/items/import', { items: [
    { itemCode: 'LIN-1', name: 'Lining, cream', unit: 'METER', kind: 'LINING', sellingPrice: 60 },
    { itemCode: 'LIN-2', name: 'Lining, black', unit: 'METER', kind: 'LINING', sellingPrice: 60 },
    { itemCode: 'BTN-1', name: 'Gold buttons', unit: 'PACKET', sellingPrice: 40 }
  ] }, { requestId: batch });
  check('the same batch again (fixed row 2) adds only the fixed row', imp2.data?.added === 3 && (await prisma.productVariant.count({ where: { clientId: C1, boutiqueRef: { in: ['LIN-1', 'LIN-2', 'BTN-1'] } } })) === 3, imp2.data);
  const list = await call('GET', '/items?search=lining');
  check('items can be searched', list.status === 200 && list.data?.total === 2, list.data);

  console.log('\nA CLIENT WITH RETAIL AND A BOUTIQUE');
  await prisma.stockLocation.create({ data: { clientId: RETAIL, name: 'Main shop', code: `MS-${STAMP}`, type: 'STORE' } });
  const retailP = await prisma.product.create({ data: { clientId: RETAIL, productCode: `RP-${STAMP}`, slug: `rp-${STAMP}`, title: 'Banarasi saree', category: 'WOMEN', productType: 'READY_TO_WEAR', status: 'ACTIVE', basePrice: 8000 } as any });
  const wrong = await call('POST', '/link', { linkCode: 'ZZZZ-ZZZZ' }, { tenant: T2 });
  check('a wrong code does not link it', wrong.status === 403, wrong);
  const { code } = await makeLinkCode(RETAIL, 'owner-test');
  const l2 = await call('POST', '/link', { linkCode: code.toLowerCase() }, { tenant: T2 });
  check('the owner\'s code links the boutique to the existing shop (any case)', l2.status === 201 && l2.data?.clientId === RETAIL, l2);
  const reuse = await call('POST', '/link', { linkCode: code }, { tenant: `btqtest3-${STAMP}` });
  check('the same code cannot link a second boutique', reuse.status === 403, reuse);
  const sameCode = await call('PUT', '/items/KS-MAR', silk, { tenant: T2 });
  check('the same item code in another shop is its own item', sameCode.status === 201 && (await prisma.productVariant.count({ where: { boutiqueRef: 'KS-MAR', clientId: { in: [C1, RETAIL] } } })) === 2, sameCode);
  const t2list = await call('GET', '/items', undefined, { tenant: T2 });
  check('each boutique sees only its own shop\'s items', t2list.data?.total === 1, t2list.data?.total);
  const otherShop = await call('GET', '/items', undefined, { tenant: T2, clientId: C1 });
  check('a pass naming another shop is refused', otherShop.status === 403, otherShop);
  const inv = await productService.updateProduct(retailP.id, RETAIL, { basePrice: 8500 }).then(() => 'ok', (e: any) => e.message);
  check('the shop\'s own (Inventory) products keep Inventory pricing', inv === 'ok', inv);
  await prisma.boutiqueLink.update({ where: { clientId: RETAIL }, data: { unlinkedAt: new Date() } });
  check('once the owner unlinks, the boutique can no longer reach the shop', (await call('GET', '/items', undefined, { tenant: T2 })).status === 403);

  console.log('\nEVERYTHING A BOUTIQUE STOCKS (CRM-B catalogue)');
  const lining = await call('PUT', '/items/LN-GOLD', { name: 'Satin lining, gold', category: 'LINING', sellingPrice: 90 });
  check('a lining with no unit given is counted in metres (the boutique\'s default for linings)', lining.status === 201 && lining.data?.unit === 'METRE' && lining.data?.productType === 'UNSTITCHED' && lining.data?.kind === 'LINING', lining.data);
  const beads = await call('PUT', '/items/BD-KUN', { name: 'Kundan stones', category: 'MAGGAM', unit: 'PACKET', sellingPrice: 120, sellInShop: true, reorderLevel: 5 });
  check('maggam stones by the packet, sold in the shop too', beads.status === 201 && beads.data?.unit === 'PACKET' && beads.data?.category === 'MAGGAM' && beads.data?.sellInShop === true, beads.data);
  const lace = await call('PUT', '/items/LC-ZARI', { name: 'Zari lace', category: 'BORDER', sellingPrice: 35, sellInShop: true, reorderLevel: 2.5 });
  const laceV = (await stockOf(C1, 'LC-ZARI')).v;
  check('a zari lace border by the metre, reorder at 2.5 m (stored 250 cm)', lace.status === 201 && lace.data?.unit === 'METRE' && laceV?.reorderLevel === 250, { d: lace.data, r: laceV?.reorderLevel });
  const glue = await call('PUT', '/items/GL-FEV', { name: 'Fabric glue', category: 'STITCHING', itemType: 'CONSUMABLE' });
  check('glue (a consumable) is kept, not for sale', glue.status === 201 && glue.data?.itemType === 'CONSUMABLE' && glue.data?.sellInShop === false, glue.data);
  const machine = await call('PUT', '/items/MC-OVL', { name: 'Overlock machine', category: 'OTHER', itemType: 'MACHINE', unit: 'PIECE' });
  check('a sewing machine is kept as equipment, never for sale', machine.status === 201 && machine.data?.itemType === 'MACHINE' && machine.data?.sellInShop === false, machine.data);
  check('...and raises no low-stock alert (nobody reorders a sewing machine)', (await stockOf(C1, 'MC-OVL')).v?.reorderLevel === 0, (await stockOf(C1, 'MC-OVL')).v?.reorderLevel);
  const doc = await call('PUT', '/items/DOC-1', { name: 'QC checklist', itemType: 'DOCUMENT' });
  check('a document is not stock: refused in words', doc.status === 400 && /not kept as stock/.test(doc.message ?? ''), doc);
  const fg = await call('PUT', '/items/FG-ANK1', { name: 'Anarkali, rani pink', category: 'FINISHED', size: 'M', sellingPrice: 4500, sellInShop: true });
  const fgP = await prisma.product.findFirst({ where: { clientId: C1, importKey: 'boutique:FG-ANK1' } });
  check('a garment the boutique finished for stock is ready to wear, by the piece, on sale', fg.status === 201 && fg.data?.unit === 'PIECE' && fgP?.productType === 'READY_TO_WEAR' && await inShop(fgP!.id, ELIGIBLE_PRODUCT), { d: fg.data, t: fgP?.productType });
  check('...and the machine is not in the shop', !(await inShop((await stockOf(C1, 'MC-OVL')).v!.productId, ELIGIBLE_PRODUCT)));
  await call('POST', '/movements', { itemCode: 'LC-ZARI', kind: 'GOODS_RECEIPT', quantity: 20 });
  const cons = await call('POST', '/movements', { itemCode: 'LC-ZARI', kind: 'CONSUMPTION', quantity: 1.5, orderRef: 'ORD-5' });
  const back = await call('POST', '/movements', { itemCode: 'LC-ZARI', kind: 'RETURN', quantity: 0.5, orderRef: 'ORD-5' });
  const sret = await call('POST', '/movements', { itemCode: 'LC-ZARI', kind: 'SUPPLIER_RETURN', quantity: 3 });
  check('the boutique\'s own names work: GOODS_RECEIPT, CONSUMPTION, RETURN, SUPPLIER_RETURN (20 - 1.5 + 0.5 - 3 = 16 m)', [cons, back, sret].every(r => r.status === 200) && (await stockOf(C1, 'LC-ZARI')).qty === 1600, [cons.status, back.status, sret.status, (await stockOf(C1, 'LC-ZARI')).qty]);
  const tailor = await call('POST', '/stores', { name: 'Master Ravi (tailor)', kind: 'TAILOR' });
  const tailor2 = await call('POST', '/stores', { name: 'master ravi (TAILOR)', kind: 'TAILOR' });
  check('the boutique adds its tailor as a place (a workroom, not a shop floor); the same name again is the same place', tailor.status === 201 && tailor.data?.type === 'WAREHOUSE' && tailor2.status === 200 && tailor2.data?.id === tailor.data?.id, { tailor, tailor2 });
  check('an unknown kind of place is refused', (await call('POST', '/stores', { name: 'X', kind: 'SPACESHIP' })).status === 400);
  const toTailor = await call('POST', '/transfers', { itemCode: 'LC-ZARI', quantity: 4, fromLocationId: first, toLocationId: tailor.data?.id });
  check('4 m of lace goes to the tailor', toTailor.status === 200 && (await prisma.inventoryStock.findFirst({ where: { locationId: tailor.data?.id } }))?.quantity === 400, toTailor);

  console.log('\nARCHIVE');
  const arc = await call('DELETE', '/items/THR-RED');
  const thrP = await prisma.product.findUnique({ where: { id: thrV.productId } });
  check('an archived item stops being offered, its history stays', arc.status === 200 && thrP?.status === 'ARCHIVED', { arc, status: thrP?.status });
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'btqtest' } }, select: { clientId: true } })).map(r => r.clientId).filter(c => c.startsWith('boutique-btqtest') || c.startsWith('btqretail-'));
  ids.push(RETAIL);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  // Children first; repeat until nothing is left (foreign keys decide the order).
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  for (let round = 0; round < 6; round++) {
    let left = 0;
    for (const t of tables) {
      try { await prisma.$executeRawUnsafe(`DELETE FROM "${t.table_name}" WHERE client_id = ANY($1)`, ids); }
      catch { left++; }
    }
    if (!left) break;
  }
  await prisma.boutiqueLinkCode.deleteMany({ where: { clientId: { in: ids } } });
  const leftover = await prisma.product.count({ where: { clientId: { in: ids } } });
  console.log(`\ncleaned up ${ids.length} throwaway shops (${leftover} products left)`);
}

main()
  .catch(e => { bad++; console.error('CRASH', e); })
  .finally(async () => { await cleanup().catch(e => console.error('cleanup failed', e)); console.log(`${bad} problems`); await prisma.$disconnect(); process.exit(bad ? 1 : 0); });
