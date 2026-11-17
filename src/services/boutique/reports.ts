/**
 * Reports for the boutique (CRM-B checklist section 9, 16 Nov 2026). CRM-B values stock as stock x the item's
 * purchase price; that is `value` here. ScaleEzy's own figure (weighted average cost, what the shop's Day Book and
 * Stock value pages use) is given beside it as `valueAtAverageCost`, so the two can be compared, never confused.
 *
 * Everything is in the item's unit (metres for cloth). Money totals add up across units; quantities never do, so
 * quantity totals are given per unit.
 *
 * The shop's Day Book (sales, buying, stock in and out per day) is the same one the owner sees: GET /reports/daybook.
 */
import { prisma } from '../../lib/prisma';
import { factorOf, type SoldBy } from '../../lib/units';
import { dayBookService } from '../daybook.service';
import { type Actor, problem, listItems, codeOf, wasDeleted } from './index';

export const mustReport = (a: Actor) => { if (!a.can.includes('reports:view')) throw problem('This person may not see reports.', 403); };
const r2 = (n: number) => Math.round(n * 100) / 100;
const USED = ['ISSUE', 'CONSUME', 'CONSUMPTION'];
const WASTED = ['WASTE'];
const DAMAGED = ['DAMAGE', 'SCRAP'];
const RECEIVED = ['PURCHASE', 'GOODS_RECEIPT', 'STOCK_IN', 'OPENING_STOCK'];
const RETURNED = ['RETURN_UNUSED', 'RETURN'];

function range(q: { from?: unknown; to?: unknown }) {
  const day = (v: unknown, what: string) => {
    if (v == null || v === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw problem(`${what} is a day like 2026-11-16.`);
    return String(v);
  };
  const from = day(q.from, 'from'), to = day(q.to, 'to');
  if (from && to && from > to) throw problem('from must not be after to.');
  return {
    from, to,
    where: (from || to) ? { createdAt: { ...(from ? { gte: new Date(`${from}T00:00:00+05:30`) } : {}), ...(to ? { lt: new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000) } : {}) } } : {}
  };
}

/** The boutique's colours with what each report needs: unit, purchase price per base unit, category, average-cost value. */
async function boutiqueVariants(clientId: string, ids?: string[]) {
  const rows = await prisma.productVariant.findMany({
    // Asked for by id (a report of the PAST: what was used, wasted, held for an order): a deleted item kept for its
    // records still answers, under the code it had. Asked for all (what is in stock NOW): deleted ones are left out.
    where: { clientId, boutiqueRef: { not: null }, ...(ids ? { id: { in: ids } } : { boutiqueDeletedAt: null }) },
    select: { id: true, boutiqueRef: true, colorName: true, costPrice: true, inventoryValue: true, reorderLevel: true, minStock: true, lastMovementAt: true,
      product: { select: { title: true, soldBy: true, boutiqueCategory: true, status: true, trashedAt: true } }, stocks: { select: { quantity: true, reservedQty: true } } }
  });
  return new Map(rows.map(v => [v.id, v]));
}

/** Per colour, per boutique kind of movement, the base quantity moved in the period. */
async function moved(clientId: string, where: object, kinds: string[]) {
  const rows = await prisma.inventoryTransaction.groupBy({
    by: ['variantId', 'boutiqueKind'], where: { clientId, boutiqueKind: { in: kinds }, ...where }, _sum: { quantity: true }, _count: { _all: true }
  });
  return rows;
}

