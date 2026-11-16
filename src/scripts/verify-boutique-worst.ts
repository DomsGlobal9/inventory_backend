/**
 * Worst cases for the boutique API (16 Nov, after the CRM-B checklist build), against the REAL local server and
 * database. Imagined collisions, duplicates, absences and limits, each with the answer it SHOULD give:
 *  - two shops: every id of shop A (place, shelf, supplier, purchase order, hold, problem, item) used by shop B
 *  - races: the same new code twice at once (ifNew), the same supplier name twice at once, two cuts from one hold
 *  - limits: a billion metres, a price over a crore, 2.555 m, negatives, 0 opening stock, empty bodies
 *  - removed places: no stock in or out, POST /stores with its name brings it back
 *  - purchase orders: the same item on two lines, a switched-off supplier, a draft received, one line twice in a delivery
 *  - dates: a sale at 00:30 India time is on that India day in the movement list
 *  - the change feed: three movements at the same instant are paged without a gap or a repeat
 *  - permissions: an empty can-list reads everything and changes nothing
 * Throwaway boutiques only (worsttest-*); everything is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-worst.ts
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
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const ALL = ['products:write', 'stock:write', 'stitching:issue', 'suppliers:write', 'reports:view'];
let n = 0;
const shop = (tenant: string) => async (method: string, path: string, body?: unknown, o: { can?: string[]; key?: string } = {}) => {
  const pass = jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Worst', can: o.can ?? ALL } },
    privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Authorization: `Bearer ${pass}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `worst-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, replay: r.headers['idempotent-replay'] };
};
const A = shop(`worsttest-a-${S}`), B = shop(`worsttest-b-${S}`);
const silk = (extra: Record<string, unknown> = {}) => ({ name: 'Kanchi silk', category: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, purchasePrice: 280, ...extra });

async function main() {
  const la = await A('POST', '/link', { shopName: 'Worst A' }), lb = await B('POST', '/link', { shopName: 'Worst B' });
  check('two throwaway boutiques linked', la.status === 201 && lb.status === 201, [la, lb]);
  const cA = la.data.clientId as string;
  const SILK = `SILK-${S}`;
  await A('PUT', `/items/${SILK}`, silk({ openingStock: [{ quantity: 20 }] }));
  const mainA = (await A('GET', '/stores')).data[0].id as string;
  const mainB = (await B('GET', '/stores')).data[0].id as string;

  console.log('\nLIMITS AND ODD INPUTS');
  check('a billion metres: 400 "too large", not a crash', /too large/.test((await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 1_000_000_000 })).message ?? ''));
  check('21,474,837 m (past the database\'s whole numbers): 400, not a crash', (await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 21_474_837 })).status === 400);
  check('a selling price of 2 crore: 400 in words', /between 0 and/.test((await A('PUT', `/items/${SILK}`, silk({ sellingPrice: 20_000_000 }))).message ?? ''));
  check('a negative purchase price: 400', (await A('PUT', `/items/${SILK}`, silk({ purchasePrice: -5 }))).status === 400);
  check('a purchase "quantity" of -3: 400', (await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: -3 })).status === 400);
  check('a quantity of "abc": 400 in words', /not a number/.test((await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 'abc' })).message ?? ''));
  check('a minimum stock of 2.555 m: 400', (await A('PUT', `/items/${SILK}`, silk({ minStock: 2.555 }))).status === 400);
  const Z = `ZERO-${S}`;
  const zero = await A('PUT', `/items/${Z}`, silk({ openingStock: [{ quantity: 0 }, { quantity: 0 }] }));
  check('opening stock of 0 (nothing yet): the item is made, with no movement', zero.status === 201 && zero.data?.stock === 0 && (await A('GET', `/items/${Z}/history`)).data?.length === 0, zero);
  check('opening stock of 21 lines: 400', (await A('PUT', `/items/O21-${S}`, silk({ openingStock: Array.from({ length: 21 }, () => ({ quantity: 1 })) }))).status === 400);
  check('opening stock that is not a list: 400', (await A('PUT', `/items/O1-${S}`, silk({ openingStock: 5 }))).status === 400);
  check('an empty movement body: 400', (await A('POST', '/movements', {})).status === 400);
  check('an empty hold-order body: 400', (await A('POST', '/holds/order', {})).status === 400);
  check('101 hold lines: 400', (await A('POST', '/holds/order', { orderRef: 'X', lines: Array.from({ length: 101 }, () => ({ itemCode: SILK, quantity: 0.01 })) })).status === 400);
  check('search with % and _ is taken as typed (finds nothing)', (await A('GET', '/items?search=%25_')).data?.total === 0);
  check('limit=0, page=-2: the defaults (20, page 1)', (await A('GET', '/items?limit=0&page=-2')).data?.limit === 20 && (await A('GET', '/items?limit=0&page=-2')).data?.page === 1);
  check('category in small letters works', (await A('GET', '/items?category=fabric')).data?.total === 2);
  check('an item code with a slash, URL-encoded', (await A('PUT', `/items/${encodeURIComponent(`KS/${S}`)}`, silk())).status === 201 && (await A('GET', `/items/${encodeURIComponent(`KS/${S}`)}`)).data?.itemCode === `KS/${S}`);

  console.log('\nRACES');
  const NEW = `NEW-${S}`;
  const twin = await Promise.all([A('PUT', `/items/${NEW}`, silk({ ifNew: true, openingStock: [{ quantity: 3 }] })), A('PUT', `/items/${NEW}`, silk({ ifNew: true, openingStock: [{ quantity: 3 }] }))]);
  const statuses = twin.map(t => t.status).sort();
  check('the same new code twice at once with ifNew: one 201, one 409; one item with 3 m (not 6)', statuses.join() === '201,409' && (await A('GET', `/items/${NEW}`)).data?.stock === 3, twin.map(t => [t.status, t.message]));
  const NEW2 = `NEW2-${S}`;
  const plain = await Promise.all([A('PUT', `/items/${NEW2}`, silk()), A('PUT', `/items/${NEW2}`, silk({ color: 'Red' }))]);
  check('the same new code twice at once, no ifNew: one 201, one 200 (an update), one item', plain.map(p => p.status).sort().join() === '200,201' && (await prisma.productVariant.count({ where: { clientId: cA, boutiqueRef: NEW2 } })) === 1, plain.map(p => [p.status, p.message]));
  const D2 = `DES2-${S}`;
  const cols = await Promise.all(['C1', 'C2', 'C3'].map(c => A('PUT', `/items/${D2}-${c}`, silk({ designGroup: D2, color: c }))));
  const designs = await prisma.product.count({ where: { clientId: cA, importKey: `boutique:${D2}` } });
  check('three new colours of one new design at once: all 201, ONE design with 3 colours', cols.every(c => c.status === 201) && designs === 1 && (await prisma.productVariant.count({ where: { clientId: cA, product: { importKey: `boutique:${D2}` } } })) === 3, [cols.map(c => c.status), designs]);
  const sups = await Promise.all([A('POST', '/suppliers', { name: `Twin Silks ${S}` }), A('POST', '/suppliers', { name: `TWIN SILKS ${S}` })]);
  check('the same supplier name twice at once: one made, one 409; one supplier', sups.map(s => s.status).sort().join() === '201,409' && (await prisma.supplier.count({ where: { clientId: cA, name: { equals: `Twin Silks ${S}`, mode: 'insensitive' } } })) === 1, sups.map(s => [s.status, s.message]));
  await A('POST', '/holds', { itemCode: SILK, quantity: 4, orderRef: 'RACE-1' });
  const cuts = await Promise.all([A('POST', '/movements', { itemCode: SILK, kind: 'CONSUME', quantity: 3, orderRef: 'RACE-1' }), A('POST', '/movements', { itemCode: SILK, kind: 'CONSUME', quantity: 3, orderRef: 'RACE-1' })]);
  const after = (await A('GET', `/items/${SILK}`)).data;
  check('two cuts of 3 m from one 4 m hold at once: both go through (4 from the hold + 2 free), stock 14, nothing held',
    cuts.every(c => c.status === 200) && cuts.reduce((t, c) => t + c.data.fromHold, 0) === 4 && after.stock === 14 && after.reserved === 0, [cuts.map(c => c.data), after]);
  const fin = await Promise.all(Array.from({ length: 5 }, () => A('POST', '/movements', { itemCode: SILK, kind: 'SALE', quantity: 4 })));
  check('five sales of 4 m at once with 14 m: exactly 3 go through, 2 refused 409, stock 2, never below 0',
    fin.filter(f => f.status === 200).length === 3 && fin.filter(f => f.status === 409).length === 2 && (await A('GET', `/items/${SILK}`)).data?.stock === 2, fin.map(f => f.status));

  console.log('\nANOTHER SHOP\'S IDS');
  const cut = await A('POST', '/stores', { name: 'Cutting', kind: 'CUTTING_UNIT' });
  const sup = (await A('POST', '/suppliers', { name: `Ravi ${S}` })).data;
  const po = (await A('POST', '/purchase-orders', { supplierId: sup.id, lines: [{ itemCode: SILK, quantity: 1, unitCost: 280 }] })).data;
  await A('PUT', `/items/${SILK}`, silk());
  await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 10 });
  const hold = (await A('POST', '/holds', { itemCode: SILK, quantity: 1, orderRef: 'A-ORD' })).data;
  await A('POST', `/stores/${mainA}/spots/bulk`, { levels: [{ kind: 'RACK', range: { codes: ['R1'] } }, { kind: 'SHELF', range: { from: 1, to: 1 } }] });
  const spot = await prisma.storageSpot.findFirst({ where: { clientId: cA, kind: 'SHELF' as any } });
  await B('PUT', `/items/${SILK}`, silk());
  const tries: [string, () => Promise<{ status: number }>][] = [
    ['B renames A\'s place', () => B('PUT', `/stores/${cut.data.id}`, { name: 'x' })],
    ['B removes A\'s place', () => B('DELETE', `/stores/${cut.data.id}`)],
    ['B reads what is at A\'s place', () => B('GET', `/stores/${cut.data.id}/items`)],
    ['B moves stock into A\'s place', () => B('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 1, locationId: cut.data.id })],
    ['B changes A\'s supplier', () => B('PUT', `/suppliers/${sup.id}`, { name: 'x' })],
    ['B orders from A\'s supplier', () => B('POST', '/purchase-orders', { supplierId: sup.id, lines: [{ itemCode: SILK, quantity: 1 }] })],
    ['B reads A\'s purchase order', () => B('GET', `/purchase-orders/${po.id}`)],
    ['B receives A\'s purchase order', () => B('POST', `/purchase-orders/${po.id}/receive`, { lines: [{ itemCode: SILK, quantity: 1 }] })],
    ['B releases A\'s hold', () => B('POST', `/holds/${hold.reservationId}/release`, {})],
    ['B cuts A\'s hold', () => B('POST', `/holds/${hold.reservationId}/issue`, {})],
    ['B reads A\'s shelf', () => B('GET', `/spots/${spot!.id}`)],
    ['B puts away onto A\'s shelf', () => B('POST', '/shelf-moves', { itemCode: SILK, locationId: mainB, toSpotId: spot!.id, quantity: 1 })],
    ['B counts A\'s shelf', () => B('POST', `/spots/${spot!.id}/count`, { counts: [] })],
    ['B reads A\'s racks', () => B('GET', `/stores/${mainA}/spots`)]
  ];
  for (const [name, fn] of tries) { const r = await fn(); check(`${name}: 404`, r.status === 404, r); }
  check('...and B sees none of A\'s holds, movements or suppliers', ((await B('GET', '/holds?all=1')).data ?? []).length === 0 && (await B('GET', '/movements')).data?.total === 0 && (await B('GET', '/suppliers')).data?.total === 0);
  check('...and A\'s hold is untouched', ((await A('GET', '/holds?orderRef=A-ORD')).data ?? [])[0]?.quantity === 1);

  console.log('\nREMOVED PLACES');
  await A('DELETE', `/stores/${cut.data.id}`);
  const intoRemoved = await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 1, locationId: cut.data.id });
  check('stock into a removed place: 409 in words', intoRemoved.status === 409 && /has been removed/.test(intoRemoved.message ?? ''), intoRemoved);
  check('a transfer into a removed place: 409', (await A('POST', '/transfers', { itemCode: SILK, quantity: 1, fromLocationId: mainA, toLocationId: cut.data.id })).status === 409);
  check('a hold at a removed place: 409', (await A('POST', '/holds', { itemCode: SILK, quantity: 1, orderRef: 'X', locationId: cut.data.id })).status === 409);
  const back = await A('POST', '/stores', { name: 'cutting', kind: 'CUTTING_UNIT' });
  check('POST /stores with the removed place\'s name (other case): the same place, back in use', back.data?.id === cut.data.id && back.data.broughtBack === true && (await A('GET', '/stores')).data.some((s: any) => s.id === cut.data.id), back);
  check('...and stock can go into it again', (await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 1, locationId: cut.data.id })).status === 200);

  console.log('\nPURCHASE ORDERS');
  check('the same item on two lines: 400 in words', /already on this order/.test((await A('POST', '/purchase-orders', { supplierId: sup.id, lines: [{ itemCode: SILK, quantity: 1 }, { itemCode: SILK, quantity: 2 }] })).message ?? ''));
  const off = (await A('POST', '/suppliers', { name: `Closed ${S}` })).data;
  await A('PUT', `/suppliers/${off.id}`, { active: false });
  check('ordering from a switched-off supplier: 409 in words', /switched off/.test((await A('POST', '/purchase-orders', { supplierId: off.id, lines: [{ itemCode: SILK, quantity: 1 }] })).message ?? ''));
  const twice = await A('POST', `/purchase-orders/${po.id}/receive`, { lines: [{ itemCode: SILK, quantity: 0.5 }, { lineId: po.lines[0].lineId, quantity: 0.5 }] });
  check('one line twice in one delivery: refused, nothing received', twice.status === 400 && (await A('GET', `/purchase-orders/${po.id}`)).data?.lines[0].received === 0, twice);
  const draftIn = await A('POST', `/purchase-orders/${po.id}/receive`, { lines: [{ itemCode: SILK, quantity: 1 }] });
  check('a draft received (as the shop\'s own screen allows): RECEIVED', draftIn.data?.status === 'RECEIVED', draftIn);
  check('a tax of 10.555: 400', (await A('POST', '/purchase-orders', { supplierId: sup.id, tax: 10.555, lines: [{ itemCode: SILK, quantity: 1 }] })).status === 400);
  check('a cost of 280.50 a metre: kept exactly (1.5 m = 420.75)', (await A('POST', '/purchase-orders', { supplierId: sup.id, lines: [{ itemCode: SILK, quantity: 1.5, unitCost: 280.5 }] })).data?.subtotal === 420.75);
  check('an expected date that is not one: 400', (await A('POST', '/purchase-orders', { supplierId: sup.id, expectedDate: 'soon', lines: [{ itemCode: SILK, quantity: 1 }] })).status === 400);
  check('a purchase order of another shop by id: 404 (not 500)', (await A('PUT', '/purchase-orders/not-an-id', { notes: 'x' })).status === 404);

  console.log('\nINDIA DAYS AND THE CHANGE FEED');
  const vA = await prisma.productVariant.findFirst({ where: { clientId: cA, boutiqueRef: SILK } });
  await inventoryMutationService.applyMovement({ clientId: cA, variantId: vA!.id, locationId: mainA, movementType: 'IN' as any, reason: 'PURCHASE' as any, quantityDelta: 100, referenceType: 'PO', notes: 'night delivery' });
  // 00:30 on 10 Nov in India is 19:00 on 9 Nov in UTC.
  await prisma.inventoryTransaction.updateMany({ where: { clientId: cA, notes: 'night delivery' }, data: { createdAt: new Date('2026-11-09T19:00:00Z') } });
  check('a delivery at 00:30 India time on 10 Nov is in the list for 10 Nov', (await A('GET', '/movements?from=2026-11-10&to=2026-11-10')).data?.total === 1);
  check('...and not in the list for 9 Nov', (await A('GET', '/movements?from=2026-11-09&to=2026-11-09')).data?.total === 0);
  const at = new Date(Date.now() - 600_000);
  for (let i = 0; i < 3; i++) await inventoryMutationService.applyMovement({ clientId: cA, variantId: vA!.id, locationId: mainA, movementType: 'OUT' as any, reason: 'SALE' as any, quantityDelta: -100, referenceType: 'ORDER', referenceId: `TIE-${i}`, notes: 'tie' });
  await prisma.inventoryTransaction.updateMany({ where: { clientId: cA, notes: 'tie' }, data: { createdAt: at } });
  const all: string[] = [];
  let next: string | null = null;
  for (let page = 0; page < 10; page++) {
    const r = await A('GET', `/changes?limit=1${next ? `&after=${encodeURIComponent(next)}` : ''}`);
    for (const c of r.data?.changes ?? []) all.push(c.id);
    next = r.data?.next;
    if (!r.data?.hasMore) break;
  }
  const ties = await prisma.inventoryTransaction.findMany({ where: { clientId: cA, notes: 'tie' }, select: { id: true } });
  check('three sales at the same instant, read one at a time: each once, none missed', ties.every(t => all.filter(x => x === t.id).length === 1), { all, ties: ties.map(t => t.id) });

  console.log('\nPERMISSIONS');
  const none: string[] = [];
  const reads = await Promise.all(['/items', '/stores', '/movements', '/alerts', '/suppliers', '/purchase-orders'].map(p => A('GET', p, undefined, { can: none })));
  check('an empty can-list reads items, places, movements, alerts, suppliers and orders', reads.every(r => r.status === 200), reads.map(r => r.status));
  const writes = await Promise.all([
    A('PUT', `/items/${SILK}`, silk(), { can: none }), A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 1 }, { can: none }),
    A('POST', '/holds', { itemCode: SILK, quantity: 1, orderRef: 'P' }, { can: none }), A('POST', '/stores', { name: 'P' }, { can: none }),
    A('POST', '/suppliers', { name: 'P' }, { can: none }), A('GET', '/reports/stock-summary', undefined, { can: none }),
    A('POST', '/photos', { files: [{ name: 'a', contentType: 'image/png', size: 1 }] }, { can: none })
  ]);
  check('...and changes nothing: items, stock, holds, places, suppliers, reports and photos all 403', writes.every(w => w.status === 403), writes.map(w => w.status));
  check('an unknown can word gives nothing', (await A('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 1 }, { can: ['stock:everything'] })).status === 403);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'worsttest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM purchase_receipt_items WHERE receipt_id IN (SELECT id FROM purchase_receipts WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_transaction_spots WHERE transaction_id IN (SELECT id FROM inventory_transactions WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`UPDATE storage_spots SET parent_id = NULL WHERE client_id = ANY($1)`, ids).catch(() => undefined);
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
