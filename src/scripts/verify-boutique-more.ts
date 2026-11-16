/**
 * The rest of CRM-B's inventory on our API (16 Nov, "CRM-B Inventory Functionality Checklist"), against the REAL local
 * server and database: new item fields + opening stock + ifNew, status words, next code, lookup of many, filters and
 * groups, stock per place, hold-first cutting, stage/garment/remarks in history, the movement list, counts that cut
 * holds, places (rename, remove, what is there), holds for a whole order, release an order, availability, the change
 * feed (till/shop/Shopify moves), alerts, photo upload links, the transfer-only permission, and that retail items of
 * the same shop never show through the boutique API.
 *
 * Throwaway boutique account only (moretest-*); everything is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-more.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { inventoryMutationService } from '../services/inventory-mutation.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `moretest-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const ALL = ['products:write', 'stock:write', 'stitching:issue'];
const pass = (can = ALL) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant: TEN, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, path: string, body?: unknown, o: { can?: string[] } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `more-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}
const item = async (code: string) => (await call('GET', `/items/${encodeURIComponent(code)}`)).data;
const silk = (extra: Record<string, unknown> = {}) => ({ name: 'Kanchi silk', designGroup: `KS-${S}`, category: 'FABRIC', kind: 'FABRIC', unit: 'METER', sellingPrice: 450, ...extra });

async function main() {
  const link = await call('POST', '/link', { shopName: 'More Test Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;

  console.log('\nITEMS: NEW FIELDS, OPENING STOCK, IFNEW, STATUS');
  const A = `A-${S}`;
  const a = await call('PUT', `/items/${A}`, silk({ color: 'Maroon', subCategory: 'Silk sarees', description: 'Pure Kanchi silk, 112 cm', minStock: 5, reorderLevel: 8, rackLocation: 'Rack 2, shelf 3', gstPercent: 5, hsnCode: '5007', ifNew: true, openingStock: [{ quantity: 20 }] }));
  check('a new item with every CRM-B field and 20 m opening stock: 201', a.status === 201 && a.data?.stock === 20, a);
  const a1 = await item(A);
  check('...reads back: sub-category, description, minimum, reorder level, rack, design group, GST',
    a1?.subCategory === 'Silk sarees' && a1.description === 'Pure Kanchi silk, 112 cm' && a1.minStock === 5 && a1.reorderLevel === 8
    && a1.rackLocation === 'Rack 2, shelf 3' && a1.designGroup === `KS-${S}` && a1.gstPercent === 5 && a1.hsnCode === '5007', a1);
  const hist0 = (await call('GET', `/items/${A}/history`)).data ?? [];
  check('...the opening stock is an OPENING_STOCK movement, 0 -> 20', hist0.length === 1 && hist0[0].kind === 'OPENING_STOCK' && hist0[0].stockBefore === 0 && hist0[0].stockAfter === 20, hist0);
  const dup = await call('PUT', `/items/${A}`, silk({ color: 'Maroon', ifNew: true, openingStock: [{ quantity: 5 }] }));
  check('the same code again with ifNew: 409, and nothing changed (stock still 20)', dup.status === 409 && /already in use/.test(dup.message ?? '') && (await item(A))?.stock === 20, dup);
  const re = await call('PUT', `/items/${A}`, silk({ color: 'Maroon', openingStock: [{ quantity: 5 }] }));
  check('the same item sent again with opening stock: changed, opening stock NOT added twice', re.status === 200 && /already existed/.test(String(re.data?.openingStock)) && (await item(A))?.stock === 20, re);
  check('status INACTIVE archives it', (await call('PUT', `/items/${A}`, silk({ color: 'Maroon', status: 'INACTIVE' }))).data?.status === 'ARCHIVED');
  check('status ACTIVE brings it back', (await call('PUT', `/items/${A}`, silk({ color: 'Maroon', status: 'active' }))).data?.status === 'ACTIVE');
  const st = await call('PUT', `/items/${A}`, silk({ color: 'Maroon', status: 'GONE' }));
  check('status GONE: 400 in words', st.status === 400 && /ACTIVE or INACTIVE/.test(st.message ?? ''), st);
  const dis = await call('PUT', `/items/${A}`, silk({ color: 'Maroon', status: 'INACTIVE', archived: false }));
  check('status and archived that disagree: 400', dis.status === 400 && /disagree/.test(dis.message ?? ''), dis);
  const badOpen = await call('PUT', `/items/X-${S}`, silk({ openingStock: [{ quantity: 2.555 }] }));
  check('opening stock of 2.555 m: refused, and the item is not made either', badOpen.status === 400 && !(await item(`X-${S}`)), badOpen);

  console.log('\nNEXT CODE AND LOOKUP');
  const nc1 = await call('GET', `/items/next-code?prefix=prd`);
  check('next code for a new prefix: PRD-0001', nc1.data?.itemCode === 'PRD-0001', nc1);
  await call('PUT', '/items/PRD-0001', { name: 'Blouse', category: 'FINISHED', kind: 'BLOUSE', sellingPrice: 900, sellInShop: true });
  await call('PUT', '/items/PRD-0007', { name: 'Kurti', category: 'FINISHED', sellingPrice: 1200 });
  await call('PUT', '/items/PRD-0007X', { name: 'Odd one', category: 'OTHER' });
  check('after PRD-0001 and PRD-0007 (and PRD-0007X, not a number): PRD-0008', (await call('GET', '/items/next-code?prefix=PRD')).data?.itemCode === 'PRD-0008');
  check('a prefix with a dash or 11 letters: 400', (await call('GET', '/items/next-code?prefix=PR-D')).status === 400 && (await call('GET', '/items/next-code?prefix=ABCDEFGHIJK')).status === 400);
  const look = await call('POST', '/items/lookup', { itemCodes: [A, 'PRD-0001', 'PRD-0007', `NOPE-${S}`, A] });
  check('lookup of 4 codes (one twice, one unknown): 3 items, the unknown listed', look.data?.items?.length === 3 && look.data.notFound?.join() === `NOPE-${S}`, look.data?.notFound);
  check('...each with stock figures', look.data?.items?.every((i: any) => typeof i.free === 'number'));
  check('lookup of 201 codes: 400', (await call('POST', '/items/lookup', { itemCodes: Array.from({ length: 201 }, (_, i) => `C${i}`) })).status === 400);
  check('lookup with no list: 400', (await call('POST', '/items/lookup', {})).status === 400);

  console.log('\nPLACES');
  const cut = await call('POST', '/stores', { name: 'Cutting', kind: 'CUTTING_UNIT' });
  const stores = (await call('GET', '/stores')).data ?? [];
  const main0 = stores.find((s: any) => s.isDefault);
  check('places: the first is the default, the new one is a CUTTING_UNIT', !!main0 && stores.find((s: any) => s.id === cut.data?.id)?.kind === 'CUTTING_UNIT', stores);
  await call('POST', '/transfers', { itemCode: A, quantity: 5, fromLocationId: main0.id, toLocationId: cut.data.id });
  const byLoc = (await item(A))?.byLocation ?? [];
  check('stock per place: 15 m at the default, 5 m at Cutting', byLoc.length === 2 && byLoc.find((l: any) => l.locationId === main0.id)?.stock === 15 && byLoc.find((l: any) => l.name === 'Cutting')?.stock === 5, byLoc);
  const at = await call('GET', `/stores/${cut.data.id}/items`);
  check('what is at Cutting: just this item', at.data?.items?.length === 1 && at.data.items[0].itemCode === A, at.data);
  check('rename Cutting to "Cutting room"', (await call('PUT', `/stores/${cut.data.id}`, { name: 'Cutting room' })).data?.name === 'Cutting room');
  const clash = await call('PUT', `/stores/${cut.data.id}`, { name: main0.name.toUpperCase() });
  check('rename to the default place\'s name (other case): 409', clash.status === 409, clash);
  const rmDefault = await call('DELETE', `/stores/${main0.id}`);
  check('removing the default place: 409', rmDefault.status === 409 && /default/.test(rmDefault.message ?? ''), rmDefault);
  const rmFull = await call('DELETE', `/stores/${cut.data.id}`);
  check('removing a place that holds stock: 409', rmFull.status === 409 && /still holds stock/.test(rmFull.message ?? ''), rmFull);
  await call('POST', '/transfers', { itemCode: A, quantity: 5, fromLocationId: cut.data.id, toLocationId: main0.id });
  const rm = await call('DELETE', `/stores/${cut.data.id}`);
  const after = (await call('GET', '/stores')).data ?? [];
  const allPlaces = (await call('GET', '/stores?all=1')).data ?? [];
  check('emptied, it is removed: gone from the list, kept (switched off) for its history', rm.status === 200 && !after.some((s: any) => s.id === cut.data.id) && allPlaces.find((s: any) => s.id === cut.data.id)?.active === false, [rm, allPlaces]);
  check('removing it again: 200, no change', (await call('DELETE', `/stores/${cut.data.id}`)).status === 200);
  check('a place of another shop: 404', (await call('PUT', '/stores/00000000-0000-0000-0000-000000000000', { name: 'x' })).status === 404);

  console.log('\nCUTTING FROM THE HOLD FIRST, STAGE, GARMENT, HISTORY');
  const h = await call('POST', '/holds', { itemCode: A, quantity: 4, orderRef: 'ORD-1' });
  const use = await call('POST', '/movements', { itemCode: A, kind: 'CONSUME', quantity: 3, orderRef: 'ORD-1', stage: 'Pattern cutting', garmentRef: 'G-7', notes: 'blouse body' });
  check('CONSUME 3 m on ORD-1 (4 m held): all 3 from the hold', use.status === 200 && use.data?.fromHold === 3, use);
  const holdNow = (await call('GET', '/holds?orderRef=ORD-1')).data ?? [];
  check('...1 m is still held for ORD-1', holdNow.length === 1 && holdNow[0].quantity === 1, holdNow);
  const waste = await call('POST', '/movements', { itemCode: A, kind: 'WASTE', quantity: 2, orderRef: 'ORD-1', stage: 'Pattern cutting' });
  check('WASTE 2 m on ORD-1: 1 from the hold, 1 from free stock; the hold is used up', waste.status === 200 && waste.data?.fromHold === 1 && ((await call('GET', '/holds?orderRef=ORD-1')).data ?? []).length === 0, waste);
  const a2 = await item(A);
  check('...stock 15, nothing held', a2?.stock === 15 && a2.reserved === 0 && a2.heldForOrders === 0, a2);
  const big = await call('POST', '/movements', { itemCode: A, kind: 'CONSUME', quantity: 16 });
  check('CONSUME more than is free: 409', big.status === 409, big);
  const hist = (await call('GET', `/items/${A}/history`)).data ?? [];
  const consumed = hist.find((x: any) => x.kind === 'CONSUME');
  check('history: stage, garment, remarks, place, by, before -> after, source BOUTIQUE',
    consumed?.stage === 'Pattern cutting' && consumed.garmentRef === 'G-7' && consumed.remarks === 'blouse body' && consumed.location === main0.name
    && consumed.by === 'Lakshmi' && consumed.stockBefore === 20 && consumed.stockAfter === 17 && consumed.source === 'BOUTIQUE', consumed);

  console.log('\nTHE MOVEMENT LIST');
  const m1 = await call('GET', '/movements?orderRef=ORD-1');
  check('movements for ORD-1: the consume and the waste', m1.data?.total === 2 && m1.data.movements.every((x: any) => x.orderRef === 'ORD-1'), m1.data);
  check('kind WASTE: 1', (await call('GET', '/movements?kind=waste')).data?.total === 1);
  const today = new Date().toISOString().slice(0, 10);
  check('from today to today: every movement so far', (await call('GET', `/movements?from=${today}&to=${today}`)).data?.total === (await call('GET', '/movements')).data?.total);
  check('from tomorrow: none', (await call('GET', `/movements?from=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}`)).data?.total === 0);
  check('from "yesterday-ish": 400 in words', /not a date/.test((await call('GET', '/movements?from=soon')).message ?? ''));
  const pg = await call('GET', '/movements?limit=2&page=2');
  check('pages: limit 2, page 2', pg.data?.movements?.length === 2 && pg.data.page === 2 && pg.data.limit === 2, pg.data);

  console.log('\nCOUNTS CUT HOLDS TO THE STOCK FOUND');
  await call('POST', '/holds', { itemCode: A, quantity: 5, orderRef: 'ORD-2' });
  const cnt = await call('POST', '/counts', { itemCode: A, counted: 3 });
  check('5 m held, only 3 m found: holds cut by 2 m, said in words', cnt.data?.holdsCut === 2 && /cut by 2/.test(cnt.data?.note ?? ''), cnt);
  const a3 = await item(A);
  check('...stock 3, held 3, free 0, never below zero', a3?.stock === 3 && a3.reserved === 3 && a3.free === 0, a3);
  check('a count with nothing different: difference 0, no new movement', (await call('POST', '/counts', { itemCode: A, counted: 3 })).data?.difference === 0 && (await call('GET', `/items/${A}/history`)).data.length === hist.length + 1);
  await call('POST', '/holds/release-order', { orderRef: 'ORD-2' });

  console.log('\nHOLDS FOR A WHOLE ORDER');
  const B = `B-${S}`;
  await call('PUT', `/items/${B}`, { name: 'Gold border', category: 'BORDER', color: 'Gold', openingStock: [{ quantity: 10 }] });
  const strict = await call('POST', '/holds/order', { orderRef: 'ORD-3', allOrNothing: true, lines: [{ itemCode: A, quantity: 2 }, { itemCode: B, quantity: 50 }] });
  check('all or nothing, one line short: 409, and NOTHING was held', strict.status === 409 && /Line 2/.test(strict.message ?? '') && ((await call('GET', '/holds?orderRef=ORD-3')).data ?? []).length === 0, strict);
  const soft = await call('POST', '/holds/order', { orderRef: 'ORD-3', lines: [{ itemCode: A, quantity: 2 }, { itemCode: B, quantity: 12 }] });
  check('hold what is free: line 1 fully, line 2 10 of 12 (2 short)', soft.status === 201 && soft.data?.lines?.[0]?.held === 2 && soft.data.lines[1].held === 10 && soft.data.lines[1].short === 2 && soft.data.fullyHeld === false, soft.data);
  const zero = await call('POST', '/holds', { itemCode: B, quantity: 1, orderRef: 'ORD-4', allowShort: true });
  check('allowShort with nothing free: 200, held 0, short 1, no hold made', zero.status === 200 && zero.data?.held === 0 && zero.data.short === 1 && zero.data.reservationId === null, zero);
  const rel = await call('POST', '/holds/release-order', { orderRef: 'ORD-3' });
  check('release the whole order: 2 holds let go, stock free again', rel.data?.released === 2 && (await item(B))?.free === 10 && (await item(A))?.free === 3, rel.data);
  check('release an order with nothing held: 0', (await call('POST', '/holds/release-order', { orderRef: 'ORD-3' })).data?.released === 0);

  console.log('\nAVAILABILITY');
  const av = await call('POST', '/availability', { lines: [{ itemCode: B, quantity: 6 }, { itemCode: B, quantity: 6 }, { itemCode: A, quantity: 1 }] });
  check('the same border on two lines adds up: 12 needed, 10 free, 2 short; enough = false', av.data?.lines?.find((l: any) => l.itemCode === B)?.needed === 12 && av.data.lines.find((l: any) => l.itemCode === B).short === 2 && av.data.enough === false, av.data);
  check('an unknown item: 404', (await call('POST', '/availability', { lines: [{ itemCode: `NOPE-${S}`, quantity: 1 }] })).status === 404);

  console.log('\nLISTS, FILTERS, GROUPS, ALERTS');
  check('category BORDER: just the border', (await call('GET', '/items?category=BORDER')).data?.items?.map((i: any) => i.itemCode).join() === B);
  check('search by colour "gold": the border', (await call('GET', '/items?search=gold')).data?.items?.map((i: any) => i.itemCode).join() === B);
  const due = (await call('GET', '/items?reorderDue=1')).data?.items?.map((i: any) => i.itemCode) ?? [];
  check('reorder due: silk (3 m free, reorder at 8) is in, the border (10 free, reorder 10 m) is in too', due.includes(A) && due.includes(B), due);
  check('a bad status filter: 400', (await call('GET', '/items?status=gone')).status === 400);
  const g = (await call('GET', '/items/groups')).data;
  check('groups: counts by category', g?.byCategory?.FABRIC === 1 && g.byCategory.BORDER === 1 && g.byCategory.FINISHED === 2 && g.all === 5, g);
  await call('POST', '/movements', { itemCode: B, kind: 'DAMAGE', quantity: 10 });
  const al = (await call('GET', '/alerts')).data ?? [];
  check('alerts: the border is OUT_OF_STOCK, the silk is at its REORDER_LEVEL and below minimum', al.find((x: any) => x.itemCode === B)?.alert === 'OUT_OF_STOCK' && al.find((x: any) => x.itemCode === A)?.alert === 'REORDER_LEVEL' && al.find((x: any) => x.itemCode === A)?.belowMinimum === true, al);

  console.log('\nCHANGES MADE IN SCALEEZY (TILL, SHOP, SHOPIFY, OWNER)');
  const vA = await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: A } });
  // A till sale ends in this same call (the one doorway), with the till's reference.
  await inventoryMutationService.applyMovement({ clientId, variantId: vA!.id, locationId: main0.id, movementType: 'OUT' as any, reason: 'SALE' as any, quantityDelta: -100, referenceType: 'ORDER', referenceId: `SO-${S}`, notes: 'till sale' });
  const c0 = await call('GET', '/changes');
  check('a till sale this second is not given yet (it may still be committing)', c0.status === 200 && c0.data?.changes?.length === 0 && c0.data.settleSeconds === 120, c0.data);
  await prisma.inventoryTransaction.updateMany({ where: { clientId, referenceId: `SO-${S}` }, data: { createdAt: new Date(Date.now() - 180_000) } });
  const c1 = await call('GET', '/changes');
  check('...3 minutes later: the sale, 1 m of silk, source SCALEEZY_SALE; no boutique movements in the feed', c1.data?.changes?.length === 1 && c1.data.changes[0].itemCode === A && c1.data.changes[0].quantity === -1 && c1.data.changes[0].source === 'SCALEEZY_SALE', c1.data);
  const c2 = await call('GET', `/changes?after=${encodeURIComponent(c1.data.next)}`);
  check('...asked again after its cursor: nothing new, same cursor', c2.data?.changes?.length === 0 && c2.data.next === c1.data.next, c2.data);
  check('a cursor that is not one: 400', (await call('GET', '/changes?after=yesterday')).status === 400);
  check('the movement list by our word SALE finds the till sale; an unknown word finds nothing (not an error)',
    (await call('GET', '/movements?kind=SALE')).data?.total === 1 && (await call('GET', '/movements?kind=FLYING')).data?.total === 0);

  console.log('\nPERMISSIONS, PHOTOS, RETAIL ITEMS');
  const tOnly = ['stock:transfer'];
  const t1 = await call('POST', '/transfers', { itemCode: A, quantity: 1, fromLocationId: main0.id, toLocationId: (await call('POST', '/stores', { name: 'Tailor Ravi', kind: 'TAILOR' })).data.id }, { can: tOnly });
  check('stock:transfer alone may move stock between places', t1.status === 200, t1);
  check('...but not record a purchase', (await call('POST', '/movements', { itemCode: A, kind: 'PURCHASE', quantity: 1 }, { can: tOnly })).status === 403);
  check('photos: 11 at once refused', (await call('POST', '/photos', { files: Array.from({ length: 11 }, () => ({ name: 'a.jpg', contentType: 'image/jpeg', size: 10 })) })).status === 400);
  check('photos: a GIF refused in words', /JPEG, PNG or WebP/.test((await call('POST', '/photos', { files: [{ name: 'a.gif', contentType: 'image/gif', size: 10 }] })).message ?? ''));
  check('photos: 11 MB refused', /over 10 MB/.test((await call('POST', '/photos', { files: [{ name: 'a.jpg', contentType: 'image/jpeg', size: 11 * 1024 * 1024 }] })).message ?? ''));
  check('photos: without products:write, 403', (await call('POST', '/photos', { files: [{ name: 'a.jpg', contentType: 'image/jpeg', size: 10 }] }, { can: ['stock:write'] })).status === 403);
  const ph = await call('POST', '/photos', { files: [{ name: 'Maroon silk.jpg', contentType: 'image/jpeg', size: 500_000 }] });
  // Local storage is switched off on this server, so the only honest check here is that the refusal is plain words.
  check('photos: local storage is off, so 502 in plain words (no storage error text)', ph.status === 502 && /cannot be uploaded just now/.test(ph.message ?? '') && !/fetch|bucket|ECONN/i.test(ph.message ?? ''), ph);
  // A retail item the shop added itself (no boutique code) never shows through the boutique API.
  const retail = await prisma.product.create({ data: { clientId, productCode: `RTL-${S}`, slug: `rtl-${S}`, title: 'Ready-made kurti', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 999, status: 'ACTIVE' as any } as any });
  const rv = await prisma.productVariant.create({ data: { clientId, productId: retail.id, sku: `RTL-${S}`, variantCode: `RTL-${S}`, colorName: 'Blue', size: 'M' } as any });
  await inventoryMutationService.applyMovement({ clientId, variantId: rv.id, locationId: main0.id, movementType: 'IN' as any, reason: 'PURCHASE' as any, quantityDelta: 4, referenceType: 'PO', notes: 'owner buys kurtis' });
  await prisma.inventoryTransaction.updateMany({ where: { clientId, variantId: rv.id }, data: { createdAt: new Date(Date.now() - 180_000) } });
  const seen = JSON.stringify([(await call('GET', '/items?limit=100')).data, (await call('GET', '/movements?limit=100')).data, (await call('GET', '/changes')).data, (await call('GET', '/alerts')).data]);
  check('the shop\'s own retail item never shows in items, movements, changes or alerts', !seen.includes(`RTL-${S}`) && !seen.includes('Ready-made kurti'));
  check('...and its stock is untouched by all of the above', (await prisma.inventoryStock.findFirst({ where: { variantId: rv.id } }))?.quantity === 4);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'moretest-' } }, select: { clientId: true } })).map(l => l.clientId);
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
