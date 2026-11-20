import { prisma } from '../../lib/prisma';
import { offerService } from '../offers';
import { problem, type Actor } from './index';

/**
 * Offers through the boutique API (20 Nov 2026, PLAN-boutique-backend.md part 3): the same offers, codes and rules
 * as Inventory's Offers screen -- one offer engine for the till, the online shop and Shopify -- with items named by
 * the boutique's codes instead of our ids. Writes need offers:write; anyone of the boutique may read.
 *
 * Targets and exclusions: { scope: 'VARIANT', code } (an item: item code, barcode, SKU or variant code),
 * { scope: 'PRODUCT', code } (a whole design: its product code, or any of its items' codes),
 * { scope: 'CATEGORY' | 'DRESS_TYPE', name } (WOMEN / MEN..., or Saree, Lehenga...). Stores by storeIds.
 * Every change is recorded as "<person> (Boutique)".
 */
const by = (a: Actor) => `${a.name} (Boutique)`;
const mustWrite = (a: Actor) => { if (!a.can.includes('offers:write')) throw problem('This person may not make or change offers.', 403); };

async function variantByCode(clientId: string, code: string) {
  const select = { id: true, productId: true } as const;
  return await prisma.productVariant.findFirst({ where: { clientId, barcode: code, boutiqueDeletedAt: null }, select })
    ?? await prisma.productVariant.findFirst({ where: { clientId, boutiqueDeletedAt: null, OR: [{ boutiqueRef: code }, { variantCode: code }, { sku: code }] }, select });
}

/** Boutique-style targets -> the engine's { scope, refId }. Each one checked against this shop, refused by name. */
async function toRefs(clientId: string, raw: unknown, what: string) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw problem(`${what} is a list.`);
  if (raw.length > 500) throw problem(`At most 500 ${what}.`);
  const out: { scope: string; refId: string }[] = [];
  for (const t of raw) {
    const scope = String(t?.scope ?? '').toUpperCase();
    if (scope === 'CATEGORY' || scope === 'DRESS_TYPE') {
      const name = String(t?.name ?? '').trim();
      if (!name) throw problem(`Each ${scope.toLowerCase().replace('_', ' ')} in ${what} needs its name.`);
      out.push({ scope, refId: scope === 'CATEGORY' ? name.toUpperCase() : name });
      continue;
    }
    if (scope !== 'VARIANT' && scope !== 'PRODUCT') throw problem(`A scope in ${what} is VARIANT, PRODUCT, CATEGORY or DRESS_TYPE.`);
    const code = String(t?.code ?? '').trim();
    if (!code) throw problem(`Each item in ${what} needs its code.`);
    if (scope === 'PRODUCT') {
      const p = await prisma.product.findFirst({ where: { clientId, productCode: code }, select: { id: true } });
      const id = p?.id ?? (await variantByCode(clientId, code))?.productId;
      if (!id) throw problem(`${code}: no such item or design in this shop.`, 404);
      out.push({ scope, refId: id });
    } else {
      const v = await variantByCode(clientId, code);
      if (!v) throw problem(`${code}: no such item in this shop.`, 404);
      out.push({ scope, refId: v.id });
    }
  }
  return out;
}

/** The engine's input from a boutique body: everything as Inventory's API takes it, targets and stores renamed. */
async function input(clientId: string, body: any) {
  const { targets, exclusions, storeIds, locationIds: _ignored, ...rest } = body ?? {};
  const t = await toRefs(clientId, targets, 'targets');
  const x = await toRefs(clientId, exclusions, 'exclusions');
  if (storeIds !== undefined && storeIds !== null && !Array.isArray(storeIds)) throw problem('storeIds is a list of store ids.');
  return {
    ...rest,
    ...(t !== undefined ? { targets: t } : {}),
    ...(x !== undefined ? { exclusions: x } : {}),
    ...(storeIds !== undefined ? { locationIds: storeIds ?? [] } : {})
  };
}

