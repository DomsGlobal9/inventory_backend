/**
 * Suppliers, purchase orders and reports for the boutique (CRM-B checklist sections 4 and 9, 16 Nov), against the
 * REAL local server and database. Every number is worked out by hand in the check's name. Also proves the retail
 * purchase-order code still refuses cloth by the metre (only the boutique's calls may order by the metre).
 * Throwaway boutique account only (buytest-*); everything is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-buying.ts
 */
import fs from 'node:fs';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { purchaseOrderService } from '../services/purchase-order.service';

const BASE = process.env.VERIFY_API_URL || 'http://localhost:4036/api/v1';
for (const k of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!/localhost:55433/.test(process.env[k] ?? '')) { console.error(`Refusing: ${k} is not the local database.`); process.exit(2); }
}
if (!/localhost|127\.0\.0\.1/.test(BASE)) { console.error('Refusing: VERIFY_API_URL is not a local server.'); process.exit(2); }
const privateKey = fs.readFileSync(`${process.env.BOUTIQUE_KEY_DIR}/private.pem`, 'utf8');

const S = Date.now().toString(36);
const TEN = `buytest-${S}`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const ALL = ['products:write', 'stock:write', 'stitching:issue', 'suppliers:write', 'reports:view'];
const pass = (can = ALL) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant: TEN, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, path: string, body?: unknown, o: { can?: string[]; key?: string } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${path}`, data: body, validateStatus: () => true, timeout: 120_000,
    headers: { Authorization: `Bearer ${pass(o.can)}`, ...(method !== 'GET' ? { 'Idempotency-Key': o.key ?? `buy-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined, replay: r.headers['idempotent-replay'] };
}
const item = async (code: string) => (await call('GET', `/items/${code}`)).data;