/** 9.1 + 9.2: the stock position and its value, with out-of-stock, reorder-due, below-minimum and dead-stock counts. */
export async function stockSummary(actor: Actor, q: { deadDays?: unknown }) {
  mustReport(actor);
  const deadDays = Math.min(3650, Math.max(1, Number(q.deadDays) || 90));
  const deadBefore = Date.now() - deadDays * 86_400_000;
  // Not archived and not in the shop's bin -- the same items the lists, alerts and reorder count.
  const vs = [...(await boutiqueVariants(actor.clientId)).values()].filter(v => v.product.status !== 'ARCHIVED' && !v.product.trashedAt);
  const perUnit: Record<string, { onHand: number; held: number; available: number }> = {};
  let value = 0, avg = 0, out = 0, due = 0, belowMin = 0, dead = 0;
  for (const v of vs) {
    const f = factorOf(v.product.soldBy as SoldBy);
    const qty = v.stocks.reduce((n, s) => n + s.quantity, 0), held = v.stocks.reduce((n, s) => n + s.reservedQty, 0), free = qty - held;
    const u = (perUnit[v.product.soldBy] ??= { onHand: 0, held: 0, available: 0 });
    u.onHand += qty / f; u.held += held / f; u.available += free / f;
    value += qty * Number(v.costPrice ?? 0);
    avg += Number(v.inventoryValue ?? 0);
    if (free <= 0) out++;
    if (free <= (v.reorderLevel ?? 0)) due++;
    if (v.minStock != null && free < v.minStock) belowMin++;
    if (qty > 0 && (!v.lastMovementAt || v.lastMovementAt.getTime() < deadBefore)) dead++;
  }
  for (const u of Object.values(perUnit)) { u.onHand = r2(u.onHand); u.held = r2(u.held); u.available = r2(u.available); }
  return { items: vs.length, value: r2(value), valueAtAverageCost: r2(avg), outOfStock: out, reorderDue: due, belowMinimum: belowMin, deadStock: dead, deadDays, byUnit: perUnit };
}

/** 9.3: items at or below their reorder level, how much short, and their supplier. */
export async function lowStock(actor: Actor) {
  mustReport(actor);
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await listItems(actor, { reorderDue: '1', status: 'ACTIVE', limit: 100, page });
    for (const i of r.items as any[]) out.push({ itemCode: i.itemCode, name: i.name, colour: i.colour, unit: i.unit, free: i.free, reorderLevel: i.reorderLevel, shortBy: r2(Math.max(0, i.reorderLevel - i.free)), minStock: i.minStock, supplier: i.supplier });
    if (!r.hasMore) break;
  }
  return out;
}

/** 9.4: what was used per item in the period (issue, consume), quantity and value; category narrows it. */
export async function consumption(actor: Actor, q: { from?: unknown; to?: unknown; category?: unknown }) {
  mustReport(actor);
  const { from, to, where } = range(q);
  // Used minus what came back unused (RETURN_UNUSED): issued 5 m, 1 m returned = 4 m used.
  const rows = await moved(actor.clientId, where, [...USED, ...RETURNED]);
  const vs = await boutiqueVariants(actor.clientId, [...new Set(rows.map(r => r.variantId))]);
  const cats = q.category ? String(q.category).toUpperCase().split(',') : null;
  const per = new Map<string, { itemCode: string; name: string; colour: string | null; category: string | null; unit: string; quantity: number; value: number }>();
  for (const r of rows) {
    const v = vs.get(r.variantId); if (!v) continue;
    if (cats && !cats.includes(v.product.boutiqueCategory ?? '')) continue;
    const f = factorOf(v.product.soldBy as SoldBy), base = -(r._sum.quantity ?? 0);
    const e = per.get(v.id) ?? { itemCode: codeOf(v.boutiqueRef)!, ...(wasDeleted(v.boutiqueRef) ? { itemDeleted: true } : {}), name: v.product.title, colour: v.colorName, category: v.product.boutiqueCategory, unit: v.product.soldBy, quantity: 0, value: 0 };
    e.quantity += base / f; e.value += base * Number(v.costPrice ?? 0);
    per.set(v.id, e);
  }
  const items = [...per.values()].map(e => ({ ...e, quantity: r2(e.quantity), value: r2(e.value) })).sort((a, b) => b.value - a.value);
  return { from, to, items, totalValue: r2(items.reduce((n, i) => n + i.value, 0)) };
}

