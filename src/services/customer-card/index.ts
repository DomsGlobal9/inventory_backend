/**
 * The Customer card: a salesperson types the number at the door and sees who this is and what to
 * show them, before the customer reaches the first rack.
 *
 * Everything is worked out from bills the shop already has -- plain counting, no guessing: the size
 * they buy for each kind of garment, the colours and garments they come back for, what a bill of
 * theirs usually comes to, and what in THIS store today is in their size. Staff notes go in the
 * customer's own notes field, one dated line each, so the customer page shows them too.
 */
import { Prisma, ReturnStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { badRequest, notFound } from '../../utils/httpError';
import { groupNamesOf } from '../customer-groups';
import { colourFamily } from './colours';

// shortcut: a hard ceiling so one bad record can never make the card slow; nobody has 5,000 bills yet.
const MAX_BILLS = 5000;
/** The shared rows for bills with no customer details (pos-events WALK_IN_KEY, Shopify guest). */
const SHARED_CUSTOMERS = ['POS:WALK-IN', 'shopify:guest'];
// NOT IN alone would also drop every ordinary customer, whose external id is empty.
const notShared = { OR: [{ externalCustomerId: null }, { externalCustomerId: { notIn: SHARED_CUSTOMERS } }] };
const PICKS = 6;
const MAX_NOTE = 300;
const BACK_IN_SHOP: ReturnStatus[] = ['RECEIVED', 'INSPECTED', 'COMPLETED'];
/** Up to a quarter over their usual top still counts as their budget. */
const BUDGET_STRETCH = 1.25;
const RECENT_SPEND_MS = 2 * 365 * 86_400_000;
/** A purchase counts half as much for every year since: last month's size beats one from three years ago. */
export const weight = (at: Date, now = Date.now()) => 0.5 ** (Math.max(0, now - at.getTime()) / (365 * 86_400_000));

/** Most common first, ties by name so the card does not reshuffle between looks. */
function top(counts: Map<string, number>, n: number): string[] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
}
/** "Free", "Free Size" and "freesize" are one size; "M" and "m" too. */
export const sizeKey = (s: string | null | undefined) => { const k = String(s ?? '').toLowerCase().replace(/[\s_-]+/g, ''); return k === 'freesize' || k === 'onesize' ? 'free' : k; };
const bump = (m: Map<string, number>, k: string | null | undefined, by = 1) => { const v = k?.trim(); if (v) m.set(v, (m.get(v) ?? 0) + by); };

/** What a bill of theirs usually comes to: the middle half of their bills, or the one bill. Rupees. */
export function spendBand(totals: number[]): { from: number; to: number } | null {
  const t = totals.filter(x => x > 0).sort((a, b) => a - b);
  if (!t.length) return null;
  const at = (q: number) => t[Math.min(t.length - 1, Math.floor(q * (t.length - 1)))];
  const r = (x: number) => Math.round(x / 100) * 100;     // "₹4,000 – 8,000", not "₹3,987 – 8,123"
  return { from: r(at(0.25)), to: r(at(0.75)) };
}

