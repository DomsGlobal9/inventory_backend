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
import { literal } from '../../utils/likeText';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { badRequest, notFound } from '../../utils/httpError';
import { groupNamesOf } from '../customer-groups';
import { colourFamily } from './colours';
import { lookedAt } from '../shop-views';
import { alsoBought } from '../also-bought';

// shortcut: a hard ceiling so one bad record can never make the card slow; nobody has 5,000 bills yet.
const MAX_BILLS = 5000;
/** The shared rows for bills with no customer details (pos-events WALK_IN_KEY, Shopify guest). */
const SHARED_CUSTOMERS = ['POS:WALK-IN', 'shopify:guest'];
// NOT IN alone would also drop every ordinary customer, whose external id is empty.
const notShared = { OR: [{ externalCustomerId: null }, { externalCustomerId: { notIn: SHARED_CUSTOMERS } }] };
const PICKS = 6;
const MAX_NOTE = 300;
const BACK_IN_SHOP: ReturnStatus[] = ['RECEIVED', 'INSPECTED', 'COMPLETED'];
/** Their budget: from half their usual low to a quarter over their usual top. */
const BUDGET_FLOOR = 0.5;
const BUDGET_STRETCH = 1.25;
const RECENT_SPEND_MS = 2 * 365 * 86_400_000;
/** A purchase counts half as much for every year since: last month's size beats one from three years ago. */
export const weight = (at: Date, now = Date.now()) => 0.5 ** (Math.max(0, now - at.getTime()) / (365 * 86_400_000));

/**
 * Their colours: half how often they buy a colour, half how much they spend on it. Pieces alone let
 * two cheap dupattas outvote a ₹38,000 lehenga; money alone lets one wedding buy outvote ten everyday
 * kurtis. Each half is a share of their whole buying, so the two are on the same scale.
 */
export function colourScores(pieces: Map<string, number>, money: Map<string, number>): Map<string, number> {
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const p = sum(pieces), r = sum(money);
  const out = new Map<string, number>();
  for (const [k, n] of pieces) out.set(k, r > 0 ? 0.5 * n / p + 0.5 * (money.get(k) ?? 0) / r : n / p);
  return out;
}

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
    const select = CARD_SELECT;
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
    // Not a customer yet -- but a proved number may have tried things on (TryOn2Buy, the online shop)
    // today. Shown, so staff see it straight away and can add them (28 Oct).
    if (!customer) return { phone: phone.value, customer: null, lookedOnline: await lookedOnline(clientId, phone.value, locationId, new Map()) };
    return { phone: phone.value, ...(await cardOf(clientId, customer, phone.value, locationId)) };
  },

  /**
   * One customer's suggestions by id, for ScaleEzy CRM's customer page: the SAME rules as the card
   * (they live only here). Null when the customer is not this shop's.
   */
  async suggestionsFor(clientId: string, customerId: string, locationId?: string) {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, clientId, deletedAt: null }, select: CARD_SELECT });
    if (!customer) return null;
    const phone = customer.phone ? normalisePhone(customer.phone) : null;
    const card = await cardOf(clientId, customer, phone?.ok ? phone.value : null, locationId);
    return { picks: card.picks, alsoBought: card.othersAlsoBought, lookedAtOnline: card.lookedOnline };
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

const CARD_SELECT = { id: true, name: true, customerCode: true, phone: true, email: true, notes: true, tags: true, loyaltyPoints: true, storeCreditPaise: true, birthday: true, anniversary: true } as const;
type CardCustomer = Prisma.CustomerGetPayload<{ select: typeof CARD_SELECT }>;

/**
 * The card for a known customer. `phone` is their number as the shop has it (typed at the door, or on
 * their record); null when there is none, and then only their own bills and email count.
 */
