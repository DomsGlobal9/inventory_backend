/**
 * What changed between two versions of an offer, said the way a merchant would say it.
 *
 * Pure. A version snapshot is JSON written by offer.service.writeVersion; this reads two of them
 * and returns sentences. It is here, rather than on the screen, because the history is a record --
 * the same words should come back from the API whoever asks, and they should be tested.
 */

import { describeSchedule, OfferSchedule } from './schedule';

export type Labels = {
  /** refId -> what the merchant calls it. Missing ids read as "an item that was removed". */
  targets: Map<string, string>;
  locations: Map<string, string>;
};

const DEPARTMENTS: Record<string, string> = { WOMEN: 'Women', MEN: 'Men', KIDS: 'Kids', UNISEX: 'Unisex' };
const CHANNELS: Record<string, string> = { POS: 'the till', ONLINE: 'the online store', MANUAL: 'manual orders', MARKETPLACE: 'marketplaces' };
const SCOPES: Record<string, string> = {
  ALL: 'everything', CATEGORY: 'departments', DRESS_TYPE: 'types of garment', PRODUCT: 'products', VARIANT: 'particular items'
};

const money = (v: unknown) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function valueText(valueType: string, value: unknown): string {
  if (valueType === 'PERCENTAGE') return `${Number(value)}% off`;
  if (valueType === 'FIXED_AMOUNT') return `${money(value)} off`;
  return `price set to ${money(value)}`;
}

export function targetLabel(scope: string, refId: string, labels: Labels): string {
  if (scope === 'CATEGORY') return DEPARTMENTS[refId] ?? refId;
  if (scope === 'DRESS_TYPE') return refId;
  return labels.targets.get(refId) ?? 'an item that was removed';
}

const dateText = (v: unknown) => {
  if (!v) return 'no end date';
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata'
  });
};

const list = (items: string[], max = 4) => {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
};