/** 9.5: waste % = waste / (used + waste); damage % = damaged / received -- per item and overall (by value). */
export async function lossRates(actor: Actor, q: { from?: unknown; to?: unknown }) {
  mustReport(actor);
  const { from, to, where } = range(q);
  const rows = await moved(actor.clientId, where, [...USED, ...WASTED, ...DAMAGED, ...RECEIVED]);
  // Goods received against a purchase order come in through the shop's own receiving, not as a boutique movement.
  const receipts = await prisma.inventoryTransaction.groupBy({
    by: ['variantId'], where: { clientId: actor.clientId, boutiqueKind: null, reason: { in: ['PURCHASE_RECEIPT', 'SUPPLIER_DELIVERY'] }, variant: { boutiqueRef: { not: null } }, ...where }, _sum: { quantity: true }
  });
  for (const r of receipts) rows.push({ variantId: r.variantId, boutiqueKind: 'GOODS_RECEIPT', _sum: { quantity: r._sum.quantity }, _count: { _all: 1 } } as any);
  const vs = await boutiqueVariants(actor.clientId, [...new Set(rows.map(r => r.variantId))]);
  const per = new Map<string, { used: number; waste: number; damaged: number; received: number }>();
  for (const r of rows) {
    const e = per.get(r.variantId) ?? { used: 0, waste: 0, damaged: 0, received: 0 };
    const q2 = Math.abs(r._sum.quantity ?? 0), k = r.boutiqueKind ?? '';
    if (USED.includes(k)) e.used += q2; else if (WASTED.includes(k)) e.waste += q2; else if (DAMAGED.includes(k)) e.damaged += q2; else e.received += q2;
    per.set(r.variantId, e);
  }
  const pct = (a: number, b: number) => (b ? r2((a / b) * 100) : null);
  let tu = 0, tw = 0, td = 0, tr = 0;
  const items = [];
  for (const [id, e] of per) {
    const v = vs.get(id); if (!v) continue;
    const f = factorOf(v.product.soldBy as SoldBy), c = Number(v.costPrice ?? 0);
    tu += e.used * c; tw += e.waste * c; td += e.damaged * c; tr += e.received * c;
    items.push({ itemCode: codeOf(v.boutiqueRef), ...(wasDeleted(v.boutiqueRef) ? { itemDeleted: true } : {}), name: v.product.title, unit: v.product.soldBy, used: r2(e.used / f), waste: r2(e.waste / f), damaged: r2(e.damaged / f), received: r2(e.received / f),
      wastePercent: pct(e.waste, e.used + e.waste), damagePercent: pct(e.damaged, e.received) });
  }
  return { from, to, items, overall: { wastePercent: pct(tw, tu + tw), damagePercent: pct(td, tr), basis: 'value at purchase price' } };
}

/** 9.6: per order: cloth used x price, waste x price, and the total. */
export async function costPerOrder(actor: Actor, q: { from?: unknown; to?: unknown; orderRef?: unknown }) {
  mustReport(actor);
  const { from, to, where } = range(q);
  const rows = await prisma.inventoryTransaction.findMany({
    where: { clientId: actor.clientId, boutiqueKind: { in: [...USED, ...WASTED, ...RETURNED] }, boutiqueOrderRef: q.orderRef ? String(q.orderRef) : { not: null }, ...where },
    select: { variantId: true, boutiqueKind: true, boutiqueOrderRef: true, quantity: true }
  });
  const vs = await boutiqueVariants(actor.clientId, [...new Set(rows.map(r => r.variantId))]);
  const per = new Map<string, { orderRef: string; usedValue: number; wasteValue: number }>();
  for (const r of rows) {
    const e = per.get(r.boutiqueOrderRef!) ?? { orderRef: r.boutiqueOrderRef!, usedValue: 0, wasteValue: 0 };
    const v = Math.abs(r.quantity) * Number(vs.get(r.variantId)?.costPrice ?? 0);
    if (WASTED.includes(r.boutiqueKind ?? '')) e.wasteValue += v; else if (RETURNED.includes(r.boutiqueKind ?? '')) e.usedValue -= v; else e.usedValue += v;
    per.set(e.orderRef, e);
  }
  const orders = [...per.values()].map(e => ({ orderRef: e.orderRef, usedValue: r2(e.usedValue), wasteValue: r2(e.wasteValue), total: r2(e.usedValue + e.wasteValue) })).sort((a, b) => b.total - a.total);
  return { from, to, orders, total: r2(orders.reduce((n, o) => n + o.total, 0)) };
}

