/**
 * The shelf gaps found in the 26 Oct review, each proven through the real API on the LOCAL database.
 *
 *   A  a till sale that sells more than the stock record (allowed for POS) goes through even when the
 *      item has pieces on a shelf: the shelf empties, the store goes below zero, nothing is refused
 *   B  two counts of the same shelf at the same moment apply ONCE (shelf ends at the count, one issue)
 *   C  putting away an item the store has none of says so (not "already on a shelf")
 *   D  a pick list leaves out service lines (stitching, fall & pico): they are never "short"
 *   E  moving an item that does not exist answers in words, no ids
 *   F  "not found on the shelf" for more than the shelf holds is refused; the same report twice makes one problem
 *   G  the "not on a shelf" total ignores items below zero (it never shrinks other items' waiting pieces)
 *   H  wrong field types and an over-long note are refused in plain words
 *   I  "I counted the whole shelf" on a shelf with nothing recorded is accepted (an empty shelf is confirmed)
 *   J  the count, its problem and its alert are saved together (no "could not record" for a saved count)
 *
 *   DATABASE_URL=<local> ROLE_TOKENS=<local-tokens.json> IDS=<local-ids.json> npx tsx src/scripts/verify-shelves-gaps.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { inventoryMutationService } from '../services/inventory-mutation.service';
import { salesOrderService } from '../services/sales-order.service';

if (!/localhost:55433|127\.0\.0\.1:55433/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing: this suite runs on the local database only (DATABASE_URL must be localhost:55433).');
  process.exit(1);
}
const API = process.env.TEST_API_URL || 'http://localhost:4016/api/v1';
const tokens: Record<string, string> = JSON.parse(fs.readFileSync(process.env.ROLE_TOKENS!, 'utf8'));
const ids = JSON.parse(fs.readFileSync(process.env.IDS!, 'utf8'));
const C: string = ids.clientId, LOC: string = ids.locationId;
const STAMP = Date.now();

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} -- ${detail}`); }
};
const owner = axios.create({ baseURL: `${API}/shelves`, headers: { Cookie: `token=${tokens.SUPER_ADMIN}` }, validateStatus: () => true });
const brief = (r: any) => `${r.status} ${JSON.stringify(r.data).slice(0, 260)}`;
const msg = (r: any) => String(r.data?.message ?? r.data?.error ?? '');
const data = (r: any) => r.data?.data ?? r.data;

async function item(title: string, stock: number, isService = false) {
  const product = await prisma.product.create({ data: { clientId: C, productCode: `GAP-${STAMP}-${title}`, slug: `gap-${STAMP}-${title}`.toLowerCase(), title: `${title} ${STAMP}`, category: 'WOMEN' as any, productType: 'READY_TO_WEAR' as any, basePrice: 1000, status: 'ACTIVE' as any, isService } as any });
  const v = await prisma.productVariant.create({ data: { clientId: C, productId: product.id, sku: `GAP-${STAMP}-${title}`, variantCode: `GAPV-${STAMP}-${title}`, colorName: 'Red', size: 'Free', sellingPrice: 1000, costPrice: 500 } as any });
  if (stock > 0) await inventoryMutationService.applyMovement({ clientId: C, variantId: v.id, locationId: LOC, movementType: 'IN', reason: 'PURCHASE_RECEIPT', quantityDelta: stock, unitCost: 500, notes: 'verify-shelves-gaps', createdBy: 'verify-shelves-gaps' } as any);
  return v.id;
}
const onShelf = async (spotId: string, variantId: string) => (await prisma.spotStock.findUnique({ where: { spotId_variantId: { spotId, variantId } } }))?.quantity ?? 0;
const stockOf = async (variantId: string) => (await prisma.inventoryStock.findUnique({ where: { variantId_locationId: { variantId, locationId: LOC } } }))?.quantity ?? 0;

async function main() {
  console.log(`\nShelf gaps, on the LOCAL database (${C})\n`);
  const area = data(await owner.post(`/locations/${LOC}/spots`, { kind: 'AREA', code: `G${STAMP % 100000}`, isShopFloor: true }));
  const shelf = data(await owner.post(`/locations/${LOC}/spots`, { parentId: area.id, kind: 'SHELF', code: '1' }));
  const empty = data(await owner.post(`/locations/${LOC}/spots`, { parentId: area.id, kind: 'SHELF', code: '2' }));
  if (!shelf?.id || !empty?.id) throw new Error(`could not make test shelves: ${JSON.stringify(area)} ${JSON.stringify(shelf)}`);

  console.log('A. A TILL SALE BEYOND THE STOCK RECORD');
  const vA = await item('A', 2);
  const pa = await owner.post('/putaway', { locationId: LOC, variantId: vA, spotId: shelf.id, quantity: 2 });
  check('(set-up) 2 of A put on the shelf', pa.status === 200 || pa.status === 201, brief(pa));
  let saleError = '';
  try {
    await inventoryMutationService.applyMovement({ clientId: C, variantId: vA, locationId: LOC, movementType: 'OUT', reason: 'SALE', quantityDelta: -3, allowNegative: true, notes: 'verify-shelves-gaps: till sold 3 of 2', createdBy: 'verify-shelves-gaps' } as any);
  } catch (e: any) { saleError = e?.message ?? String(e); }
  check('the till sells 3 of 2: accepted (not "shelves would hold more")', saleError === '', saleError);
  check('  ...store at -1, shelf emptied to 0', await stockOf(vA) === -1 && await onShelf(shelf.id, vA) === 0, `${await stockOf(vA)} / ${await onShelf(shelf.id, vA)}`);

  console.log('\nB. TWO COUNTS OF ONE SHELF AT ONCE');
  const vB = await item('B', 10);
  await owner.post('/putaway', { locationId: LOC, variantId: vB, spotId: shelf.id, quantity: 5 });
  const before = await prisma.shelfIssue.count({ where: { clientId: C, variantId: vB, kind: 'NOT_FOUND_ON_SHELF' } });
  const body = { counts: [{ variantId: vB, counted: 3 }], complete: false };
  const [c1, c2] = await Promise.all([owner.post(`/spots/${shelf.id}/count`, body), owner.post(`/spots/${shelf.id}/count`, body)]);
  check('both counts answered', c1.status === 200 && c2.status === 200, `${brief(c1)} | ${brief(c2)}`);
  check('the shelf ends at the count, 3 (not 1)', await onShelf(shelf.id, vB) === 3, String(await onShelf(shelf.id, vB)));
  const after = await prisma.shelfIssue.count({ where: { clientId: C, variantId: vB, kind: 'NOT_FOUND_ON_SHELF' } });
  check('  ...and ONE "missing from the shelf" problem, not two', after - before === 1, `${after - before}`);

  console.log('\nC. PUTTING AWAY SOMETHING THE STORE HAS NONE OF');
  const vZ = await item('Z', 0);
  const pz = await owner.post('/putaway', { locationId: LOC, variantId: vZ, spotId: shelf.id, quantity: 1 });
  check('refused, saying the store has none (not "already on a shelf")', pz.status >= 400 && !/already on a shelf/i.test(msg(pz)) && /none|no pieces|0 pieces/i.test(msg(pz)), brief(pz));

  console.log('\nD. SERVICE LINES ON A PICK LIST');
  const vS = await item('S', 0, true);
  const order: any = await salesOrderService.createFullOrder(C, LOC, { customer: { id: ids.customerId, shippingAddress: 'x' }, channel: 'ONLINE', sourceSystem: 'SCALEEZY_SHOP', externalOrderId: `GAP-${STAMP}`, items: [{ variantId: vB, quantity: 1 }, { variantId: vS, quantity: 1 }] }, 'ONLINE');
  await salesOrderService.confirmOrder(C, order.id);
  const pl = await owner.get('/pick/list', { params: { locationId: LOC, orderIds: order.id } });
  const pick = data(pl);
  const svcShort = (pick?.short ?? []).some((s: any) => s.item?.variantId === vS || s.variantId === vS || s.item?.sku === `GAP-${STAMP}-S`);
  const svcAnywhere = JSON.stringify(pick ?? {}).includes(`GAP-${STAMP}-S`);
  check('the stitching line is not on the pick list, nor listed as short', pl.status === 200 && !svcShort && !svcAnywhere, brief(pl));
  check('  ...the saree line still is', JSON.stringify(pick ?? {}).includes(`GAP-${STAMP}-B`), brief(pl));

  console.log('\nE. MOVING AN ITEM THAT DOES NOT EXIST');
  const ghost = '00000000-0000-4000-8000-000000000000';
  const mv = await owner.post('/move', { locationId: LOC, variantId: ghost, fromSpotId: shelf.id, quantity: 1 });
  check('refused in words, no ids in the message', mv.status >= 400 && !msg(mv).includes(ghost) && msg(mv).length > 0, brief(mv));

  console.log('\nF. "NOT FOUND ON THE SHELF" REPORTS');
  const nf1 = await owner.post('/not-found', { spotId: shelf.id, variantId: vB, missing: 50 });
  check('50 missing from a shelf that holds 3: refused, saying it holds 3', nf1.status === 400 && /3/.test(msg(nf1)), brief(nf1));
  const issuesBefore = await prisma.shelfIssue.count({ where: { clientId: C, variantId: vB, spotId: shelf.id } });
  const [nf2, nf3] = [await owner.post('/not-found', { spotId: shelf.id, variantId: vB, missing: 1 }), await owner.post('/not-found', { spotId: shelf.id, variantId: vB, missing: 1 })];
  const issuesAfter = await prisma.shelfIssue.count({ where: { clientId: C, variantId: vB, spotId: shelf.id } });
  check('the same report pressed twice: one problem, both answered OK', nf2.status < 300 && nf3.status < 300 && issuesAfter - issuesBefore === 1, `${brief(nf2)} | ${brief(nf3)} | +${issuesAfter - issuesBefore}`);

  console.log('\nG. THE "NOT ON A SHELF" TOTAL');
  const tree = data(await owner.get(`/locations/${LOC}/spots`));
  const rows = await prisma.inventoryStock.findMany({ where: { clientId: C, locationId: LOC }, select: { variantId: true, quantity: true } });
  const shelvedRows = await prisma.spotStock.groupBy({ by: ['variantId'], where: { clientId: C, locationId: LOC }, _sum: { quantity: true } });
  const shelvedOf = new Map(shelvedRows.map(r => [r.variantId, r._sum.quantity ?? 0]));
  const expected = rows.reduce((t, r) => t + Math.max(0, r.quantity - (shelvedOf.get(r.variantId) ?? 0)), 0);
  check(`"not on a shelf" counts each item's waiting pieces, ignoring A at -1 (expected ${expected})`, tree?.pieces?.notShelved === expected, JSON.stringify(tree?.pieces));

  console.log('\nH. WRONG FIELD TYPES IN PLAIN WORDS');
  const h1 = await owner.post('/move', { locationId: LOC, variantId: 123, fromSpotId: shelf.id, quantity: 1 });
  check('an item id that is a number: plain words, not "Expected string"', h1.status === 400 && !/Expected|received/i.test(msg(h1)), brief(h1));
  const h2 = await owner.post('/move', { locationId: LOC, variantId: vB, fromSpotId: shelf.id, quantity: 1, note: 'x'.repeat(201) });
  check('a 201-letter note: plain words, not "String must contain"', h2.status === 400 && !/String must contain|character\(s\)/i.test(msg(h2)), brief(h2));

  console.log('\nI. CONFIRMING AN EMPTY SHELF');
  const ce = await owner.post(`/spots/${empty.id}/count`, { counts: [], complete: true });
  check('"I counted the whole shelf" with nothing recorded and nothing found: accepted', ce.status === 200 && data(ce)?.counted === 0, brief(ce));

  console.log('\nJ. A COUNT AND ITS PROBLEM ARE SAVED TOGETHER');
  const c3 = await owner.post(`/spots/${shelf.id}/count`, { counts: [{ variantId: vB, counted: 2 }], complete: false });
  const line = data(c3)?.results?.[0];
  const issue = await prisma.shelfIssue.findFirst({ where: { clientId: C, variantId: vB, spotId: shelf.id }, orderBy: { createdAt: 'desc' } });
  check('3 → 2: shelf 2, the problem says 1 fewer, the line has no error', await onShelf(shelf.id, vB) === 2 && !line?.error && /1 fewer/.test(issue?.message ?? ''), `${brief(c3)} | ${issue?.message}`);
}

main()
  .catch((e) => { failed++; console.error(e); })
  .finally(async () => {
    console.log(`\nRESULT: ${passed} passed | ${failed} failed`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