/** One offer as the boutique sees it: our ids turned back into its codes. */
async function view(clientId: string, o: any) {
  const refs = [...(o.targets ?? []), ...(o.exclusions ?? [])];
  const vIds = refs.filter((r: any) => r.scope === 'VARIANT').map((r: any) => r.refId);
  const pIds = refs.filter((r: any) => r.scope === 'PRODUCT').map((r: any) => r.refId);
  const [vs, ps] = await Promise.all([
    vIds.length ? prisma.productVariant.findMany({ where: { clientId, id: { in: vIds } }, select: { id: true, boutiqueRef: true, variantCode: true, product: { select: { title: true } } } }) : [],
    pIds.length ? prisma.product.findMany({ where: { clientId, id: { in: pIds } }, select: { id: true, productCode: true, title: true } }) : []
  ]);
  const vMap = new Map(vs.map(v => [v.id, { code: v.boutiqueRef ?? v.variantCode, name: v.product.title }]));
  const pMap = new Map(ps.map(p => [p.id, { code: p.productCode, name: p.title }]));
  const ref = (r: any) => r.scope === 'VARIANT' ? { scope: r.scope, ...(vMap.get(r.refId) ?? { code: null, name: 'An item no longer in the shop' }) }
    : r.scope === 'PRODUCT' ? { scope: r.scope, ...(pMap.get(r.refId) ?? { code: null, name: 'A design no longer in the shop' }) }
    : { scope: r.scope, name: r.refId };
  const n = (v: any) => (v === null || v === undefined ? null : Number(v));
  return {
    id: o.id, offerCode: o.offerCode, name: o.name, description: o.description ?? null,
    status: o.status, running: o.effectiveStatus ?? null,
    trigger: o.trigger, couponCode: o.couponCode ?? null, uniqueCodes: !!o.uniqueCodes,
    level: o.level, valueType: o.valueType, value: n(o.value), maxDiscount: n(o.maxDiscount), perPiece: !!o.perPiece,
    scope: o.scope, targets: (o.targets ?? []).map(ref), exclusions: (o.exclusions ?? []).map(ref),
    minSubtotal: n(o.minSubtotal), minQuantity: o.minQuantity ?? null,
    channels: o.channels ?? [], storeIds: o.locationIds ?? [], customerTags: o.customerTags ?? [],
    startsAt: o.startsAt, endsAt: o.endsAt ?? null, schedule: o.schedule ?? null,
    usageLimit: o.usageLimit ?? null, usageLimitPerCustomer: o.usageLimitPerCustomer ?? null,
    priority: o.priority, stackable: !!o.stackable,
    timesUsed: o.redemptionCount ?? o.usageCount ?? 0,
    ...(o.totalDiscounted !== undefined ? { totalDiscounted: n(o.totalDiscounted) } : {})
  };
}

export async function list(a: Actor, q: { status?: unknown; search?: unknown }) {
  const offers = await offerService.list(a.clientId, { status: q.status ? String(q.status).toUpperCase() : undefined, search: q.search ? String(q.search).slice(0, 100) : undefined });
  return Promise.all(offers.map(o => view(a.clientId, o)));
}
export async function getOne(a: Actor, id: string) { return view(a.clientId, await offerService.getById(a.clientId, id)); }
export async function create(a: Actor, body: any) {
  mustWrite(a);
  const made = await offerService.create(a.clientId, await input(a.clientId, body) as any, by(a));
  return getOne(a, made.id);
}
export async function change(a: Actor, id: string, body: any) {
  mustWrite(a);
  await offerService.getById(a.clientId, id); // 404 for another shop's offer, before anything is read from the body
  const note = typeof body?.changeNote === 'string' ? body.changeNote.slice(0, 200) : undefined;
  const { changeNote: _n, ...rest } = body ?? {};
  await offerService.update(a.clientId, id, await input(a.clientId, rest) as any, by(a), note);
  return getOne(a, id);
}
export async function setStatus(a: Actor, id: string, raw: unknown) {
  mustWrite(a);
  const next = String(raw ?? '').toUpperCase();
  if (!['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(next)) throw problem('status is ACTIVE (switch on), PAUSED or ARCHIVED.');
  await offerService.setStatus(a.clientId, id, next as any, by(a));
  return getOne(a, id);
}
export async function makeCodes(a: Actor, id: string, body: any) {
  mustWrite(a);
  await offerService.getById(a.clientId, id);
  return offerService.makeCodes(a.clientId, id, String(body?.prefix ?? ''), Number(body?.count));
}
export async function listCodes(a: Actor, id: string, q: any) {
  await offerService.getById(a.clientId, id);
  return offerService.listCodes(a.clientId, id, { status: q.status ? String(q.status).toUpperCase() : undefined, q: q.q ? String(q.q) : undefined, take: Math.min(200, Number(q.limit) || 50), skip: Math.max(0, Number(q.skip) || 0) });
}
