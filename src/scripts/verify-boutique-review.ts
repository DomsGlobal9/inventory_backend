/**
 * The 16 Nov deep review of the boutique API, each finding proven fixed against the REAL local server and database,
 * with the answer it SHOULD give:
 *  hold paid out twice in a race · a blank count · a count racing a sale · purchase orders claimed before they run ·
 *  a request id reused for another change · moving a boutique into a shop that already has suppliers and orders ·
 *  an item code that is a shop SKU · codes with spaces · a save that leaves fields out · a unit change · held cloth
 *  to the tailor · returns in usage reports · the bin in the stock summary · the change feed's own rows · India days
 *  in purchase spend · a finished hold's quantity · an emptied design · a complete count of a shared shelf · photo
 *  paths that climb out · next-code overflow · kilogram prices · holds paging · supplier performance permission
 * Throwaway shops only (reviewtest-*, absorbtest-*); everything is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-review.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { supabase } from '../lib/supabase';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { purchaseOrderService } from '../services/purchase-order.service';
import { supplierService } from '../services/supplier.service';
import { enableForClient } from '../services/boutique';
import { checkOwnPhotos } from '../services/boutique/more';

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
const ALL = ['products:write', 'stock:write', 'stitching:issue', 'suppliers:write', 'reports:view'];
let n = 0;
const shop = (tenant: string) => async (method: string, path: string, body?: unknown, o: { can?: string[]; key?: string } = {}) => {
  const pass = jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Review', can: o.can ?? ALL } },
    privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 180_000,
    headers: { Authorization: `Bearer ${pass}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `review-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, replay: r.headers['idempotent-replay'] };
};
const A = shop(`reviewtest-a-${S}`);
const silk = (extra: Record<string, unknown> = {}) => ({ name: 'Kanchi silk', category: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, purchasePrice: 280, sellInShop: true, ...extra });
const item = async (code: string) => (await A('GET', `/items/${encodeURIComponent(code)}`)).data;

async function main() {
  const la = await A('POST', '/link', { shopName: 'Review A' });
  const cA = la.data.clientId as string;
  const main0 = (await A('GET', '/stores')).data[0].id as string;
  const SILK = `SILK-${S}`;
  await A('PUT', `/items/${SILK}`, silk({ openingStock: [{ quantity: 20 }], reorderLevel: 10 }));

  console.log('BLANKS ARE NOT ZERO');
  for (const [what, body] of [['no counted', { itemCode: SILK }], ['counted null', { itemCode: SILK, counted: null }], ['counted ""', { itemCode: SILK, counted: '' }], ['counted []', { itemCode: SILK, counted: [] }]] as const) {
    const r = await A('POST', '/counts', body);
    check(`a count with ${what}: 400 "Give the count", stock untouched`, r.status === 400 && /Give the count/.test(r.message ?? '') && (await item(SILK))?.stock === 20, r);
  }
  check('a movement with no quantity: 400', (await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE' })).status === 400);
  check('a count of 0 written as 0 still works (it is a number)', (await A('POST', '/counts', { itemCode: `NOPE-${S}`, counted: 0 })).status === 404);

  console.log('\nRACES ON HOLDS AND COUNTS');
  const h = (await A('POST', '/holds', { itemCode: SILK, quantity: 5, orderRef: 'RACE' })).data;
  const both = await Promise.all([A('POST', `/holds/${h.reservationId}/release`, {}), A('POST', `/holds/${h.reservationId}/issue`, {})]);
  const after = await item(SILK);
  const sums = await prisma.boutiqueReservation.aggregate({ where: { clientId: cA, status: 'ACTIVE' }, _sum: { quantity: true } });
  check('release and cut of one hold at the same moment: one goes through, the other 409', both.map(b => b.status).sort().join() === '200,409', both.map(b => [b.status, b.message]));
  check('...and nothing is held twice over: held = the active holds (0), never below', after.reserved === 0 && (sums._sum.quantity ?? 0) === 0 && (after.stock === 20 || after.stock === 15), after);
  const v = (await prisma.productVariant.findFirst({ where: { clientId: cA, boutiqueRef: SILK } }))!;
  const stockBefore = (await item(SILK)).stock;
  await Promise.all([A('POST', '/counts', { itemCode: SILK, counted: 12 }), inventoryMutationService.applyMovement({ clientId: cA, variantId: v.id, locationId: main0, movementType: 'OUT' as any, reason: 'SALE' as any, quantityDelta: -200, referenceType: 'ORDER', referenceId: `R-${S}`, notes: 'till' })]);
  const countRow = await prisma.inventoryTransaction.findFirst({ where: { clientId: cA, boutiqueKind: 'COUNT' }, orderBy: { createdAt: 'desc' } });
  const endStock = (await item(SILK)).stock;
  check(`a count of 12 racing a till sale of 2 (from ${stockBefore}): the count lands on exactly 12, the sale before or after it`, countRow?.balanceAfter === 1200 && (endStock === 12 || endStock === 10), { count: countRow?.balanceAfter, endStock });

  console.log('\nTHE REQUEST LEDGER');
  const K = `review-key-${S}`;
  const first = await A('POST', '/holds', { itemCode: SILK, quantity: 1, orderRef: 'K' }, { key: K });
  const reuse = await A('POST', '/holds/release-order', { orderRef: 'K' }, { key: K });
  check('a request id reused for a different change: 409 in words, nothing released', first.status === 201 && reuse.status === 409 && /already used for a different change/.test(reuse.message ?? '') && ((await A('GET', '/holds?orderRef=K')).data ?? []).length === 1, reuse);
  check('...the same id for the same change again: the first answer (a replay)', (await A('POST', '/holds', { itemCode: SILK, quantity: 1, orderRef: 'K' }, { key: K })).replay === 'true');
  check('...the same change with its keys in another order is still the same change', (await A('POST', '/holds', { orderRef: 'K', quantity: 1, itemCode: SILK }, { key: K })).replay === 'true');
  const sup = (await A('POST', '/suppliers', { name: `Ravi ${S}` })).data;
  const PK = `review-po-${S}`;
  const twin = await Promise.all([A('POST', '/purchase-orders', { supplierId: sup.id, lines: [{ itemCode: SILK, quantity: 1, unitCost: 280 }] }, { key: PK }), A('POST', '/purchase-orders', { supplierId: sup.id, lines: [{ itemCode: SILK, quantity: 1, unitCost: 280 }] }, { key: PK })]);
  check('the same purchase order sent twice at once: ONE order (the other waits or replays)', (await prisma.purchaseOrder.count({ where: { clientId: cA } })) === 1 && twin.some(t => t.status === 201), twin.map(t => [t.status, t.message]));
  const RK = `review-ref-${S}`;
  const refused = await A('POST', '/purchase-orders', { supplierId: 'nope', lines: [{ itemCode: SILK, quantity: 1 }] }, { key: RK });
  const fixed = await A('POST', '/purchase-orders', { supplierId: sup.id, lines: [{ itemCode: SILK, quantity: 1 }] }, { key: RK });
  check('a refused purchase order frees its id: the corrected one with the same id goes through', refused.status === 404 && fixed.status === 201, [refused.status, fixed.status, fixed.message]);

  console.log('\nITEMS: SAVES THAT LEAVE FIELDS OUT, CODES, UNITS');
  const keep = await A('PUT', `/items/${SILK}`, { name: 'Kanchi silk, maroon' });
  const k1 = keep.data;
  check('a save with only the name: price, unit, colour, "sell in shop", category and GST all kept', keep.status === 200 && k1?.sellingPrice === 450 && k1.unit === 'METRE' && k1.colour === 'Maroon' && k1.sellInShop === true && k1.category === 'FABRIC' && k1.purchasePrice === 280, k1);
  await prisma.productVariant.create({ data: { clientId: cA, productId: (await prisma.product.create({ data: { clientId: cA, productCode: `R-${S}`, slug: `r-${S}`, title: 'Shop kurti', category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 999, status: 'ACTIVE' as any } as any })).id, sku: `RET-${S}`, variantCode: `RETV-${S}`, colorName: 'Blue', size: 'M' } as any });
  const clashR = await A('PUT', `/items/RET-${S}`, silk());
  check('an item code the shop already uses as a SKU: 409 in words (not a crash)', clashR.status === 409 && /already uses this code/.test(clashR.message ?? ''), clashR);
  const imp = await A('POST', '/items/import', { items: [{ itemCode: `RET-${S}`, ...silk() }, { itemCode: `  TRIM-${S}  `, ...silk({ supplierId: sup.id, openingStock: [{ quantity: 2 }] }) }, { itemCode: `ZERO-${S}`, ...silk({ openingStock: [{ quantity: 0 }] }) }] }, { key: `review-imp-${S}` });
  check('an import: the SKU clash row refused, the rest go on (spaces trimmed, supplier and opening stock land)', imp.status === 200 && imp.data?.added === 2 && imp.data.results[0].ok === false && (await item(`TRIM-${S}`))?.stock === 2 && (await item(`TRIM-${S}`))?.supplier?.name === `Ravi ${S}` && (await item(`ZERO-${S}`))?.stock === 0, imp.data);
  const U = `UNIT-${S}`;
  await A('PUT', `/items/${U}`, silk({ reorderLevel: 10, minStock: 4 }));
  const unit = await A('PUT', `/items/${U}`, { unit: 'PIECE', category: 'FINISHED' });
  check('a unit change (no stock, one colour): the same figures in the new unit -- 450 a piece, reorder 10, minimum 4', unit.status === 200 && unit.data?.unit === 'PIECE' && unit.data.sellingPrice === 450 && unit.data.purchasePrice === 280 && unit.data.reorderLevel === 10 && unit.data.minStock === 4, unit.data);
  await A('PUT', `/items/${U}-2`, silk({ designGroup: `DES-${S}` }));
  await A('PUT', `/items/${U}-3`, silk({ designGroup: `DES-${S}`, color: 'Green' }));
  const sib = await A('PUT', `/items/${U}-3`, { unit: 'PIECE' });
  check('a unit change while the design has other colours: 409 in words', sib.status === 409 && /other colours/.test(sib.message ?? ''), sib);
  const KG = `KG-${S}`;
  const kg = await A('PUT', `/items/${KG}`, { name: 'Zari', category: 'OTHER', unit: 'KILOGRAM', sellingPrice: 1234 });
  check('a kilogram price of 1,234: refused, saying "a multiple of 10 rupees" (not "per metre")', kg.status === 400 && /per kilogram must be a multiple of 10 rupees/.test(kg.message ?? ''), kg);
  check('...1,230 a kilogram is fine', (await A('PUT', `/items/${KG}`, { name: 'Zari', category: 'OTHER', unit: 'KILOGRAM', sellingPrice: 1230 })).data?.sellingPrice === 1230);
  const MOVE = `MOVE-${S}`;
  await A('PUT', `/items/${MOVE}`, silk({ designGroup: `OLD-${S}` }));
  const oldDesign = (await prisma.productVariant.findFirst({ where: { clientId: cA, boutiqueRef: MOVE } }))!.productId;
  const moved = await A('PUT', `/items/${MOVE}`, { designGroup: `NEW-${S}` });
  check('a design whose last colour moved to another design: archived, not left on sale empty', moved.status === 200 && (await prisma.product.findUnique({ where: { id: oldDesign } }))?.status === 'ARCHIVED',
    { put: [moved.status, moved.message], old: await prisma.product.findUnique({ where: { id: oldDesign }, select: { status: true, _count: { select: { variants: true } } } }) });
  check('...and the moved item keeps its price and "sell in shop" in its new design', moved.data?.sellingPrice === 450 && moved.data.sellInShop === true && moved.data.designGroup === `NEW-${S}` && moved.data.status === 'ACTIVE', moved.data);

  console.log('\nHELD CLOTH, REPORTS, THE FEED');
  const tailor = (await A('POST', '/stores', { name: 'Ravi tailor', kind: 'TAILOR' })).data.id;
  const T = `TAIL-${S}`;
  await A('PUT', `/items/${T}`, silk({ openingStock: [{ quantity: 10 }] }));
  const ht = (await A('POST', '/holds', { itemCode: T, quantity: 6, orderRef: 'ORD-T' })).data;
  check('moving held cloth without naming the order: 409, saying to name the order', /name the order/.test((await A('POST', '/transfers', { itemCode: T, quantity: 6, fromLocationId: main0, toLocationId: tailor })).message ?? ''));
  const tr = await A('POST', '/transfers', { itemCode: T, quantity: 6, fromLocationId: main0, toLocationId: tailor, orderRef: 'ORD-T' });
  const tItem = await item(T);
  check('6 m held for ORD-T sent to the tailor with the order named: the hold goes with it (same hold id)', tr.status === 200 && tr.data?.holdsMoved?.[0]?.reservationId === ht.reservationId && tItem.byLocation.find((l: any) => l.locationId === tailor)?.reserved === 6 && tItem.byLocation.find((l: any) => l.locationId === main0)?.reserved === 0, [tr, tItem.byLocation]);
  await A('POST', '/movements', { itemCode: T, kind: 'ISSUE', quantity: 5, orderRef: 'ORD-T', locationId: tailor });
  await A('POST', '/movements', { itemCode: T, kind: 'RETURN_UNUSED', quantity: 1, orderRef: 'ORD-T', locationId: tailor });
  const ou = (await A('GET', '/reports/order-usage?orderRef=ORD-T')).data;
  check('issued 5 m, returned 1 m unused: order usage says 4 m used, cost 4 x 280 = 1,120', ou?.lines?.[0]?.netUsed === 4 && ou.totalCost === 1120, ou);
  check('...cost per order the same 1,120', (await A('GET', '/reports/cost-per-order?orderRef=ORD-T')).data?.orders?.[0]?.total === 1120);
  check('...consumption 4 m for it', (await A('GET', '/reports/consumption')).data?.items?.find((i: any) => i.itemCode === T)?.quantity === 4);
  const h3 = (await A('POST', '/holds', { itemCode: SILK, quantity: 5, orderRef: 'RR' })).data;
  await A('POST', `/holds/${h3.reservationId}/issue`, { quantity: 3, releaseRest: true });
  const rr = ((await A('GET', '/holds?orderRef=RR&all=1')).data ?? [])[0];
  check('a hold of 5, 3 cut and the rest let go: it reads ISSUED 3 (what was cut)', rr?.status === 'ISSUED' && rr.quantity === 3, rr);
  const binned = `BIN-${S}`;
  await A('PUT', `/items/${binned}`, silk({ openingStock: [{ quantity: 1 }] }));
  const before = (await A('GET', '/reports/stock-summary')).data;
  await prisma.product.update({ where: { id: (await prisma.productVariant.findFirst({ where: { clientId: cA, boutiqueRef: binned } }))!.productId }, data: { trashedAt: new Date() } });
  const after2 = (await A('GET', '/reports/stock-summary')).data;
  check('the stock summary leaves out an item the owner put in the bin', after2.items === before.items - 1, [before.items, after2.items]);
  const po = (await A('GET', `/purchase-orders?status=DRAFT`)).data.orders[0];
  await A('PUT', `/purchase-orders/${po.id}`, { status: 'ORDERED' });
  await A('POST', `/purchase-orders/${po.id}/receive`, { lines: [{ itemCode: SILK, quantity: 1 }] });
  await prisma.inventoryTransaction.updateMany({ where: { clientId: cA }, data: { createdAt: new Date(Date.now() - 600_000) } });
  const feed = (await A('GET', '/changes?limit=500')).data?.changes ?? [];
  check('the change feed does not hand back the boutique\'s own receipt', !feed.some((c: any) => c.kind === 'GOODS_RECEIPT' || c.kind === 'PURCHASE_RECEIPT'), feed.map((c: any) => c.kind));
  check('...the receipt shows in the history as the boutique\'s, by the person', (await A('GET', `/items/${SILK}/history`)).data?.some((x: any) => x.kind === 'GOODS_RECEIPT' && x.source === 'BOUTIQUE' && x.by === 'Review'));
  const spendPo = await prisma.purchaseOrder.findFirst({ where: { clientId: cA, status: { in: ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'] } } });
  await prisma.purchaseOrder.update({ where: { id: spendPo!.id }, data: { createdAt: new Date('2026-11-09T19:00:00Z') } });
  const spend = (await A('GET', '/reports/purchase-spend?from=2026-11-10&to=2026-11-10')).data;
  check('an order placed at 00:30 India time on 10 Nov is spend of 10 Nov', spend?.orders === 1 && spend.byDay?.[0]?.day === '2026-11-10', spend);

  console.log('\nSHELVES, PHOTOS, CODES, LISTS, PERMISSIONS');
  await A('POST', `/stores/${main0}/spots/bulk`, { levels: [{ kind: 'RACK', range: { codes: ['R1'] } }, { kind: 'SHELF', range: { from: 1, to: 1 } }] });
  const spot = (await prisma.storageSpot.findFirst({ where: { clientId: cA, kind: 'SHELF' as any } }))!;
  const shopItem = (await prisma.productVariant.findFirst({ where: { clientId: cA, sku: `RET-${S}` } }))!;
  await inventoryMutationService.applyMovement({ clientId: cA, variantId: shopItem.id, locationId: main0, movementType: 'IN' as any, reason: 'PURCHASE' as any, quantityDelta: 3, referenceType: 'PO', notes: 'shop kurtis' });
  await prisma.spotStock.create({ data: { clientId: cA, spotId: spot.id, locationId: main0, variantId: shopItem.id, quantity: 3 } as any });
  await A('POST', '/shelf-moves', { itemCode: SILK, locationId: main0, toSpotId: spot.id, quantity: 1 });
  const issuesBefore = await prisma.shelfIssue.count({ where: { clientId: cA } });
  const cnt = await A('POST', `/spots/${spot.id}/count`, { counts: [{ itemCode: SILK, quantity: 1 }], complete: true });
  check('a complete count of a shelf shared with the shop\'s own kurtis: the kurtis stay at 3, no false problem', cnt.status === 200 && (await prisma.spotStock.findFirst({ where: { spotId: spot.id, variantId: shopItem.id } }))?.quantity === 3 && (await prisma.shelfIssue.count({ where: { clientId: cA } })) === issuesBefore, cnt);
  const base = supabase.storage.from('inventory-images').getPublicUrl('').data.publicUrl.replace(/\/$/, '');
  const why = async (u: string) => { try { await checkOwnPhotos(cA, [u]); return 'passed'; } catch (e: any) { return `${e.statusCode}`; } };
  check('a photo path that climbs out of the shop\'s folder ("../"): 403', (await why(`${base}/${cA}/../someone-else/x.jpg`)) === '403' && (await why(`${base}/${cA}/%2e%2e/someone-else/x.jpg`)) === '403');
  await prisma.productVariant.create({ data: { clientId: cA, productId: shopItem.productId, sku: `PRD-20261116123456`, variantCode: `X-${S}`, boutiqueRef: 'PRD-20261116123456', colorName: 'x', size: 'x' } as any });
  const nc = await A('GET', '/items/next-code?prefix=PRD');
  check('next code when a code like PRD-20261116123456 exists: PRD-0001, not a crash', nc.status === 200 && nc.data?.itemCode === 'PRD-0001', nc);
  check('GET /holds?all=0 lists only active holds; limit and page work', ((await A('GET', '/holds?all=0')).data ?? []).every((x: any) => x.status === 'ACTIVE') && ((await A('GET', '/holds?all=1&limit=1&page=2')).data ?? []).length === 1);
  check('supplier performance without suppliers or reports words: 403', (await A('GET', '/suppliers/performance', undefined, { can: ['stock:write'] })).status === 403);

  console.log('\nMOVING A BOUTIQUE INTO A SHOP THAT HAS ITS OWN SUPPLIERS AND ORDERS');
  const SHOPID = `absorbtest-shop-${S}`;
  await prisma.clientSettings.create({ data: { clientId: SHOPID, businessName: 'Absorb test shop' } as any });
  const loc = await prisma.stockLocation.create({ data: { clientId: SHOPID, name: 'Main Store', code: 'MAIN-STORE', type: 'STORE' as any, active: true } });
  const ownSup = await supplierService.createSupplier(SHOPID, { name: 'Shop supplier' });
  const rp = await prisma.product.create({ data: { clientId: SHOPID, productCode: `RP-${S}`, slug: `rp-${S}`, title: 'Shop shirt', category: 'MEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 500, status: 'ACTIVE' as any } as any });
  const rv = await prisma.productVariant.create({ data: { clientId: SHOPID, productId: rp.id, sku: `RS-${S}`, variantCode: `RSV-${S}`, colorName: 'White', size: 'L' } as any });
  const ownPo = await purchaseOrderService.createPO(SHOPID, { supplierId: ownSup.id, locationId: loc.id, items: [{ variantId: rv.id, orderedQty: 2, unitPrice: 300 }] });
  const tenantA = `reviewtest-a-${S}`;
  const boutiquePo = (await A('GET', '/purchase-orders?status=RECEIVED')).data.orders[0];
  const en = await enableForClient(SHOPID, tenantA).then(r => r, (e: any) => ({ error: `${e.statusCode} ${e.message}` }));
  check('switching the boutique on for the shop: done, nothing refused', !(en as any).error && (en as any).moved > 0, en);
  const sups = await prisma.supplier.findMany({ where: { clientId: SHOPID }, orderBy: { supplierCode: 'asc' }, select: { supplierCode: true, name: true } });
  check('...both shops\' suppliers are there, each with its own number (the shop\'s first, the boutique\'s next)', sups.length === 2 && sups[0].name === 'Shop supplier' && sups[0].supplierCode === ownSup.supplierCode && sups[1].supplierCode !== ownSup.supplierCode, sups);
  const pos = await prisma.purchaseOrder.findMany({ where: { clientId: SHOPID }, select: { id: true, poNumber: true } });
  check('...all purchase orders moved (none lost), numbers all different', pos.length === 1 + (await prisma.purchaseOrder.count({ where: { clientId: SHOPID, id: { not: ownPo.id } } })) && new Set(pos.map(p => p.poNumber)).size === pos.length && pos.length >= 3, pos);
  const movedPo = pos.find(p => p.id === boutiquePo.id)!;
  check('...the boutique\'s received order keeps its stock rows pointing at its new number', (await prisma.inventoryTransaction.count({ where: { clientId: SHOPID, referenceType: 'PO', referenceId: movedPo.poNumber } })) >= 1, movedPo);
  const next = await supplierService.createSupplier(SHOPID, { name: 'Another supplier' }).then(s => s.supplierCode, (e: any) => `ERR ${e.message}`);
  check('...the shop\'s next new supplier gets a fresh number (no clash, no crash)', !next.startsWith('ERR') && !sups.some(s => s.supplierCode === next), next);
  check('...and the boutique now works in that shop', (await A('GET', `/items/${SILK}`)).status === 200 && (await A('GET', '/stores')).data.some((l: any) => l.id === loc.id));
}

async function cleanup() {
  const ids = [...new Set([...(await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'reviewtest-' } }, select: { clientId: true } })).map(l => l.clientId),
    ...(await prisma.clientSettings.findMany({ where: { clientId: { startsWith: 'absorbtest-' } }, select: { clientId: true } })).map(c => c.clientId)])];
  if (!ids.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  for (const sql of [
    'DELETE FROM purchase_receipt_items WHERE receipt_id IN (SELECT id FROM purchase_receipts WHERE client_id = ANY($1))',
    'DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE client_id = ANY($1))',
    'DELETE FROM inventory_transaction_spots WHERE transaction_id IN (SELECT id FROM inventory_transactions WHERE client_id = ANY($1))',
    'UPDATE storage_spots SET parent_id = NULL WHERE client_id = ANY($1)',
    'DELETE FROM inventory_product_images WHERE product_id IN (SELECT id FROM inventory_products WHERE client_id = ANY($1))'
  ]) await prisma.$executeRawUnsafe(sql, ids).catch(() => undefined);
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