/** One sentence per thing that changed. An empty list means nothing that affects a price did. */
export function describeChanges(before: any, after: any, labels: Labels): string[] {
  if (!before) return [];
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  if (before.valueType !== after.valueType || Number(before.value) !== Number(after.value)) {
    out.push(`Changed from ${valueText(before.valueType, before.value)} to ${valueText(after.valueType, after.value)}.`);
  }
  if (before.level !== after.level) {
    out.push(after.level === 'ORDER' ? 'Now comes off the whole bill.' : 'Now comes off each item.');
  }
  if (!same(before.maxDiscount, after.maxDiscount)) {
    out.push(after.maxDiscount == null ? 'Removed the cap.' : `Capped at ${money(after.maxDiscount)}${before.maxDiscount == null ? '' : ` (was ${money(before.maxDiscount)})`}.`);
  }
  if ((before.trigger !== after.trigger || (before.couponCode ?? null) !== (after.couponCode ?? null)) && !after.uniqueCodes) {
    out.push(after.trigger === 'CODE' ? `Now needs the code ${after.couponCode}.` : 'Now applies automatically, without a code.');
  }

  const beforeTargets = new Set<string>((before.targets ?? []).map((t: any) => t.refId));
  const afterTargets = new Set<string>((after.targets ?? []).map((t: any) => t.refId));
  if (before.scope !== after.scope) {
    const names = [...afterTargets].map(id => targetLabel(after.scope, id, labels));
    out.push(after.scope === 'ALL'
      ? 'Now applies to everything.'
      : `Now applies to ${SCOPES[after.scope] ?? 'items'}: ${list(names)}.`);
  } else {
    const added = [...afterTargets].filter(id => !beforeTargets.has(id)).map(id => targetLabel(after.scope, id, labels));
    const removed = [...beforeTargets].filter(id => !afterTargets.has(id)).map(id => targetLabel(after.scope, id, labels));
    if (added.length) out.push(`Added ${list(added)}.`);
    if (removed.length) out.push(`Removed ${list(removed)}.`);
  }

  if (!same(before.minSubtotal, after.minSubtotal)) {
    out.push(after.minSubtotal == null ? 'No longer needs a minimum spend.' : `Minimum spend set to ${money(after.minSubtotal)}.`);
  }
  if (!same(before.minQuantity, after.minQuantity)) {
    out.push(after.minQuantity == null ? 'No longer needs a minimum number of items.' : `Needs at least ${after.minQuantity} items.`);
  }
  if (!same([...(before.channels ?? [])].sort(), [...(after.channels ?? [])].sort())) {
    const c = (after.channels ?? []) as string[];
    out.push(c.length ? `Now sells only through ${list(c.map(x => CHANNELS[x] ?? x))}.` : 'Now sells everywhere.');
  }
  if (!same([...(before.locationIds ?? [])].sort(), [...(after.locationIds ?? [])].sort())) {
    const l = (after.locationIds ?? []) as string[];
    out.push(l.length ? `Now runs only at ${list(l.map(id => labels.locations.get(id) ?? 'a closed location'))}.` : 'Now runs at every location.');
  }
  if (!same(new Date(before.startsAt).getTime(), new Date(after.startsAt).getTime())) {
    out.push(`Start moved to ${dateText(after.startsAt)}.`);
  }
  if (!same(before.endsAt ? new Date(before.endsAt).getTime() : null, after.endsAt ? new Date(after.endsAt).getTime() : null)) {
    out.push(after.endsAt ? `End moved to ${dateText(after.endsAt)}.` : 'No longer ends.');
  }
  if (!same(before.usageLimit, after.usageLimit)) {
    out.push(after.usageLimit == null ? 'No limit on total uses.' : `Limited to ${after.usageLimit} uses in total.`);
  }
  if (!same(before.usageLimitPerCustomer, after.usageLimitPerCustomer)) {
    out.push(after.usageLimitPerCustomer == null ? 'No limit per customer.' : `Limited to ${after.usageLimitPerCustomer} per customer.`);
  }
  if (!!before.perPiece !== !!after.perPiece && after.valueType === 'FIXED_AMOUNT' && after.level !== 'ORDER') {
    out.push(after.perPiece ? 'Now comes off each piece.' : 'Now comes off each line once.');
  }
  {
    const key = (x: any) => `${x.scope}:${x.refId}`;
    const was = new Map<string, any>(((before.exclusions ?? []) as any[]).map(x => [key(x), x]));
    const now = new Map<string, any>(((after.exclusions ?? []) as any[]).map(x => [key(x), x]));
    const added = [...now.entries()].filter(([k]) => !was.has(k)).map(([, x]) => targetLabel(x.scope, x.refId, labels));
    const removed = [...was.entries()].filter(([k]) => !now.has(k)).map(([, x]) => targetLabel(x.scope, x.refId, labels));
    if (added.length) out.push(`Now leaves out ${list(added)}.`);
    if (removed.length) out.push(`No longer leaves out ${list(removed)}.`);
  }
  if (!same([...(before.customerTags ?? [])].sort(), [...(after.customerTags ?? [])].sort())) {
    const t = (after.customerTags ?? []) as string[];
    out.push(t.length ? `Now only for ${list(t)} customers.` : 'Now for every customer.');
  }
  if (!same(before.schedule ?? null, after.schedule ?? null)) {
    const s = describeSchedule(after.schedule as OfferSchedule | null);
    out.push(s ? `Now runs only ${s}.` : 'Now runs at any hour.');
  }
  if (!!before.uniqueCodes !== !!after.uniqueCodes) {
    out.push(after.uniqueCodes ? 'Now given with single-use codes.' : 'No longer uses single-use codes.');
  }
  if (!same(before.priority, after.priority)) out.push(`Priority set to ${after.priority}.`);
  if (!same(before.stackable, after.stackable)) {
    out.push(after.stackable ? 'Can now combine with other offers.' : 'No longer combines with other offers.');
  }
  return out;
}
