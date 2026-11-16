/**
 * Suppliers and purchase orders for the boutique (CRM-B checklist section 4, 16 Nov 2026), on ScaleEzy's own
 * supplier and purchase-order records -- the same ones the shop's Suppliers and Purchase Orders screens show, so a
 * boutique that later joins ScaleEzy finds them there. Quantities and prices are in the item's unit (12.5 m at
 * 280 a metre); they are stored in base units (1250 cm at 2.80 a centimetre), as every purchase order is, which
 * is why the boutique may order cloth by the metre here while the retail screen still asks for whole pieces.
 *
 * Statuses in CRM-B's words: DRAFT, ORDERED, PARTLY_RECEIVED, RECEIVED, CANCELLED (ours: SENT for ORDERED).
 */
import { Prisma, PurchaseOrderStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { factorOf, formatQty, type SoldBy } from '../../lib/units';
import { generateSequentialCode } from '../../utils/codeGenerator';
import { purchaseOrderService } from '../purchase-order.service';
import { type Actor, type Db, problem, baseQty, variantOf, storeOf } from './index';

const mustSupply = (a: Actor) => { if (!a.can.includes('suppliers:write')) throw problem('This person may not change suppliers or purchase orders.', 403); };
const wholeAtLeast1 = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? n : null; };
const text = (v: unknown, max: number) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);

/* ── suppliers ──────────────────────────────────────────────────────────────────────────────────── */

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function supplierFields(input: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!name) throw problem('Give the supplier a name.');
    out.name = name;
  }
  if (input.gstin !== undefined) {
    const g = text(input.gstin, 15)?.toUpperCase() ?? null;
    if (g && !GSTIN.test(g)) throw problem('A GSTIN is 15 characters, like 36AABCU9603R1ZM.');
    out.gstin = g;
  }
  if (input.email !== undefined) {
    const e = text(input.email, 200);
    if (e && !EMAIL.test(e)) throw problem('That email address is not one.');
    out.email = e;
  }
  if (input.phone !== undefined) out.phone = text(input.phone, 30);
  if (input.address !== undefined) out.address = text(input.address, 500);
  if (input.contactPerson !== undefined) out.contactPerson = text(input.contactPerson, 120);
  if (input.notes !== undefined) out.notes = text(input.notes, 2000);
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw problem('active is true or false.');
    out.isActive = input.active;
  }
  return out;
}

const supplierView = (s: any) => ({
  id: s.id, code: s.supplierCode, name: s.name, contactPerson: s.contactPerson ?? null, phone: s.phone ?? null, email: s.email ?? null,
  address: s.address ?? null, gstin: s.gstin ?? null, notes: s.notes ?? null, active: s.isActive
});

async function refuseTakenName(tx: Db, clientId: string, name: string, notId?: string) {
  const same = await tx.supplier.findFirst({ where: { clientId, name: { equals: name, mode: 'insensitive' }, ...(notId ? { id: { not: notId } } : {}) } });
  if (same) throw problem(`${same.name} is already a supplier (${same.supplierCode}).`, 409);
}

export async function addSupplier(tx: Db, actor: Actor, input: any) {
  mustSupply(actor);
  const data = supplierFields(input, false);
  await refuseTakenName(tx, actor.clientId, data.name as string);
  const supplierCode = await generateSequentialCode(actor.clientId, 'SUP', 'SUPPLIER', tx as any);
  const s = await tx.supplier.create({ data: { clientId: actor.clientId, supplierCode, ...(data as any) } });
  return { status: 201, answer: { success: true, data: supplierView(s) } };
}

export async function changeSupplier(tx: Db, actor: Actor, id: string, input: any) {
  mustSupply(actor);
  const s = await tx.supplier.findFirst({ where: { id, clientId: actor.clientId } });
  if (!s) throw problem('That supplier is not in this shop.', 404);
  const data = supplierFields(input, true);
  if (!Object.keys(data).length) throw problem('Nothing to change.');
  if (data.name) await refuseTakenName(tx, actor.clientId, data.name as string, id);
  const u = await tx.supplier.update({ where: { id }, data: data as any });
  return { status: 200, answer: { success: true, data: supplierView(u) } };
}

