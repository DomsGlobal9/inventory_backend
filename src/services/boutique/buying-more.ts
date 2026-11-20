import { prisma } from '../../lib/prisma';
import { supplierProductService } from '../supplier-product.service';
import { supplierService } from '../supplier.service';
import { purchaseOrderService } from '../purchase-order.service';
import { reorderService } from '../reorder.service';
import { createOrder } from './buying';
import { factorOf } from '../../lib/units';
import { problem, storeOf, baseQty, type Actor } from './index';

/**
 * Buying in full through the boutique API (20 Nov 2026, PLAN-boutique-backend.md part 5, #14 #15a-d): which supplier
 * sells which item and the preferred one, reorder suggestions turned into draft orders (one per supplier), an order's
 * status and where it is delivered, emailing it to the supplier, and removing a supplier -- the same services as
 * Inventory's own Buying screens. Items are named by the boutique's codes; quantities and prices are in the item's
 * unit (metres for cloth), converted here from the per-centimetre figures those services keep.
 * Reading: anyone of the boutique. Changing: suppliers:write.
 */
const mustBuy = (a: Actor) => { if (!a.can.includes('suppliers:write')) throw problem('This person may not change suppliers or purchase orders.', 403); };
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Re-throws the reused services' errors with their status and sentence (some carry none). */
async function said<T>(run: () => Promise<T>, plain?: [RegExp, number, string][]): Promise<T> {
  try { return await run(); } catch (e: any) {
    for (const [re, status, sentence] of plain ?? []) if (re.test(String(e?.message))) throw problem(sentence, status);
    if (e?.statusCode) throw problem(String(e.message), e.statusCode);
    throw e;
  }
}

async function variantOfCode(clientId: string, code: unknown) {
  const c = String(code ?? '').trim();
  if (!c) throw problem('Give the item\'s code.');
  const v = await prisma.productVariant.findFirst({
    where: { clientId, boutiqueDeletedAt: null, OR: [{ boutiqueRef: c }, { barcode: c }, { variantCode: c }, { sku: c }] },
    select: { id: true, boutiqueRef: true, variantCode: true, product: { select: { title: true, soldBy: true } } }
  });
  if (!v) throw problem(`${c}: no such item in this shop.`, 404);
  return v;
}
async function ownSupplier(clientId: string, id: string) {
  const s = await prisma.supplier.findFirst({ where: { id, clientId }, select: { id: true } });
  if (!s) throw problem('That supplier is not in this shop.', 404);
}
async function ownOrder(clientId: string, id: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id, clientId }, select: { id: true } });
  if (!po) throw problem('That purchase order is not in this shop.', 404);
}
const soldByMap = async (ids: string[]) => new Map((ids.length ? await prisma.productVariant.findMany({ where: { id: { in: ids } }, select: { id: true, boutiqueRef: true, variantCode: true, product: { select: { soldBy: true } } } }) : [])
  .map(v => [v.id, { soldBy: String(v.product.soldBy), code: v.boutiqueRef ?? v.variantCode }]));

