import { prisma } from '../../lib/prisma';
import { badRequest } from '../../utils/httpError';
import { toMinor } from '../pricing/money';
import { paymentSummary } from '../payments/payment-rules';
import { ELIGIBLE_PRODUCT } from '../storefront-catalogue.service';
import { whyNotCollect } from '../order-payments';

/**
 * Reads for ScaleEzy CRM's features approved on 20 Nov 2026 (routes/internal-crm.routes.ts). Read only.
 *   - picks: pieces in stock at a store, optionally in a size, for "Send picks" (A3);
 *   - dues:  what customers still owe, for the money-owed reminders (C7).
 */

const UUID = /^[0-9a-f-]{36}$/i;

/** Pieces a salesperson can pick for a customer: for sale online, with a photo, in stock at the store (unless all=1). */
export async function picks(clientId: string, q: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(q.limit) || 60, 1), 60);
  const size = typeof q.size === 'string' && q.size.trim() ? q.size.trim().slice(0, 40) : null;
  const search = typeof q.q === 'string' && q.q.trim() ? q.q.trim().slice(0, 80) : null;
  const all = q.all === '1' || q.all === 'true';
  let locationId: string | null = null;
  if (typeof q.locationId === 'string' && q.locationId) {
    if (!UUID.test(q.locationId)) throw badRequest('locationId is not one of this shop\'s stores.');
    const loc = await prisma.stockLocation.findFirst({ where: { id: q.locationId, clientId }, select: { id: true } });
    if (!loc) throw badRequest('locationId is not one of this shop\'s stores.');
    locationId = loc.id;
  }

  const variants = await prisma.productVariant.findMany({
    where: {
      clientId,
      product: {
        ...ELIGIBLE_PRODUCT, clientId,
        ...(search ? { OR: [{ title: { contains: search, mode: 'insensitive' } }, { productCode: { contains: search, mode: 'insensitive' } }] } : {})
      },
      ...(size ? { size: { equals: size, mode: 'insensitive' } } : {})
    },
    select: {
      id: true, colorName: true, size: true, sellingPrice: true,
      product: { select: { id: true, productCode: true, title: true, dressType: true, basePrice: true, images: { where: { imageType: { not: 'RAW_UPLOAD' } }, orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }], select: { url: true, variantId: true }, take: 6 } } },
      stocks: { where: locationId ? { locationId } : {}, select: { quantity: true, reservedQty: true } }
    },
    orderBy: { updatedAt: 'desc' },
    take: 600
  });
  const out = [];
  for (const v of variants) {
    const free = v.stocks.reduce((a, s) => a + Math.max(0, s.quantity - s.reservedQty), 0);
    if (!all && free <= 0) continue;
    const photo = v.product.images.find(i => i.variantId === v.id)?.url ?? v.product.images[0]?.url ?? null;
    if (!photo) continue;
    out.push({
      variantId: v.id, productId: v.product.id, productCode: v.product.productCode, title: v.product.title,
      kind: v.product.dressType ?? null, colour: v.colorName ?? null, size: v.size ?? null,
      priceRupees: Number(v.sellingPrice ?? v.product.basePrice ?? 0), photoUrl: photo, inStock: free
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * What each customer still owes: bills with money due, oldest first. Each item says where it can be paid -- a till
 * bill's balance is taken on the till (the till must know), anything else can be collected through Inventory.
 */
export async function dues(clientId: string, rawIds: unknown) {
  const ids = [...new Set(String(rawIds ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length) throw badRequest('Say which customers: ids=<id>,<id> (up to 200).');
  if (ids.length > 200) throw badRequest('Ask for at most 200 customers at a time.');
  if (ids.some(id => !UUID.test(id))) throw badRequest('Every id must be a customer id from Inventory.');
  const orders = await prisma.salesOrder.findMany({
    where: { clientId, customerId: { in: ids }, deletedAt: null, status: { notIn: ['CANCELLED', 'DRAFT'] as any }, sourceSystem: { not: 'SHOPIFY' } },
    select: {
      id: true, orderNumber: true, customerId: true, createdAt: true, sourceSystem: true, status: true, deletedAt: true,
      total: true, roundOff: true, writtenOff: true, promisedAt: true, handedOverAt: true,
      payments: { select: { kind: true, amount: true } }
    },
    orderBy: { createdAt: 'asc' }
  });
  const byCustomer = new Map<string, { customerId: string; totalPaise: number; oldestDays: number; items: any[] }>();
  const now = Date.now();
  for (const o of orders) {
    const s = paymentSummary(toMinor(o.total as any) + toMinor((o.roundOff ?? 0) as any), o.payments, toMinor((o.writtenOff ?? 0) as any));
    const due = toMinor(s.due as any);
    if (due <= 0 || !o.customerId) continue;
    const kept = !!o.promisedAt && !o.handedOverAt;
    const payAt = o.sourceSystem === 'SCALEEZY_POS' ? 'till' : (whyNotCollect(o as any, due) ? 'shop' : 'online');
    const row = byCustomer.get(o.customerId) ?? { customerId: o.customerId, totalPaise: 0, oldestDays: 0, items: [] };
    row.totalPaise += due;
    row.oldestDays = Math.max(row.oldestDays, Math.floor((now - o.createdAt.getTime()) / 86_400_000));
    row.items.push({ orderId: o.id, orderNumber: o.orderNumber, kind: kept ? 'kept' : 'pay_later', amountPaise: due, date: o.createdAt, payAt });
    byCustomer.set(o.customerId, row);
  }
  return [...byCustomer.values()];
}