export async function listSuppliers(actor: Actor, q: Record<string, unknown>) {
  const limit = Math.min(100, wholeAtLeast1(q.limit) ?? 20), page = wholeAtLeast1(q.page) ?? 1;
  const search = String(q.search ?? '').trim().slice(0, 100);
  const where: Prisma.SupplierWhereInput = {
    clientId: actor.clientId,
    ...(q.active === 'false' ? { isActive: false } : q.all === '1' || q.all === 'true' ? {} : { isActive: true }),
    ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { supplierCode: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }] } : {})
  };
  const [rows, total] = await Promise.all([
    prisma.supplier.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
    prisma.supplier.count({ where })
  ]);
  const totalPages = Math.ceil(total / limit);
  return { suppliers: rows.map(supplierView), page, limit, total, totalPages, hasMore: page < totalPages };
}

/** Per supplier: orders placed, received, received on time (by the expected date), cancelled, and the on-time share. */
export async function supplierPerformance(actor: Actor, supplierId?: string) {
  const rows = await prisma.purchaseOrder.findMany({
    where: { clientId: actor.clientId, ...(supplierId ? { supplierId } : {}) },
    select: { supplierId: true, status: true, expectedDeliveryDate: true, receivedAt: true, supplier: { select: { name: true } } }
  });
  const by = new Map<string, { supplierId: string; name: string; ordered: number; received: number; onTime: number; cancelled: number }>();
  for (const r of rows) {
    const s = by.get(r.supplierId) ?? { supplierId: r.supplierId, name: r.supplier.name, ordered: 0, received: 0, onTime: 0, cancelled: 0 };
    if (r.status !== 'DRAFT' && r.status !== 'CANCELLED') s.ordered++;
    if (r.status === 'CANCELLED') s.cancelled++;
    if (r.status === 'RECEIVED') {
      s.received++;
      // On time: received by the end of the expected day. No expected date counts as on time.
      if (!r.expectedDeliveryDate || (r.receivedAt && r.receivedAt.getTime() < r.expectedDeliveryDate.getTime() + 86_400_000)) s.onTime++;
    }
    by.set(r.supplierId, s);
  }
  return [...by.values()].map(s => ({ ...s, onTimePercent: s.received ? Math.round((s.onTime / s.received) * 1000) / 10 : null }));
}

/** The item's supplier (CRM-B: one per item): this supplier is preferred for this colour, any other preferred one is not. */
export async function setItemSupplier(tx: Db, actor: Actor, itemCode: string, supplierId: unknown) {
  const v = await variantOf(actor.clientId, itemCode, tx);
  if (supplierId === null || supplierId === '') {
    await tx.supplierProduct.updateMany({ where: { variantId: v.id, clientId: actor.clientId }, data: { isPreferred: false } });
    return;
  }
  const s = await tx.supplier.findFirst({ where: { id: String(supplierId), clientId: actor.clientId } });
  if (!s) throw problem(`${itemCode}: that supplier is not in this shop.`, 404);
  await tx.supplierProduct.updateMany({ where: { variantId: v.id, clientId: actor.clientId, supplierId: { not: s.id } }, data: { isPreferred: false } });
  await tx.supplierProduct.upsert({
    where: { uq_supplier_variant: { supplierId: s.id, variantId: v.id } },
    create: { clientId: actor.clientId, supplierId: s.id, variantId: v.id, isPreferred: true, notes: 'Set by the boutique.' },
    update: { isPreferred: true }
  });
}

/* ── purchase orders ────────────────────────────────────────────────────────────────────────────── */