/* ── which supplier sells which item ───────────────────────────────────────────────────────────── */
function linkView(l: any, unit: { soldBy: string; code: string } | undefined) {
  const f = factorOf(unit?.soldBy);
  return {
    id: l.id, supplierId: l.supplierId, supplierName: l.supplier?.name ?? null, itemCode: unit?.code ?? null, unit: unit?.soldBy ?? 'PIECE',
    supplierSku: l.supplierSku ?? null, costPrice: l.costPrice != null ? round2(Number(l.costPrice) * f) : null,
    leadTimeDays: l.leadTimeDays ?? null, minOrderQty: l.minOrderQty != null ? l.minOrderQty / f : null, preferred: !!l.isPreferred, notes: l.notes ?? null
  };
}
export async function supplierItems(a: Actor, supplierId: string, search?: unknown) {
  await ownSupplier(a.clientId, supplierId);
  const rows: any[] = await said(() => supplierProductService.listBySupplier(a.clientId, supplierId, typeof search === 'string' ? search : undefined) as any);
  const units = await soldByMap(rows.map(r => r.variantId));
  return rows.map(r => linkView(r, units.get(r.variantId)));
}
export async function itemSuppliers(a: Actor, itemCode: string) {
  const v = await variantOfCode(a.clientId, itemCode);
  const rows: any[] = await said(() => supplierProductService.listByVariant(a.clientId, v.id) as any);
  const unit = { soldBy: String(v.product.soldBy), code: v.boutiqueRef ?? v.variantCode };
  return rows.map(r => linkView(r, unit));
}
/** Says that a supplier sells an item: their code for it, price per unit, lead time, minimum order, preferred. Again = changed. */
export async function linkSupplierItem(a: Actor, body: any) {
  mustBuy(a);
  const supplierId = String(body?.supplierId ?? '');
  await ownSupplier(a.clientId, supplierId);
  const v = await variantOfCode(a.clientId, body?.itemCode);
  const f = factorOf(v.product.soldBy);
  const cost = body?.costPrice == null || body.costPrice === '' ? null : Number(body.costPrice);
  if (cost !== null && !(cost >= 0 && cost <= 10_000_000)) throw problem('costPrice is the supplier\'s price per unit, in rupees.');
  const min = body?.minOrderQty == null || body.minOrderQty === '' ? null : baseQty(body.minOrderQty, v.product.soldBy as any, 'minimum order');
  const lead = body?.leadTimeDays == null || body.leadTimeDays === '' ? null : Number(body.leadTimeDays);
  if (lead !== null && !(Number.isInteger(lead) && lead >= 0 && lead <= 365)) throw problem('leadTimeDays is whole days, 0 to 365.');
  const row: any = await said(() => supplierProductService.link(a.clientId, {
    supplierId, variantId: v.id, supplierSku: body?.supplierSku ?? null, costPrice: cost === null ? null : cost / f,
    leadTimeDays: lead, minOrderQty: min, isPreferred: body?.preferred === true, notes: body?.notes ?? null
  }) as any);
  return linkView({ ...row, supplier: row.supplier ?? null }, { soldBy: String(v.product.soldBy), code: v.boutiqueRef ?? v.variantCode });
}
async function ownLink(clientId: string, id: string) {
  const l = await prisma.supplierProduct.findFirst({ where: { id, supplier: { clientId } }, select: { id: true } });
  if (!l) throw problem('That supplier-item link is not in this shop.', 404);
}
export async function setPreferred(a: Actor, linkId: string) {
  mustBuy(a); await ownLink(a.clientId, linkId);
  await said(() => supplierProductService.setPreferred(a.clientId, linkId));
  return { id: linkId, preferred: true };
}
export async function unlinkSupplierItem(a: Actor, linkId: string) {
  mustBuy(a); await ownLink(a.clientId, linkId);
  await said(() => supplierProductService.unlink(a.clientId, linkId));
  return { id: linkId, removed: true };
}

/* ── reorder: what to buy again, and draft orders in one go ─────────────────────────────────────── */
export async function reorderSuggestions(a: Actor, storeId?: unknown) {
  const locationId = storeId ? await storeOf(a.clientId, storeId) : null;
  const r: any = await said(() => reorderService.getSuggestions(a.clientId, locationId, { withLengths: true }) as any);
  const ids = [...r.suppliers.flatMap((s: any) => s.lines), ...r.unassigned].map((l: any) => l.variantId);
  const units = await soldByMap(ids);
  const line = (l: any) => {
    const u = units.get(l.variantId), f = factorOf(u?.soldBy);
    return { itemCode: u?.code ?? l.sku, name: l.productTitle, colour: l.colorName, size: l.size, unit: u?.soldBy ?? 'PIECE',
      inStock: l.currentStock / f, onOrder: l.onOrder / f, reorderLevel: (l.reorderLevel ?? 0) / f, suggested: l.suggestedQty / f,
      unitCost: round2(l.unitPrice * f), lineTotal: l.lineTotal, supplierSku: l.supplierSku, leadTimeDays: l.leadTimeDays,
      minOrderQty: l.minOrderQty != null ? l.minOrderQty / f : null, raisedToMinimum: !!l.raisedToMinimum };
  };
  return {
    store: r.location ? { id: r.location.id, name: r.location.name } : null,
    suppliers: r.suppliers.map((s: any) => ({ supplierId: s.supplier.id, supplierName: s.supplier.name, estimatedTotal: round2(s.estimatedTotal), lines: s.lines.map(line) })),
    noSupplier: r.unassigned.map(line),
    summary: r.summary
  };
}
/**
 * Draft purchase orders from chosen lines, one per supplier: { storeId?, groups: [{ supplierId, lines: [{ itemCode,
 * quantity, unitCost }] }] }. Made with the boutique's own purchase orders, which take metres (Inventory's count whole
 * pieces). All are checked before any is made, so a wrong line makes none.
 */