async function cardOf(clientId: string, customer: CardCustomer, phone: string | null, locationId?: string) {
  /*
   * Everything this person bought, at the till AND online: their own record, any order where this
   * number was typed at checkout (an online order the shop kept on a separate record because the
   * number was not proved), and a Shopify record with the same email. All of it -- but what came
   * back does not count, and recent buying counts for more than old (see `weight`).
   */
  const same: Prisma.SalesOrderWhereInput[] = [{ customerId: customer.id }, ...(phone ? [{ customerPhone: phone }] : [])];
  if (customer.email) same.push({ customer: { email: { equals: literal(customer.email), mode: 'insensitive' }, ...notShared } });
  const orders = await prisma.salesOrder.findMany({
    where: { clientId, status: { not: 'CANCELLED' }, deletedAt: null, OR: same },
    orderBy: { createdAt: 'desc' }, take: MAX_BILLS,
    select: {
      createdAt: true, total: true, channel: true,
      items: { select: { id: true, quantity: true, unitPrice: true, variantId: true, variant: { select: { size: true, colorName: true, product: { select: { id: true, title: true, dressType: true } } } } } },
      // Goods actually back in the shop; a return only asked for, or turned down, changes nothing.
      returns: { where: { status: { in: BACK_IN_SHOP } }, select: { refundTotal: true, items: { select: { quantity: true, salesOrderItemId: true, dispatchItem: { select: { salesOrderItemId: true } } } } } }
    }
  });

  // Size per kind of garment: a "M" kurti and a "Free Size" saree are both true at once.
  const sizesByKind = new Map<string, Map<string, number>>();
  const colourPieces = new Map<string, number>(), colourMoney = new Map<string, number>(), kinds = new Map<string, number>();
  const bought = new Set<string>(), boughtProducts = new Set<string>();
  // When each product was last bought: a look or try-on is hidden only if they bought it AFTER it.
  const lastBought = new Map<string, Date>();
  const now = Date.now();
  for (const o of orders) {
    const back = new Map<string, number>();
    for (const r of o.returns) for (const ri of r.items) bump(back, ri.salesOrderItemId ?? ri.dispatchItem.salesOrderItemId, ri.quantity);
    const w = weight(o.createdAt, now);
    for (const it of o.items) {
      // Never offered again, kept or not; but a returned piece says nothing about their size or taste.
      bought.add(it.variantId); boughtProducts.add(it.variant.product.id);
      const was = lastBought.get(it.variant.product.id);
      if (!was || o.createdAt > was) lastBought.set(it.variant.product.id, o.createdAt);
      const kept = Math.max(0, it.quantity - (back.get(it.id) ?? 0));
      if (!kept) continue;
      const kind = it.variant.product.dressType?.trim() || 'Other';
      bump(kinds, kind, kept * w);
      const family = colourFamily(it.variant.colorName);
      bump(colourPieces, family, kept * w);
      bump(colourMoney, family, kept * Number(it.unitPrice) * w);
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
  const topColours = top(colourScores(colourPieces, colourMoney), 3);

  return {
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
    picks: locationId ? await picksFor(clientId, locationId, { sizes, colours: topColours, kinds: topKinds, bought, boughtProducts, spend }) : [],
    // What they looked at in the online shop lately (only ever recorded after they proved this number there).
    lookedOnline: phone ? await lookedOnline(clientId, phone, locationId, lastBought) : [],
    // What other people who bought what they bought also bought, here and in their size.
    othersAlsoBought: locationId ? await othersAlsoBought(clientId, locationId, { sizes, bought, boughtProducts }) : []
  };
}

/**
 * What to show them first: in stock in THIS store, in the size they buy for that kind of garment,
 * a kind they buy, never something they already have. Within what they usually spend first, then
 * their colours (by family: a Navy saree for someone who buys blues), then the garment they buy most.
 * Pieces well outside that range (far dearer, or far cheaper) still come, after, so a short shelf is not an empty card. With the shelf it is
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
  // Their range, give or take: down to half their usual low (a ₹1,650 cotton saree is not a pick for someone
  // who spends ₹8,000–₹18,500), up to a quarter over their usual top. No price, or no history, is never held against a piece.
  const inBudget = (s: Parameters<typeof priceOf>[0]) => { const p = priceOf(s); return !d.spend || p == null || (p >= d.spend.from * BUDGET_FLOOR && p <= d.spend.to * BUDGET_STRETCH); };
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

// Up to a whole TryOn2Buy list (10); hearted pieces first, then the most recent.
const LOOKED = 10;
const ALSO = 4;

/** Where a piece is kept in this store, when the store uses shelves. */
async function shelvesOf(clientId: string, locationId: string, variantIds: string[]) {
  if (!variantIds.length) return new Map<string, string>();
  const rows = await prisma.spotStock.findMany({
    where: { clientId, locationId, variantId: { in: variantIds }, quantity: { gt: 0 } },
    select: { variantId: true, spot: { select: { address: true } } }
  });
  return new Map(rows.map(r => [r.variantId, r.spot.address]));
}

/**
 * "Looked at online lately": the pieces this number opened or tried on in the online shop in the last
 * 30 days, most recent first, minus anything they have bought since. With what this store holds of
 * the colour they looked at (else any colour of it), and its shelf, so staff can fetch it.
 */
/**
 * `lastBought`: when they last bought each product. A piece is left out only when that purchase came
 * AFTER they last looked at it or tried it on -- the look led to the sale. Buying a saree last month
 * must not hide trying on it (or another colour of it) today (28 Oct: a customer's try-on of a saree
 * they had bought before vanished from the card).
 */
async function lookedOnline(clientId: string, phone: string, locationId: string | undefined, lastBought: Map<string, Date>) {
  const looks = (await lookedAt(clientId, phone)).filter(l => { const b = lastBought.get(l.productId); return !b || b <= l.lastAt; })
    .sort((a, b) => Number(!!b.likedAt) - Number(!!a.likedAt)).slice(0, LOOKED);
  if (!looks.length) return [];
  const products = await prisma.product.findMany({
    where: { clientId, id: { in: looks.map(l => l.productId) } },
    select: { id: true, title: true, variants: { select: { id: true, colorName: true } } }
  });
  const stock = locationId ? await prisma.inventoryStock.findMany({
    where: { clientId, locationId, quantity: { gt: 0 }, variant: { productId: { in: looks.map(l => l.productId) } } },
    select: { variantId: true, quantity: true, reservedQty: true, variant: { select: { productId: true } } }
  }) : [];
  const here = stock.filter(s => s.quantity - s.reservedQty > 0);
  const shelf = locationId ? await shelvesOf(clientId, locationId, here.map(s => s.variantId)) : new Map<string, string>();
  return looks.flatMap(l => {
    const p = products.find(x => x.id === l.productId);
    if (!p) return [];
    const theirs = here.filter(s => s.variantId === l.variantId);
    const any = theirs.length ? theirs : here.filter(s => s.variant.productId === l.productId);
    const at = any.find(s => shelf.has(s.variantId)) ?? any[0];
    return [{
      productId: p.id, title: p.title,
      colour: p.variants.find(v => v.id === l.variantId)?.colorName ?? null,
      views: l.views, tryOns: l.tryOns, lastAt: l.lastAt, liked: !!l.likedAt,
      inStock: any.reduce((t, s) => t + s.quantity - s.reservedQty, 0),
      shelf: at ? shelf.get(at.variantId) ?? null : null
    }];
  });
}

/**
 * "Others who bought what they bought also bought": products at least two other people bought along
 * with any of theirs (also-bought), in stock in this store, in their size for that kind of garment,
 * never something they already have. One colour per product, the best-stocked; with its shelf.
 */
async function othersAlsoBought(clientId: string, locationId: string, d: { sizes: { kind: string; size: string | null }[]; bought: Set<string>; boughtProducts: Set<string> }) {
  if (!d.boughtProducts.size) return [];
  const together = await alsoBought(clientId, [...d.boughtProducts], { limit: 30 });
  if (!together.length) return [];
  const sizeOf = new Map(d.sizes.map(s => [s.kind.toLowerCase(), sizeKey(s.size)]));
  const stock = await prisma.inventoryStock.findMany({
    where: {
      clientId, locationId, quantity: { gt: 0 },
      variant: { productId: { in: together.map(t => t.productId) }, product: { status: 'ACTIVE', trashedAt: null } }
    },
    select: { quantity: true, reservedQty: true, variant: { select: { id: true, size: true, colorName: true, sellingPrice: true, product: { select: { id: true, title: true, dressType: true, basePrice: true } } } } }
  });
  const fits = stock.filter(s => {
    if (s.quantity - s.reservedQty <= 0 || d.bought.has(s.variant.id)) return false;
    const want = sizeOf.get((s.variant.product.dressType ?? '').toLowerCase());
    return !want || sizeKey(s.variant.size) === want;
  });
  const chosen: { s: typeof fits[number]; buyers: number }[] = [];
  for (const t of together) {   // most shared buyers first
    const best = fits.filter(s => s.variant.product.id === t.productId).sort((a, b) => (b.quantity - b.reservedQty) - (a.quantity - a.reservedQty))[0];
    if (best) chosen.push({ s: best, buyers: t.buyers });
    if (chosen.length === ALSO) break;
  }
  const shelf = await shelvesOf(clientId, locationId, chosen.map(c => c.s.variant.id));
  return chosen.map(({ s, buyers }) => ({
    variantId: s.variant.id, productId: s.variant.product.id, title: s.variant.product.title, kind: s.variant.product.dressType,
    colour: s.variant.colorName, size: s.variant.size, price: Number(s.variant.sellingPrice ?? s.variant.product.basePrice) || null,
    buyers, inStock: s.quantity - s.reservedQty, shelf: shelf.get(s.variant.id) ?? null
  }));
}