const TO_OURS: Record<string, PurchaseOrderStatus> = { DRAFT: 'DRAFT', ORDERED: 'SENT', SENT: 'SENT', CANCELLED: 'CANCELLED' };
const THEIRS: Record<string, string> = { DRAFT: 'DRAFT', SENT: 'ORDERED', PARTIALLY_RECEIVED: 'PARTLY_RECEIVED', RECEIVED: 'RECEIVED', CANCELLED: 'CANCELLED' };
const PAYMENT = ['UNPAID', 'PARTIAL', 'PAID'];

function money(v: unknown, what: string) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || Math.round(n * 100) !== n * 100) throw problem(`${what} is rupees, to 2 decimals.`);
  return n;
}
function paymentOf(v: unknown) {
  if (v == null || v === '') return null;
  const p = String(v).trim().toUpperCase();
  if (!PAYMENT.includes(p)) throw problem('The payment status is UNPAID, PARTIAL or PAID.');
  return p;
}
const dayOf = (v: unknown) => {
  if (v == null || v === '') return undefined;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw problem('The expected date is not a date (use 2026-11-30).');
  return d;
};

async function poView(id: string, clientId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id, clientId },
    include: { supplier: { select: { id: true, name: true } }, location: { select: { id: true, name: true } }, items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { variant: { select: { boutiqueRef: true, product: { select: { soldBy: true } } } } } } }
  });
  if (!po) throw problem('That purchase order is not in this shop.', 404);
  const lines = po.items.map(i => {
    const soldBy = (i.variant.product.soldBy ?? 'PIECE') as SoldBy;
    const f = factorOf(soldBy);
    return {
      lineId: i.id, itemCode: i.variant.boutiqueRef, name: i.productTitle, colour: i.color, unit: soldBy,
      quantity: i.orderedQty / f, received: i.receivedQty / f, outstanding: Math.max(0, i.orderedQty - i.receivedQty) / f,
      unitCost: Math.round(Number(i.unitPrice) * f * 100) / 100, batchNumber: i.batchNumber ?? null,
      lineTotal: Math.round(i.orderedQty * Number(i.unitPrice) * 100) / 100
    };
  });
  const sub = Number(po.totalAmount ?? 0), tax = Number(po.taxAmount ?? 0);
  return {
    id: po.id, poNumber: po.poNumber, status: THEIRS[po.status] ?? po.status, supplier: po.supplier, deliverTo: po.location,
    expectedDate: po.expectedDeliveryDate, receivedAt: po.receivedAt, invoiceNumber: po.invoiceNumber ?? null, paymentStatus: po.paymentStatus ?? 'UNPAID',
    notes: po.notes ?? null, subtotal: sub, tax, total: Math.round((sub + tax) * 100) / 100, orderedAt: po.createdAt, lines
  };
}

/**
 * Raise a purchase order (DRAFT, or ORDERED at once). Lines in the item's unit and price per unit. Runs on the shop's
 * own purchase-order code, in its own transaction; the boutique's request id still makes a retry answer the same.
 */