export const customerCard = {
  async lookup(clientId: string, rawPhone: unknown, locationId?: string) {
    const phone = normalisePhone(rawPhone);
    if (!phone.ok) throw badRequest(phone.reason);
    const select = { id: true, name: true, customerCode: true, phone: true, email: true, notes: true, tags: true, loyaltyPoints: true, storeCreditPaise: true, birthday: true, anniversary: true } as const;
    let customer = await prisma.customer.findFirst({ where: { clientId, phone: phone.value, deletedAt: null }, orderBy: { createdAt: 'asc' }, select });
    // Bought online and never proved the number: the order carries it, the customer row does not
    // (on purpose -- see phoneForOutsideCustomer). They are still that person's purchases.
    if (!customer) {
      const online = await prisma.salesOrder.findFirst({
        where: { clientId, customerPhone: phone.value, deletedAt: null, customer: { deletedAt: null, ...notShared } },
        orderBy: { createdAt: 'desc' }, select: { customerId: true }
      });
      if (online) customer = await prisma.customer.findUnique({ where: { id: online.customerId }, select });
    }
    if (!customer) return { phone: phone.value, customer: null };

    /*
     * Everything this person bought, at the till AND online: their own record, any order where this
     * number was typed at checkout (an online order the shop kept on a separate record because the
     * number was not proved), and a Shopify record with the same email. All of it -- but what came
     * back does not count, and recent buying counts for more than old (see `weight`).
     */
    const same: Prisma.SalesOrderWhereInput[] = [{ customerId: customer.id }, { customerPhone: phone.value }];
    if (customer.email) same.push({ customer: { email: { equals: customer.email, mode: 'insensitive' }, ...notShared } });
    const orders = await prisma.salesOrder.findMany({
      where: { clientId, status: { not: 'CANCELLED' }, deletedAt: null, OR: same },
      orderBy: { createdAt: 'desc' }, take: MAX_BILLS,
      select: {
        createdAt: true, total: true, channel: true,
        items: { select: { id: true, quantity: true, variantId: true, variant: { select: { size: true, colorName: true, product: { select: { id: true, title: true, dressType: true } } } } } },
        // Goods actually back in the shop; a return only asked for, or turned down, changes nothing.
        returns: { where: { status: { in: BACK_IN_SHOP } }, select: { refundTotal: true, items: { select: { quantity: true, salesOrderItemId: true, dispatchItem: { select: { salesOrderItemId: true } } } } } }
      }
    });

    // Size per kind of garment: a "M" kurti and a "Free Size" saree are both true at once.
    const sizesByKind = new Map<string, Map<string, number>>();
    const colours = new Map<string, number>(), kinds = new Map<string, number>();
    const bought = new Set<string>(), boughtProducts = new Set<string>();
    const now = Date.now();
    for (const o of orders) {
      const back = new Map<string, number>();
      for (const r of o.returns) for (const ri of r.items) bump(back, ri.salesOrderItemId ?? ri.dispatchItem.salesOrderItemId, ri.quantity);
      const w = weight(o.createdAt, now);
      for (const it of o.items) {
        // Never offered again, kept or not; but a returned piece says nothing about their size or taste.
        bought.add(it.variantId); boughtProducts.add(it.variant.product.id);
        const kept = Math.max(0, it.quantity - (back.get(it.id) ?? 0));
        if (!kept) continue;
        const kind = it.variant.product.dressType?.trim() || 'Other';
        bump(kinds, kind, kept * w);
        bump(colours, colourFamily(it.variant.colorName), kept * w);
        if (!sizesByKind.has(kind)) sizesByKind.set(kind, new Map());
        bump(sizesByKind.get(kind)!, it.variant.size, kept * w);
      }
    }
    // What a bill usually comes to, after anything given back; the last two years when there are enough of those bills.
    const kept = orders.map(o => ({ at: o.createdAt.getTime(), paid: Number(o.total) - o.returns.reduce((t, r) => t + Number(r.refundTotal), 0) }));
    const lately = kept.filter(b => now - b.at <= RECENT_SPEND_MS && b.paid > 0);
    const spend = spendBand((lately.length >= 3 ? lately : kept).map(b => b.paid));
    const topKinds = top(kinds, 3);
    const sizes = topKinds.map(kind => ({ kind, size: top(sizesByKind.get(kind) ?? new Map(), 1)[0] ?? null })).filter(s => s.size);
    const topColours = top(colours, 3);

    return {
      phone: phone.value,
      customer: {
        id: customer.id, name: customer.name, customerCode: customer.customerCode,
        groups: await groupNamesOf(clientId, customer.tags),
        loyaltyPoints: customer.loyaltyPoints, storeCreditPaise: customer.storeCreditPaise,
        birthday: customer.birthday, anniversary: customer.anniversary,
        notes: (customer.notes ?? '').split('\n').map(l => l.trim()).filter(Boolean).slice(-5).reverse()
      },
      visits: {
        bills: orders.length, lastVisit: orders[0]?.createdAt ?? null,
        // Till and counter-made orders are the shop floor; the online shop and marketplaces are online.
        inStore: orders.filter(o => o.channel === 'POS' || o.channel === 'MANUAL').length,
        online: orders.filter(o => o.channel === 'ONLINE' || o.channel === 'MARKETPLACE').length
      },
      dna: { sizes, colours: topColours, kinds: topKinds, spend },
      picks: locationId ? await picksFor(clientId, locationId, { sizes, colours: topColours, kinds: topKinds, bought, boughtProducts, spend }) : []
    };
  },

  /** One dated line on the customer's notes, newest last, with who wrote it. */
  async addNote(clientId: string, customerId: string, text: unknown, userId: string | null) {
    const by = userId ? (await prisma.user.findFirst({ where: { id: userId, clientId }, select: { name: true } }))?.name ?? null : null;
    const note = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!note) throw badRequest('Write the note first.');
    if (note.length > MAX_NOTE) throw badRequest(`Keep a note under ${MAX_NOTE} characters.`);
    const c = await prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: { notes: true } });
    if (!c) throw notFound('That customer could not be found.');
    const day = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const line = `${day}${by ? ` (${by})` : ''}: ${note}`;
    await prisma.customer.update({ where: { id: customerId }, data: { notes: c.notes?.trim() ? `${c.notes.trim()}\n${line}` : line } });
    return { added: line };
  }
};