async function main() {
  const link = await call('POST', '/link', { shopName: 'Buying Test Boutique' });
  check('a throwaway boutique is linked', link.status === 201, link);
  const clientId = link.data.clientId as string;
  const SILK = `SILK-${S}`, BTN = `BTN-${S}`;
  await call('PUT', `/items/${SILK}`, { name: 'Kanchi silk', category: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, purchasePrice: 280, reorderLevel: 30 });
  await call('PUT', `/items/${BTN}`, { name: 'Brass button', category: 'EMBELLISHMENT', sellingPrice: 20, purchasePrice: 15 });

  console.log('\nSUPPLIERS');
  check('adding a supplier without suppliers:write: 403', (await call('POST', '/suppliers', { name: 'Ravi Silks' }, { can: ['products:write'] })).status === 403);
  check('a GSTIN of 14 characters: 400 in words', /15 characters/.test((await call('POST', '/suppliers', { name: 'Ravi Silks', gstin: '36AABCU9603R1Z' })).message ?? ''));
  check('an email that is not one: 400', (await call('POST', '/suppliers', { name: 'Ravi Silks', email: 'ravi at gmail' })).status === 400);
  const sup = await call('POST', '/suppliers', { name: 'Ravi  Silks', contactPerson: 'Ravi', phone: '9848012345', email: 'ravi@example.invalid', gstin: '36aabcu9603r1zm', address: 'Dharmavaram', notes: 'Pays on delivery' });
  check('a supplier with every detail: 201, a code, the GSTIN in capitals, spaces tidied', sup.status === 201 && /^SUP/.test(sup.data?.code) && sup.data.gstin === '36AABCU9603R1ZM' && sup.data.name === 'Ravi Silks' && sup.data.contactPerson === 'Ravi', sup);
  check('the same name in other letters: 409', (await call('POST', '/suppliers', { name: 'RAVI SILKS' })).status === 409);
  const sup2 = (await call('POST', '/suppliers', { name: 'Old Traders' })).data;
  check('switch a supplier off: gone from the list, back with all=1', (await call('PUT', `/suppliers/${sup2.id}`, { active: false })).data?.active === false
    && !((await call('GET', '/suppliers')).data?.suppliers ?? []).some((s: any) => s.id === sup2.id) && ((await call('GET', '/suppliers?all=1')).data?.suppliers ?? []).some((s: any) => s.id === sup2.id));
  check('search "ravi" finds Ravi Silks', (await call('GET', '/suppliers?search=ravi')).data?.suppliers?.map((s: any) => s.name).join() === 'Ravi Silks');
  check('an item names its supplier', (await call('PUT', `/items/${SILK}`, { name: 'Kanchi silk', category: 'FABRIC', unit: 'METER', color: 'Maroon', sellingPrice: 450, purchasePrice: 280, reorderLevel: 30, supplierId: sup.data.id })).status === 200 && (await item(SILK))?.supplier?.name === 'Ravi Silks');
  check('a supplier of another shop on an item: 404', (await call('PUT', `/items/${BTN}`, { name: 'Brass button', category: 'EMBELLISHMENT', supplierId: '00000000-0000-0000-0000-000000000000' })).status === 404);

  console.log('\nPURCHASE ORDERS');
  const body = { supplierId: sup.data.id, expectedDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), invoiceNumber: 'INV-77', tax: 50, notes: 'Diwali stock',
    lines: [{ itemCode: SILK, quantity: 12.5, unitCost: 280, batchNumber: 'B-1' }, { itemCode: BTN, quantity: 10, unitCost: 15 }] };
  const key = `buy-po-${S}`;
  const po = await call('POST', '/purchase-orders', body, { key });
  check('a draft: 12.5 m at 280 + 10 buttons at 15 = 3650, + 50 tax = 3700', po.status === 201 && po.data?.status === 'DRAFT' && po.data.subtotal === 3650 && po.data.tax === 50 && po.data.total === 3700, po);
  check('...lines read back in metres and rupees a metre, with the batch', po.data?.lines?.[0]?.quantity === 12.5 && po.data.lines[0].unitCost === 280 && po.data.lines[0].batchNumber === 'B-1' && po.data.lines[1].quantity === 10, po.data?.lines);
  const again = await call('POST', '/purchase-orders', body, { key });
  check('the same request again: the same order, a replay, still one order', again.data?.id === po.data?.id && again.replay === 'true' && (await prisma.purchaseOrder.count({ where: { clientId } })) === 1, again);
  check('12.505 m on a line: 400, no order made', (await call('POST', '/purchase-orders', { ...body, lines: [{ itemCode: SILK, quantity: 12.505, unitCost: 280 }] })).status === 400 && (await prisma.purchaseOrder.count({ where: { clientId } })) === 1);
  check('an unknown item: 404 naming the line', /Line 1/.test((await call('POST', '/purchase-orders', { ...body, lines: [{ itemCode: 'NOPE', quantity: 1 }] })).message ?? ''));
  check('a new order cannot start RECEIVED', (await call('POST', '/purchase-orders', { ...body, status: 'RECEIVED' })).status === 400);
  check('a payment status LATER: 400', (await call('PUT', `/purchase-orders/${po.data.id}`, { paymentStatus: 'LATER' })).status === 400);
  const ord = await call('PUT', `/purchase-orders/${po.data.id}`, { status: 'ORDERED', paymentStatus: 'PARTIAL' });
  check('ordered, partly paid', ord.data?.status === 'ORDERED' && ord.data.paymentStatus === 'PARTIAL', ord);

  console.log('\nRECEIVING');
  const silk0 = (await item(SILK))?.stock ?? 0;
  const over = await call('POST', `/purchase-orders/${po.data.id}/receive`, { lines: [{ itemCode: SILK, quantity: 5 }, { itemCode: BTN, quantity: 11 }] });
  check('11 buttons when 10 were ordered: 409, and NOTHING received (not even the silk)', over.status === 409 && /Nothing was received/.test(over.message ?? '') && (await item(SILK))?.stock === silk0, over);
  const rk = `buy-rcv-${S}`;
  const r1 = await call('POST', `/purchase-orders/${po.data.id}/receive`, { lines: [{ itemCode: SILK, quantity: 5 }] }, { key: rk });
  check('5 m arrive: PARTLY_RECEIVED, 7.5 m outstanding, stock +5', r1.data?.status === 'PARTLY_RECEIVED' && r1.data.lines[0].outstanding === 7.5 && (await item(SILK))?.stock === silk0 + 5, r1);
  const r1b = await call('POST', `/purchase-orders/${po.data.id}/receive`, { lines: [{ itemCode: SILK, quantity: 5 }] }, { key: rk });
  check('...the same receipt sent again: a replay, stock not doubled', r1b.replay === 'true' && (await item(SILK))?.stock === silk0 + 5, r1b);
  check('8 m more when 7.5 m is outstanding: 409', (await call('POST', `/purchase-orders/${po.data.id}/receive`, { lines: [{ itemCode: SILK, quantity: 8 }] })).status === 409);
  const r2 = await call('POST', `/purchase-orders/${po.data.id}/receive`, { lines: [{ lineId: po.data.lines[0].lineId, quantity: 7.5 }, { itemCode: BTN, quantity: 10 }], invoiceNumber: 'INV-77B' });
  check('the rest arrives: RECEIVED, with the date, the new invoice number', r2.data?.status === 'RECEIVED' && !!r2.data.receivedAt && r2.data.invoiceNumber === 'INV-77B' && (await item(SILK))?.stock === silk0 + 12.5 && (await item(BTN))?.stock === 10, r2);
  check('a received order cannot be cancelled: 409', (await call('PUT', `/purchase-orders/${po.data.id}`, { status: 'CANCELLED' })).status === 409);
  const draft2 = (await call('POST', '/purchase-orders', { ...body, invoiceNumber: null })).data;
  check('a second draft is cancelled', (await call('PUT', `/purchase-orders/${draft2.id}`, { status: 'cancelled' })).data?.status === 'CANCELLED');
  check('orders by status: 1 RECEIVED, 1 CANCELLED', (await call('GET', '/purchase-orders?status=RECEIVED')).data?.total === 1 && (await call('GET', '/purchase-orders?status=CANCELLED')).data?.total === 1);
  check('a status that is not one: 400', (await call('GET', '/purchase-orders?status=LOST')).status === 400);
  const perf = ((await call('GET', '/suppliers/performance')).data ?? []).find((p: any) => p.supplierId === sup.data.id);
  check('supplier performance: 1 ordered, 1 received, on time 100%, 1 cancelled', perf?.ordered === 1 && perf.received === 1 && perf.onTimePercent === 100 && perf.cancelled === 1, perf);
  const spend = (await call('GET', '/reports/purchase-spend')).data;
  check('committed spend: 3700 (the cancelled draft is not spend)', spend?.total === 3700 && spend.orders === 1, spend);
  let retailRefused = false;
  const v = await prisma.productVariant.findFirst({ where: { clientId, boutiqueRef: SILK } });
  try { await purchaseOrderService.createPO(clientId, { supplierId: sup.data.id, items: [{ variantId: v!.id, orderedQty: 10, unitPrice: 2.8 }] }); } catch (e: any) { retailRefused = /sold by the metre/.test(e.message); }
  check('the retail purchase-order screen still refuses cloth by the metre (unchanged)', retailRefused);

  console.log('\nREPORTS');
  check('reports without reports:view: 403', (await call('GET', '/reports/stock-summary', undefined, { can: ['stock:write'] })).status === 403);
  // An order's cloth: hold 3 m, use 2 m and waste 0.5 m from the hold, return 0.5 m unused, damage 1 m.
  await call('POST', '/holds', { itemCode: SILK, quantity: 3, orderRef: 'ORD-9' });
  await call('POST', '/movements', { itemCode: SILK, kind: 'CONSUME', quantity: 2, orderRef: 'ORD-9' });
  await call('POST', '/movements', { itemCode: SILK, kind: 'WASTE', quantity: 0.5, orderRef: 'ORD-9' });
  await call('POST', '/movements', { itemCode: SILK, kind: 'RETURN_UNUSED', quantity: 0.5, orderRef: 'ORD-9' });
  await call('POST', '/movements', { itemCode: SILK, kind: 'DAMAGE', quantity: 1 });
  // Silk: 12.5 in, -2 -0.5 +0.5 -1 = 9.5 m; buttons 10.
  const ss = (await call('GET', '/reports/stock-summary')).data;
  check('stock summary: value 9.5 x 280 + 10 x 15 = 2810; 2 items; metres 9.5 on hand, 0.5 held', ss?.value === 2810 && ss.items === 2 && ss.byUnit?.METRE?.onHand === 9.5 && ss.byUnit.METRE.held === 0.5, ss);
  check('...silk is reorder due (9 m free <= 30 m), nothing out of stock or dead', ss?.reorderDue >= 1 && ss.outOfStock === 0 && ss.deadStock === 0, ss);
  const low = (await call('GET', '/reports/low-stock')).data ?? [];
  check('low stock: silk, 21 m short (30 - 9), from Ravi Silks', low.find((l: any) => l.itemCode === SILK)?.shortBy === 21 && low.find((l: any) => l.itemCode === SILK)?.supplier?.name === 'Ravi Silks', low);
  const con = (await call('GET', '/reports/consumption')).data;
  check('consumption: silk 2 m used = 560', con?.items?.length === 1 && con.items[0].quantity === 2 && con.items[0].value === 560, con);
  check('consumption narrowed to EMBELLISHMENT: nothing', (await call('GET', '/reports/consumption?category=EMBELLISHMENT')).data?.items?.length === 0);
  const loss = (await call('GET', '/reports/loss-rates')).data;
  const ls = loss?.items?.find((i: any) => i.itemCode === SILK);
  check('loss rates: waste 0.5 / (2 + 0.5) = 20%; damage 1 / 12.5 received = 8%', ls?.wastePercent === 20 && ls.damagePercent === 8, ls);
  const cpo = (await call('GET', '/reports/cost-per-order')).data;
  check('cost per order: ORD-9 used 560 + waste 140 = 700', cpo?.orders?.length === 1 && cpo.orders[0].orderRef === 'ORD-9' && cpo.orders[0].usedValue === 560 && cpo.orders[0].wasteValue === 140 && cpo.orders[0].total === 700, cpo);
  const ou = (await call('GET', '/reports/order-usage?orderRef=ORD-9')).data;
  check('order usage ORD-9: held now 0.5, used 2, wasted 0.5, returned 0.5, cost 700', ou?.lines?.[0]?.heldNow === 0.5 && ou.lines[0].used === 2 && ou.lines[0].wasted === 0.5 && ou.lines[0].returned === 0.5 && ou.totalCost === 700, ou);
  const ms = (await call('GET', '/reports/movement-summary')).data;
  const kind = (k: string) => ms?.kinds?.find((x: any) => x.kind === k);
  check('movement summary: 1 CONSUME of 2 m, 1 WASTE of -0.5 m, 1 DAMAGE', kind('CONSUME')?.count === 1 && kind('CONSUME').byUnit.METRE === -2 && kind('WASTE')?.byUnit.METRE === -0.5 && kind('DAMAGE')?.count === 1, ms);
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const db = await call('GET', `/reports/daybook?from=${today}&to=${today}`);
  check('the Day Book for today: the shop\'s own book answers', db.status === 200 && db.data && typeof db.data === 'object', db.status);
  check('a report with from after to: 400', (await call('GET', '/reports/consumption?from=2026-11-20&to=2026-11-01')).status === 400);
  check('a report with a date that is not one: 400', (await call('GET', '/reports/consumption?from=16-11-2026')).status === 400);
  check('the Day Book without dates: 400', (await call('GET', '/reports/daybook')).status === 400);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'buytest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
  await prisma.$executeRawUnsafe(`DELETE FROM purchase_receipt_items WHERE receipt_id IN (SELECT id FROM purchase_receipts WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE client_id = ANY($1))`, ids).catch(() => undefined);
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