export async function createOrder(actor: Actor, input: any) {
  mustSupply(actor);
  if (!Array.isArray(input.lines) || !input.lines.length) throw problem('Send lines: a list of { itemCode, quantity, unitCost }.');
  if (input.lines.length > 200) throw problem('At most 200 lines on one order.');
  const status = String(input.status ?? 'DRAFT').toUpperCase();
  if (!['DRAFT', 'ORDERED'].includes(status)) throw problem('A new order is DRAFT or ORDERED.');
  const tax = money(input.tax, 'The tax'), payment = paymentOf(input.paymentStatus);
  const items: { variantId: string; orderedQty: number; unitPrice: number }[] = [];
  const batches: (string | null)[] = [];
  for (const [i, l] of (input.lines as any[]).entries()) {
    const v = await variantOf(actor.clientId, l?.itemCode).catch(e => { throw problem(`Line ${i + 1}: ${e.message}`, e.statusCode); });
    const soldBy = v.product.soldBy as SoldBy;
    const qty = baseQty(l?.quantity, soldBy);
    if (qty <= 0) throw problem(`Line ${i + 1}: the quantity must be more than 0.`);
    const cost = money(l?.unitCost, `Line ${i + 1}: the cost`) ?? 0;
    const f = factorOf(soldBy);
    // Per base unit: 280 a metre is 2.80 a centimetre, exact to the paisa for any whole-rupee or paise price per metre.
    const perBase = Math.round((cost / f) * 1e6) / 1e6;
    items.push({ variantId: v.id, orderedQty: qty, unitPrice: perBase });
    batches.push(text(l?.batchNumber, 60));
  }
  const supplier = await prisma.supplier.findFirst({ where: { id: String(input.supplierId ?? ''), clientId: actor.clientId } });
  if (!supplier) throw problem('That supplier is not in this shop.', 404);
  const locationId = input.locationId ? await storeOf(actor.clientId, input.locationId) : null;
  const po = await purchaseOrderService.createPO(actor.clientId, {
    supplierId: supplier.id, locationId, expectedDeliveryDate: dayOf(input.expectedDate), notes: text(input.notes, 2000) ?? undefined, items
  }, undefined, { allowMeasured: true });
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { invoiceNumber: text(input.invoiceNumber, 60), taxAmount: tax, paymentStatus: payment ?? 'UNPAID' } });
  for (const [i, line] of po.items.entries()) if (batches[i]) await prisma.purchaseOrderItem.update({ where: { id: line.id }, data: { batchNumber: batches[i] } });
  if (status === 'ORDERED') await purchaseOrderService.updatePOStatus(actor.clientId, po.id, 'SENT');
  return poView(po.id, actor.clientId);
}

/** Change an order's status (ORDERED, CANCELLED), invoice number, tax, payment status, notes or expected date. */
export async function changeOrder(actor: Actor, id: string, input: any) {
  mustSupply(actor);
  const po = await prisma.purchaseOrder.findFirst({ where: { id, clientId: actor.clientId } });
  if (!po) throw problem('That purchase order is not in this shop.', 404);
  const data: Prisma.PurchaseOrderUpdateInput = {};
  if (input.invoiceNumber !== undefined) data.invoiceNumber = text(input.invoiceNumber, 60);
  if (input.tax !== undefined) data.taxAmount = money(input.tax, 'The tax');
  if (input.paymentStatus !== undefined) data.paymentStatus = paymentOf(input.paymentStatus) ?? 'UNPAID';
  if (input.notes !== undefined) data.notes = text(input.notes, 2000);
  if (input.expectedDate !== undefined) data.expectedDeliveryDate = dayOf(input.expectedDate) ?? null;
  if (Object.keys(data).length) await prisma.purchaseOrder.update({ where: { id }, data });
  if (input.status !== undefined) {
    const to = TO_OURS[String(input.status).toUpperCase()];
    if (!to || to === 'DRAFT') throw problem('An order can be set to ORDERED or CANCELLED. Receiving sets PARTLY_RECEIVED and RECEIVED.');
    await purchaseOrderService.updatePOStatus(actor.clientId, id, to);
  }
  return poView(id, actor.clientId);
}

/**
 * Goods arrived against the order: per line, up to what is still outstanding, all lines or none. Stock goes to the
 * place named, else the order's place, else the shop's default. The request id makes a retried receipt land once.
 */
