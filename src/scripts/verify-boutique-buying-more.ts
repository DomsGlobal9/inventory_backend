/**
 * Buying in full through the boutique API (20 Nov 2026, PLAN-boutique-backend.md part 5), against the REAL local server
 * and database: which supplier sells which item (price per metre for cloth, minimum order, lead time, preferred), reorder
 * suggestions grouped by the preferred supplier, draft orders in one go, an order's status and where it is delivered,
 * emailing it (refusals only -- no real email is sent), removing a supplier, permissions and another shop kept apart.
 *
 * Throwaway accounts only (bmtest-*); everything it makes is removed. Local only.
 *   DATABASE_URL=<local> DIRECT_URL=<local> VERIFY_API_URL=http://localhost:4036/api/v1 \
 *   BOUTIQUE_KEY_DIR=<dir with private.pem> npx tsx src/scripts/verify-boutique-buying-more.ts
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
const TEN = `bmtest-${S}`, TEN2 = `bmtest-${S}-b`;
let bad = 0, good = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  ok ? good++ : bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const ALL = ['products:write', 'stock:write', 'suppliers:write'];
const pass = (tenant: string, can: string[]) => jwt.sign({ sub: 'crm-b', scope: ['modules:boutique'], tenant, onBehalfOf: { userId: 'u1', name: 'Lakshmi', can } },
  privateKey, { algorithm: 'RS256', audience: 'inventory', issuer: 'scaleezy-boutique-test', keyid: 'btq-1', expiresIn: '5m' });
let n = 0;
async function call(method: string, p: string, body?: unknown, o: { tenant?: string; can?: string[] } = {}) {
  const r = await axios.request({ method, url: `${BASE}/internal/boutique${p}`, data: body, validateStatus: () => true, timeout: 90_000,
    headers: { Authorization: `Bearer ${pass(o.tenant ?? TEN, o.can ?? ALL)}`, ...(method !== 'GET' ? { 'Idempotency-Key': `bm-${S}-${++n}` } : {}) } });
  return { status: r.status, data: r.data?.data, message: r.data?.message as string | undefined };
}

async function main() {
  const link = await call('POST', '/link', { shopName: 'Buying Test' });
  const clientId = link.data.clientId as string;
  await call('POST', '/link', { shopName: 'Other' }, { tenant: TEN2 });
  const SILK = `${S}-SK`, BTN = `${S}-BT`;
  await call('PUT', `/items/${SILK}`, { name: 'Kanchi silk', kind: 'FABRIC', unit: 'METER', sellingPrice: 450, reorderLevel: 10 });
  await call('PUT', `/items/${BTN}`, { name: 'Shell button', category: 'EMBELLISHMENT', unit: 'PIECE', sellingPrice: 5, reorderLevel: 5 });
  await call('POST', '/movements', { itemCode: SILK, kind: 'PURCHASE', quantity: 2 });
  await call('POST', '/movements', { itemCode: BTN, kind: 'PURCHASE', quantity: 1 });
  const s1 = (await call('POST', '/suppliers', { name: 'Ravi Silks', phone: '9849012345' })).data;
  const s2 = (await call('POST', '/suppliers', { name: 'Meena Trims' })).data;

  console.log('\nWHICH SUPPLIER SELLS WHICH ITEM');
  const l1 = await call('POST', '/supplier-items', { supplierId: s1.id, itemCode: SILK, supplierSku: 'RS-KANCHI-G', costPrice: 280, minOrderQty: 5, leadTimeDays: 3, preferred: true });
  check('Ravi sells the silk at Rs 280 a metre, minimum 5 m, 3 days, preferred', l1.status === 201 && l1.data?.costPrice === 280 && l1.data?.minOrderQty === 5 && l1.data?.preferred === true && l1.data?.unit === 'METRE', l1);
  const l2 = await call('POST', '/supplier-items', { supplierId: s2.id, itemCode: SILK, costPrice: 300 });
  await call('POST', '/supplier-items', { supplierId: s2.id, itemCode: BTN, costPrice: 1.5, minOrderQty: 50 });
  const row = await prisma.supplierProduct.findUnique({ where: { id: l1.data.id } });
  check('...kept per centimetre underneath (2.80), shown per metre', Number(row?.costPrice) === 2.8 && row?.minOrderQty === 500, row);
  const silkSup = await call('GET', `/items/${SILK}/suppliers`, undefined, { can: [] });
  check('the silk\'s suppliers: Ravi 280 (preferred) and Meena 300', silkSup.status === 200 && silkSup.data.length === 2 && silkSup.data.find((x: any) => x.supplierId === s1.id)?.costPrice === 280 && silkSup.data.find((x: any) => x.supplierId === s2.id)?.costPrice === 300, silkSup.data);
  const meena = await call('GET', `/suppliers/${s2.id}/items`);
  check('what Meena sells: the silk and the buttons', meena.data?.length === 2 && meena.data.some((x: any) => x.itemCode === BTN), meena.data);
  const again = await call('POST', '/supplier-items', { supplierId: s1.id, itemCode: SILK, costPrice: 290 });
  check('the same supplier and item again: changed, not doubled', [200, 201].includes(again.status) && (await prisma.supplierProduct.count({ where: { supplierId: s1.id } })) === 1 && again.data?.costPrice === 290, again);
  const pref = await call('POST', `/supplier-items/${l2.data.id}/preferred`, {});
  const after = (await call('GET', `/items/${SILK}/suppliers`)).data;
  check('Meena made preferred: only she is', pref.status === 200 && after.find((x: any) => x.supplierId === s2.id)?.preferred === true && after.find((x: any) => x.supplierId === s1.id)?.preferred === false, after);
  check('without suppliers:write: 403', (await call('POST', '/supplier-items', { supplierId: s1.id, itemCode: BTN, costPrice: 1 }, { can: ['products:write'] })).status === 403);
  check('another shop\'s supplier: 404', (await call('GET', `/suppliers/${s1.id}/items`, undefined, { tenant: TEN2 })).status === 404);
  check('an item not in the shop: 404 naming it', /NOPE-1/.test((await call('POST', '/supplier-items', { supplierId: s1.id, itemCode: 'NOPE-1' })).message ?? ''));
  check('a lead time of 1.5 days: 400', (await call('POST', '/supplier-items', { supplierId: s1.id, itemCode: BTN, leadTimeDays: 1.5 })).status === 400);

  console.log('\nREORDER');
  const sug = await call('GET', '/reorder');
  const mine = sug.data?.suppliers?.find((x: any) => x.supplierId === s2.id);
  const silkLine = mine?.lines?.find((l: any) => l.itemCode === SILK);
  check('below their levels: both under Meena (preferred), in metres and pieces', !!silkLine && mine.lines.some((l: any) => l.itemCode === BTN) && silkLine.unit === 'METRE' && silkLine.inStock === 2 && silkLine.reorderLevel === 10 && silkLine.unitCost === 300, sug.data);
  const drafts = await call('POST', '/reorder/draft-orders', { groups: [{ supplierId: s2.id, lines: [{ itemCode: SILK, quantity: 8.5, unitCost: 300 }, { itemCode: BTN, quantity: 50, unitCost: 1.5 }] }] });
  const po = await prisma.purchaseOrder.findFirst({ where: { clientId, supplierId: s2.id }, include: { items: true } });
  check('draft orders: one for Meena, DRAFT, 8.5 m kept as 850 cm at Rs 3 a cm', drafts.status === 201 && po?.status === 'DRAFT' && po.items.some(i => i.orderedQty === 850 && Number(i.unitPrice) === 3), [drafts.status, drafts.message, po?.items]);
  check('a quantity below a centimetre: 400', (await call('POST', '/reorder/draft-orders', { groups: [{ supplierId: s2.id, lines: [{ itemCode: SILK, quantity: 1.005 }] }] })).status === 400);
  check('no groups: 400', (await call('POST', '/reorder/draft-orders', { groups: [] })).status === 400);

  console.log('\nTHE ORDER: WHERE, STATUS, EMAIL');
  const store2 = (await call('POST', '/stores', { name: 'Godown' })).data;
  const dt = await call('PUT', `/purchase-orders/${po!.id}/deliver-to`, { storeId: store2.id });
  check('delivered to the godown', dt.status === 200 && dt.data?.locationId === store2.id, dt);
  const mail = await call('POST', `/purchase-orders/${po!.id}/email`, {});
  check('email to a supplier with no email address: refused in words, nothing sent', mail.status >= 400 && mail.status < 500 && (mail.message ?? '').length > 10, mail);
  const sent = await call('POST', `/purchase-orders/${po!.id}/status`, { status: 'SENT' });
  check('marked SENT', sent.status === 200 && sent.data?.status === 'SENT', sent);
  check('a status that is not one: 400', (await call('POST', `/purchase-orders/${po!.id}/status`, { status: 'RECEIVED' })).status === 400);
  const cancelled = await call('POST', `/purchase-orders/${po!.id}/status`, { status: 'CANCELLED' });
  check('cancelled', cancelled.status === 200 && cancelled.data?.status === 'CANCELLED', cancelled);
  check('another shop cannot touch it (404)', (await call('POST', `/purchase-orders/${po!.id}/status`, { status: 'SENT' }, { tenant: TEN2 })).status === 404);

  console.log('\nREMOVING');
  const unl = await call('DELETE', `/supplier-items/${l1.data.id}`);
  check('Ravi no longer listed for the silk', unl.status === 200 && !(await call('GET', `/items/${SILK}/suppliers`)).data.some((x: any) => x.supplierId === s1.id));
  const keep = await call('DELETE', `/suppliers/${s2.id}`);
  check('Meena has an order: kept, 409 saying to switch her off instead', keep.status === 409 && /Switch it off/.test(keep.message ?? ''), keep);
  const gone = await call('DELETE', `/suppliers/${s1.id}`);
  check('Ravi (no orders): removed', gone.status === 200 && !(await prisma.supplier.count({ where: { id: s1.id } })), gone);
}

async function cleanup() {
  const ids = (await prisma.boutiqueLink.findMany({ where: { tenant: { startsWith: 'bmtest-' } }, select: { clientId: true } })).map(l => l.clientId);
  if (!ids.length) return;
  await prisma.$executeRawUnsafe(`DELETE FROM supplier_products WHERE supplier_id IN (SELECT id FROM suppliers WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DELETE FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE client_id = ANY($1))`, ids).catch(() => undefined);
  const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'client_id'`;
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