/** 9.7: one order, every item: held now, used, wasted, returned unused, and the cost. */
export async function orderUsage(actor: Actor, orderRef: string) {
  mustReport(actor);
  if (!orderRef) throw problem('Say which order.');
  const [rows, holds] = await Promise.all([
    prisma.inventoryTransaction.groupBy({ by: ['variantId', 'boutiqueKind'], where: { clientId: actor.clientId, boutiqueOrderRef: orderRef }, _sum: { quantity: true } }),
    prisma.boutiqueReservation.groupBy({ by: ['variantId'], where: { clientId: actor.clientId, orderRef, status: 'ACTIVE' }, _sum: { quantity: true } })
  ]);
  const ids = [...new Set([...rows.map(r => r.variantId), ...holds.map(h => h.variantId)])];
  const vs = await boutiqueVariants(actor.clientId, ids);
  const lines = ids.map(id => {
    const v = vs.get(id)!, f = factorOf(v.product.soldBy as SoldBy), c = Number(v.costPrice ?? 0);
    const sum = (ks: string[]) => Math.abs(rows.filter(r => r.variantId === id && ks.includes(r.boutiqueKind ?? '')).reduce((n, r) => n + (r._sum.quantity ?? 0), 0));
    const used = sum(USED), waste = sum(WASTED), returned = sum(RETURNED), held = holds.find(h => h.variantId === id)?._sum.quantity ?? 0;
    return { itemCode: codeOf(v.boutiqueRef), ...(wasDeleted(v.boutiqueRef) ? { itemDeleted: true } : {}), name: v.product.title, colour: v.colorName, unit: v.product.soldBy, heldNow: held / f, used: used / f, wasted: waste / f, returned: returned / f, netUsed: Math.max(0, used - returned) / f, cost: r2((Math.max(0, used - returned) + waste) * c) };
  });
  return { orderRef, lines, totalCost: r2(lines.reduce((n, l) => n + l.cost, 0)) };
}

/** 9.8: per kind of movement in the period: how many and how much (per unit). */
export async function movementSummary(actor: Actor, q: { from?: unknown; to?: unknown }) {
  mustReport(actor);
  const { from, to, where } = range(q);
  const rows = await prisma.inventoryTransaction.findMany({
    where: { clientId: actor.clientId, variant: { boutiqueRef: { not: null } }, ...where },
    select: { boutiqueKind: true, reason: true, quantity: true, variant: { select: { product: { select: { soldBy: true } } } } }
  });
  const per = new Map<string, { kind: string; count: number; byUnit: Record<string, number> }>();
  for (const r of rows) {
    const kind = r.boutiqueKind ?? r.reason;
    const e = per.get(kind) ?? { kind, count: 0, byUnit: {} };
    const u = r.variant.product.soldBy;
    e.count++; e.byUnit[u] = r2((e.byUnit[u] ?? 0) + r.quantity / factorOf(u as SoldBy));
    per.set(kind, e);
  }
  return { from, to, kinds: [...per.values()].sort((a, b) => b.count - a.count) };
}

/** The shop's Day Book over a range (days in the shop's own time): the same book the owner sees in ScaleEzy. */
export async function daybook(actor: Actor, q: { from?: unknown; to?: unknown; locationId?: unknown }) {
  mustReport(actor);
  const { from, to } = range(q);
  if (!from || !to) throw problem('Give from and to, days like 2026-11-16.');
  return dayBookService.getRange(actor.clientId, from, to, q.locationId ? String(q.locationId) : undefined);
}