/**
 * What to show them first: in stock in THIS store, in the size they buy for that kind of garment,
 * a kind they buy, never something they already have. Within what they usually spend first, then
 * their colours (by family: a Navy saree for someone who buys blues), then the garment they buy most.
 * Over-budget pieces still come, after, so a short shelf is not an empty card. With the shelf it is
 * on when the store uses shelves.
 */
async function picksFor(clientId: string, locationId: string, d: { sizes: { kind: string; size: string | null }[]; colours: string[]; kinds: string[]; bought: Set<string>; boughtProducts: Set<string>; spend: { from: number; to: number } | null }) {
  if (!d.kinds.length) return [];
  const sizeOf = new Map(d.sizes.map(s => [s.kind.toLowerCase(), sizeKey(s.size)]));
  const stock = await prisma.inventoryStock.findMany({
    where: {
      clientId, locationId, quantity: { gt: 0 },
      variant: { product: { status: 'ACTIVE', trashedAt: null, dressType: { in: d.kinds, mode: 'insensitive' } } }
    },
    take: 500,
    select: { quantity: true, reservedQty: true, variant: { select: { id: true, size: true, colorName: true, sellingPrice: true, product: { select: { id: true, title: true, dressType: true, basePrice: true } } } } }
  });
  const colourRank = (c: string | null) => { const f = (colourFamily(c) ?? '').toLowerCase(); const i = d.colours.findIndex(x => x.toLowerCase() === f); return i < 0 ? 99 : i; };
  const priceOf = (s: { variant: { sellingPrice: unknown; product: { basePrice: unknown } } }) => Number(s.variant.sellingPrice ?? s.variant.product.basePrice) || null;
  // A little over their usual top is still worth showing; no price, or no history, is never held against a piece.
  const inBudget = (s: Parameters<typeof priceOf>[0]) => { const p = priceOf(s); return !d.spend || p == null || p <= d.spend.to * BUDGET_STRETCH; };
  const kindRank = (k: string | null) => { const i = d.kinds.findIndex(x => x.toLowerCase() === (k ?? '').toLowerCase()); return i < 0 ? 99 : i; };
  const fits = stock.filter(s => {
    if (s.quantity - s.reservedQty <= 0 || d.bought.has(s.variant.id)) return false;
    const want = sizeOf.get((s.variant.product.dressType ?? '').toLowerCase());
    return !want || sizeKey(s.variant.size) === want;
  });
  // In budget first, then their colour, then the garment they buy most; one per product so six picks are six choices.
  fits.sort((a, b) => Number(inBudget(b)) - Number(inBudget(a)) || colourRank(a.variant.colorName) - colourRank(b.variant.colorName) || kindRank(a.variant.product.dressType) - kindRank(b.variant.product.dressType) || a.variant.product.title.localeCompare(b.variant.product.title));
  const seen = new Set<string>(), chosen: typeof fits = [];
  for (const s of fits) { if (!seen.has(s.variant.product.id)) { seen.add(s.variant.product.id); chosen.push(s); } if (chosen.length === PICKS) break; }
  const shelves = await prisma.spotStock.findMany({
    where: { clientId, locationId, variantId: { in: chosen.map(c => c.variant.id) }, quantity: { gt: 0 } },
    select: { variantId: true, spot: { select: { address: true } } }
  });
  return chosen.map(s => ({
    variantId: s.variant.id, productId: s.variant.product.id, title: s.variant.product.title, kind: s.variant.product.dressType,
    colour: s.variant.colorName, size: s.variant.size, price: priceOf(s),   // a colour with no price of its own sells at the product's
    inStock: s.quantity - s.reservedQty, yourColour: colourRank(s.variant.colorName) < 99, inBudget: inBudget(s),
    shelf: shelves.find(x => x.variantId === s.variant.id)?.spot.address ?? null
  }));
}
