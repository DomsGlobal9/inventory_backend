import { prisma } from '../../lib/prisma';
import { stockCountService } from '../stock-count.service';
import { returnService } from '../return.service';
import { SHOP_SOURCE } from '../online-shop/checkout';
import { factorOf } from '../../lib/units';
import { problem, storeOf, baseQty, type Actor } from './index';

/**
 * Stock count sessions and returns of online orders through the boutique API (20 Nov 2026, PLAN-boutique-backend.md
 * #28 #32): the same services as Inventory's Stock count and Returns screens, with items named by the boutique's codes
 * and quantities in the item's unit (metres for cloth).
 *   Counts: stock:write. Returns: orders:write.
 */
const mustCount = (a: Actor) => { if (!a.can.includes('stock:write')) throw problem('This person may not run stock counts.', 403); };
const mustReturn = (a: Actor) => { if (!a.can.includes('orders:write')) throw problem('This person may not handle returns.', 403); };
const by = (a: Actor) => `${a.name} (Boutique)`.slice(0, 120);
async function said<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e: any) {
    if (e?.statusCode || e?.status) throw problem(String(e.message), e.statusCode ?? e.status);
    throw e;
  }
}

/* ── stock count sessions ─────────────────────────────────────────────────────────────────────── */
async function ownCount(clientId: string, id: string) {
  const c = await prisma.stockCount.findFirst({ where: { id, clientId }, select: { id: true } });
  if (!c) throw problem('That stock count is not this shop\'s.', 404);
}
function countView(c: any) {
  const items = (c.items ?? []).map((i: any) => {
    const f = factorOf(i.variant?.product?.soldBy);
    return { itemCode: i.variant?.boutiqueRef ?? i.variant?.variantCode ?? null, name: i.variant?.product?.title ?? null, unit: i.variant?.product?.soldBy ?? 'PIECE',
      expected: i.expectedQty / f, counted: i.countedQty == null ? null : i.countedQty / f, difference: i.countedQty == null ? null : (i.countedQty - i.expectedQty) / f };
  });
  return { id: c.id, name: c.name, status: c.status, storeId: c.locationId, createdAt: c.createdAt, startedAt: c.startedAt ?? null, completedAt: c.completedAt ?? null,
    items, counted: items.filter((i: any) => i.counted !== null).length, total: items.length };
}
async function countFull(clientId: string, id: string) {
  const c = await prisma.stockCount.findFirst({ where: { id, clientId }, include: { items: { include: { variant: { select: { boutiqueRef: true, variantCode: true, product: { select: { title: true, soldBy: true } } } } } } } });
  if (!c) throw problem('That stock count is not this shop\'s.', 404);
  return countView(c);
}
export async function counts(a: Actor) {
  const rows = await prisma.stockCount.findMany({ where: { clientId: a.clientId }, orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map(c => ({ id: c.id, name: c.name, status: c.status, storeId: c.locationId, createdAt: c.createdAt }));
}
export const count = (a: Actor, id: string) => countFull(a.clientId, id);
/** A new count for one store: { name, storeId }. It starts as a draft; start it to take the expected quantities. */
export async function newCount(a: Actor, body: any) {
  mustCount(a);
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) throw problem('Name the count, for example "Godown, November".');
  const locationId = await storeOf(a.clientId, body?.storeId);
  const made: any = await said(() => stockCountService.createCount(a.clientId, name, locationId, undefined, by(a)) as any);
  return countFull(a.clientId, made.id);
}
export async function startCount(a: Actor, id: string) { mustCount(a); await ownCount(a.clientId, id); await said(() => stockCountService.startCount(a.clientId, id) as any); return countFull(a.clientId, id); }
/** What was found for one item: { itemCode, counted } (null clears it). */
export async function countItem(a: Actor, id: string, body: any) {
  mustCount(a); await ownCount(a.clientId, id);
  const code = String(body?.itemCode ?? '').trim();
  const item = await prisma.stockCountItem.findFirst({ where: { stockCountId: id, variant: { clientId: a.clientId, OR: [{ boutiqueRef: code }, { variantCode: code }, { sku: code }, { barcode: code }] } }, include: { variant: { select: { product: { select: { soldBy: true } } } } } });
  if (!item) throw problem(`${code || 'That item'} is not in this count.`, 404);
  const counted = body?.counted === null ? null : baseQty(body?.counted, item.variant.product.soldBy as any, 'count');
  if (counted !== null && counted < 0) throw problem('A count cannot be below 0.');
  await said(() => stockCountService.updateItemCount(a.clientId, id, item.id, counted) as any);
  return countFull(a.clientId, id);
}
/** Finishes: every difference is written as a correction, the stock becomes what was found. */
export async function completeCount(a: Actor, id: string) { mustCount(a); await ownCount(a.clientId, id); await said(() => stockCountService.completeCount(a.clientId, id, by(a)) as any); return countFull(a.clientId, id); }
export async function cancelCount(a: Actor, id: string) { mustCount(a); await ownCount(a.clientId, id); await said(() => stockCountService.cancelCount(a.clientId, id, by(a)) as any); return countFull(a.clientId, id); }

/* ── returns of online orders ─────────────────────────────────────────────────────────────────── */
const REASONS = ['DAMAGED_IN_TRANSIT', 'WRONG_ITEM', 'SIZE_ISSUE', 'CUSTOMER_REJECTED', 'DEFECTIVE', 'OTHER'];
async function returnFull(clientId: string, id: string) {
  const r = await prisma.salesReturn.findFirst({ where: { id, clientId }, include: { salesOrder: { select: { orderNumber: true } },
    items: { include: { dispatchItem: { include: { salesOrderItem: { include: { variant: { select: { boutiqueRef: true, variantCode: true, product: { select: { title: true, soldBy: true } } } } } } } } } } } as any }) as any;
  if (!r) throw problem('That return is not this shop\'s.', 404);
  return {
    id: r.id, returnNumber: r.returnNumber, orderNumber: r.salesOrder?.orderNumber ?? null, status: r.status, reason: r.reason, notes: r.notes ?? null, createdAt: r.createdAt,
    items: r.items.map((i: any) => { const v = i.dispatchItem?.salesOrderItem?.variant; const f = factorOf(v?.product?.soldBy);
      return { itemCode: v?.boutiqueRef ?? v?.variantCode ?? null, name: v?.product?.title ?? null, quantity: i.quantity / f, disposition: i.disposition, refund: i.refundAmount != null ? Number(i.refundAmount) : null }; })
  };
}
async function ownReturn(clientId: string, id: string) {
  const r = await prisma.salesReturn.findFirst({ where: { id, clientId }, select: { id: true } });
  if (!r) throw problem('That return is not this shop\'s.', 404);
}
export async function returns(a: Actor, q: Record<string, unknown>) {
  const rows = await prisma.salesReturn.findMany({ where: { clientId: a.clientId, salesOrder: { sourceSystem: SHOP_SOURCE }, ...(q.status ? { status: String(q.status).toUpperCase() as any } : {}) }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true } });
  return Promise.all(rows.map(r => returnFull(a.clientId, r.id)));
}
export const getReturn = (a: Actor, id: string) => returnFull(a.clientId, id);
/** A customer wants to send pieces back: { lines: [{ itemCode, quantity }], reason, notes }. Only pieces that were sent. */
export async function askReturn(a: Actor, orderNumber: string, body: any) {
  mustReturn(a);
  const order = await prisma.salesOrder.findFirst({ where: { clientId: a.clientId, orderNumber, sourceSystem: SHOP_SOURCE, deletedAt: null }, select: { id: true } });
  if (!order) throw problem(`No online order ${orderNumber} in this shop.`, 404);
  const reason = String(body?.reason ?? 'OTHER').toUpperCase();
  if (!REASONS.includes(reason)) throw problem(`reason is one of ${REASONS.join(', ')}.`);
  if (!Array.isArray(body?.lines) || !body.lines.length) throw problem('Send lines: each { itemCode, quantity }.');
  const sent = await prisma.dispatchItem.findMany({ where: { dispatch: { salesOrderId: order.id } }, include: { salesOrderItem: { include: { variant: { select: { boutiqueRef: true, variantCode: true, sku: true, product: { select: { soldBy: true } } } } } } } });
  const items: { dispatchItemId: string; quantity: number }[] = [];
  for (const l of body.lines) {
    const code = String(l?.itemCode ?? '').trim();
    const d = sent.find(s => [s.salesOrderItem.variant.boutiqueRef, s.salesOrderItem.variant.variantCode, s.salesOrderItem.variant.sku].includes(code));
    if (!d) throw problem(`${code || 'That item'} was not sent on this order, so it cannot come back.`, 409);
    const q = baseQty(l?.quantity, d.salesOrderItem.variant.product.soldBy as any, `quantity of ${code}`);
    if (q <= 0 || q > d.quantity) throw problem(`${code}: between ${1 / factorOf(d.salesOrderItem.variant.product.soldBy)} and what was sent.`);
    items.push({ dispatchItemId: d.id, quantity: q });
  }
  const notes = `${typeof body?.notes === 'string' ? body.notes.slice(0, 300) : ''} -- ${by(a)}`.trim();
  const made: any = await said(() => returnService.createReturn(a.clientId, order.id, items, notes, reason as any) as any);
  return returnFull(a.clientId, made.id);
}
export async function receiveReturn(a: Actor, id: string) { mustReturn(a); await ownReturn(a.clientId, id); await said(() => returnService.receiveReturn(a.clientId, id) as any); return returnFull(a.clientId, id); }
/** What came back is: { lines: [{ itemCode, disposition: RESTOCK | DAMAGED | SCRAP }] }. RESTOCK puts it back on sale. */
export async function inspectReturn(a: Actor, id: string, body: any) {
  mustReturn(a); await ownReturn(a.clientId, id);
  const r = await prisma.salesReturn.findFirst({ where: { id }, include: { items: { include: { dispatchItem: { include: { salesOrderItem: { include: { variant: { select: { boutiqueRef: true, variantCode: true, sku: true } } } } } } } } } as any }) as any;
  if (!Array.isArray(body?.lines) || !body.lines.length) throw problem('Send lines: each { itemCode, disposition }.');
  const dispositions = body.lines.map((l: any) => {
    const code = String(l?.itemCode ?? '').trim();
    const item = r.items.find((i: any) => { const v = i.dispatchItem?.salesOrderItem?.variant; return v && [v.boutiqueRef, v.variantCode, v.sku].includes(code); });
    if (!item) throw problem(`${code || 'That item'} is not on this return.`, 404);
    const disposition = String(l?.disposition ?? '').toUpperCase();
    if (!['RESTOCK', 'DAMAGED', 'SCRAP'].includes(disposition)) throw problem('disposition is RESTOCK, DAMAGED or SCRAP.');
    return { salesReturnItemId: item.id, disposition };
  });
  await said(() => returnService.inspectReturn(a.clientId, id, dispositions as any) as any);
  return returnFull(a.clientId, id);
}
/** Completes: restocked pieces go back on sale; money paid online goes back. */
export async function completeReturn(a: Actor, id: string) { mustReturn(a); await ownReturn(a.clientId, id); await said(() => returnService.completeReturn(a.clientId, id) as any); return returnFull(a.clientId, id); }
export async function rejectReturn(a: Actor, id: string) { mustReturn(a); await ownReturn(a.clientId, id); await said(() => returnService.rejectReturn(a.clientId, id) as any); return returnFull(a.clientId, id); }