export async function reorderDrafts(a: Actor, body: any) {
  mustBuy(a);
  if (!Array.isArray(body?.groups) || !body.groups.length) throw problem('Send groups: one per supplier, each with its lines.');
  if (body.groups.length > 50) throw problem('At most 50 suppliers at once.');
  const locationId = body?.storeId ? await storeOf(a.clientId, body.storeId) : null;
  for (const g of body.groups) {
    await ownSupplier(a.clientId, String(g?.supplierId ?? ''));
    if (!Array.isArray(g?.lines) || !g.lines.length) throw problem('Each group needs its lines.');
    for (const l of g.lines) {
      const v = await variantOfCode(a.clientId, l?.itemCode);
      if (baseQty(l?.quantity, v.product.soldBy as any, `quantity of ${l?.itemCode}`) <= 0) throw problem(`${l?.itemCode}: the quantity must be above 0.`);
    }
  }
  const made = [];
  for (const g of body.groups) {
    made.push(await createOrder(a, { supplierId: g.supplierId, locationId, status: 'DRAFT', notes: g.notes ?? 'From reorder suggestions', lines: g.lines.map((l: any) => ({ itemCode: l.itemCode, quantity: l.quantity, unitCost: l.unitCost ?? 0 })) }));
  }
  return { created: made.length, orders: made };
}

/* ── an order's status, where it is delivered, emailing it ─────────────────────────────────────── */
export async function orderStatus(a: Actor, id: string, raw: unknown) {
  mustBuy(a); await ownOrder(a.clientId, id);
  const status = String(raw ?? '').toUpperCase();
  if (!['SENT', 'CANCELLED', 'DRAFT'].includes(status)) throw problem('status is SENT, CANCELLED or DRAFT. Receiving goods sets the rest.');
  await said(() => purchaseOrderService.updatePOStatus(a.clientId, id, status as any) as any);
  return prisma.purchaseOrder.findUnique({ where: { id }, select: { id: true, poNumber: true, status: true } });
}
export async function deliverTo(a: Actor, id: string, storeId: unknown) {
  mustBuy(a); await ownOrder(a.clientId, id);
  const locationId = await storeOf(a.clientId, storeId);
  await said(() => purchaseOrderService.setDeliverTo(a.clientId, id, locationId) as any);
  return prisma.purchaseOrder.findUnique({ where: { id }, select: { id: true, poNumber: true, locationId: true } });
}
/** Emails the order (its PDF) to the supplier's email address, signed with the person's name. */
export async function emailOrder(a: Actor, id: string) {
  mustBuy(a); await ownOrder(a.clientId, id);
  return said(() => purchaseOrderService.emailToSupplier(a.clientId, id, `${a.name} (Boutique)`) as any);
}

/* ── removing a supplier ───────────────────────────────────────────────────────────────────────── */
export async function removeSupplier(a: Actor, id: string) {
  mustBuy(a); await ownSupplier(a.clientId, id);
  await said(() => supplierService.deleteSupplier(a.clientId, id) as any,
    [[/historical purchase orders/i, 409, 'This supplier has purchase orders, so it is kept for their history. Switch it off instead (PUT /suppliers/{id} with active: false).']]);
  return { id, removed: true };
}