export async function receiveOrder(actor: Actor, id: string, input: any, requestKey: string) {
  if (!actor.can.includes('suppliers:write') && !actor.can.includes('stock:write')) throw problem('This person may not receive goods.', 403);
  const po = await prisma.purchaseOrder.findFirst({ where: { id, clientId: actor.clientId }, include: { items: { include: { variant: { select: { boutiqueRef: true, product: { select: { soldBy: true, title: true } } } } } } } });
  if (!po) throw problem('That purchase order is not in this shop.', 404);
  if (!Array.isArray(input.lines) || !input.lines.length) throw problem('Send lines: a list of { lineId or itemCode, quantity }.');
  const receipts = [];
  for (const [i, l] of (input.lines as any[]).entries()) {
    const line = po.items.find(x => (l?.lineId && x.id === l.lineId) || (!l?.lineId && l?.itemCode && x.variant.boutiqueRef === l.itemCode));
    if (!line) throw problem(`Line ${i + 1}: that item is not on this order.`, 404);
    const soldBy = line.variant.product.soldBy as SoldBy;
    const q = baseQty(l?.quantity, soldBy);
    if (q <= 0) throw problem(`Line ${i + 1}: the quantity must be more than 0.`);
    const left = line.orderedQty - line.receivedQty;
    if (q > left) throw problem(`Line ${i + 1}: only ${formatQty(Math.max(0, left), soldBy)} of ${line.variant.product.title} is still to come. Nothing was received.`, 409);
    receipts.push({ poItemId: line.id, quantityReceived: q });
  }
  const locationId = input.locationId ? await storeOf(actor.clientId, input.locationId) : null;
  await purchaseOrderService.receiveGoods(actor.clientId, id, {
    receipts, locationId, receivedByName: actor.name, supplierReference: text(input.invoiceNumber, 60), notes: text(input.notes, 500), requestKey: `boutique:${requestKey}`
  }, { name: actor.name });
  if (input.invoiceNumber) await prisma.purchaseOrder.update({ where: { id }, data: { invoiceNumber: text(input.invoiceNumber, 60) } });
  return poView(id, actor.clientId);
}

export async function listOrders(actor: Actor, q: Record<string, unknown>) {
  const limit = Math.min(100, wholeAtLeast1(q.limit) ?? 20), page = wholeAtLeast1(q.page) ?? 1;
  const st = q.status ? String(q.status).toUpperCase() : null;
  const ours = st ? ({ DRAFT: 'DRAFT', ORDERED: 'SENT', PARTLY_RECEIVED: 'PARTIALLY_RECEIVED', RECEIVED: 'RECEIVED', CANCELLED: 'CANCELLED' } as Record<string, string>)[st] : null;
  if (st && !ours) throw problem('status is DRAFT, ORDERED, PARTLY_RECEIVED, RECEIVED or CANCELLED.');
  const where: Prisma.PurchaseOrderWhereInput = {
    clientId: actor.clientId, ...(ours ? { status: ours as any } : {}), ...(q.supplierId ? { supplierId: String(q.supplierId) } : {}),
    ...(q.search ? { OR: [{ poNumber: { contains: String(q.search), mode: 'insensitive' } }, { invoiceNumber: { contains: String(q.search), mode: 'insensitive' } }] } : {})
  };
  const [rows, total] = await Promise.all([
    prisma.purchaseOrder.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit, select: { id: true } }),
    prisma.purchaseOrder.count({ where })
  ]);
  const totalPages = Math.ceil(total / limit);
  return { orders: await Promise.all(rows.map(r => poView(r.id, actor.clientId))), page, limit, total, totalPages, hasMore: page < totalPages };
}

export const getOrder = (actor: Actor, id: string) => poView(id, actor.clientId);

/** Committed buying (ordered, partly received, received) by order date: CRM-B's "inventory cost" for Profit & Costs. */
export async function purchaseSpend(actor: Actor, q: { from?: unknown; to?: unknown }) {
  const from = q.from ? dayOf(q.from) : undefined, to = q.to ? dayOf(q.to) : undefined;
  const rows = await prisma.purchaseOrder.findMany({
    where: { clientId: actor.clientId, status: { in: ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'] }, ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) } } : {}) },
    select: { totalAmount: true, taxAmount: true, createdAt: true }
  });
  const byDay = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const t = Number(r.totalAmount ?? 0) + Number(r.taxAmount ?? 0);
    total += t;
    const d = r.createdAt.toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + t);
  }
  return { total: Math.round(total * 100) / 100, orders: rows.length, byDay: [...byDay.entries()].sort().map(([day, amount]) => ({ day, amount: Math.round(amount * 100) / 100 })) };
}
