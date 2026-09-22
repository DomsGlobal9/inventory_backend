/**
 * Who a campaign is for, as the shop describes it, turned into the customers it means.
 *
 * Everyone chosen must first be reachable: a live, active customer with a phone number who agreed
 * to offers on WhatsApp and never replied STOP. The shop's choices only narrow that down.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest } from '../../utils/httpError';
import { normaliseTags } from '../offers/rules';

export interface Audience {
  /** In any of these customer groups (VIP, WHOLESALE...). */
  tags?: string[];
  /** Bought something in the last N days. */
  boughtWithinDays?: number;
  /** Bought before, but nothing in the last N days: "we miss you". */
  notBoughtForDays?: number;
  /** Spent at least this much, in rupees, over all their orders. */
  minSpend?: number;
  /** Hold at least this many loyalty points. */
  minPoints?: number;
  /** Automatic campaigns only: exactly these customers. */
  customerIds?: string[];
}

const MAX_DAYS = 3650;

function days(raw: unknown, what: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_DAYS) {
    throw badRequest(`${what} must be a whole number of days, from 1 to ${MAX_DAYS}.`);
  }
  return raw;
}

/** What the shop sent, checked and tidied. Unknown keys are dropped. */
export function checkAudience(raw: unknown): Audience {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Say who the campaign is for.');
  const r = raw as Record<string, unknown>;
  const out: Audience = {};
  if (r.tags !== undefined && r.tags !== null) {
    if (!Array.isArray(r.tags) || r.tags.some(t => typeof t !== 'string')) throw badRequest('Choose customer groups by name.');
    const tags = normaliseTags(r.tags as string[]);
    if (tags.length > 20) throw badRequest('Choose at most 20 groups.');
    if (tags.length) out.tags = tags;
  }
  const within = days(r.boughtWithinDays, '"Bought in the last"');
  const quiet = days(r.notBoughtForDays, '"Has not bought for"');
  if (within && quiet && within >= quiet) {
    // Bought in the last 30 days and not for 60 days can match nobody.
    throw badRequest('"Bought in the last" and "has not bought for" cannot both be true. Use one of them.');
  }
  if (within) out.boughtWithinDays = within;
  if (quiet) out.notBoughtForDays = quiet;
  if (r.minSpend !== undefined && r.minSpend !== null && r.minSpend !== '') {
    if (typeof r.minSpend !== 'number' || !(r.minSpend >= 0) || r.minSpend > 100_000_000) throw badRequest('Enter the least they have spent, in rupees.');
    if (r.minSpend > 0) out.minSpend = Math.round(r.minSpend * 100) / 100;
  }
  if (r.minPoints !== undefined && r.minPoints !== null && r.minPoints !== '') {
    if (typeof r.minPoints !== 'number' || !Number.isInteger(r.minPoints) || r.minPoints < 1) throw badRequest('Enter the least points they hold, as a whole number.');
    out.minPoints = r.minPoints;
  }
  return out;
}

/** Everyone a shop's campaign could ever reach. */
export const reachable = (clientId: string): Prisma.CustomerWhereInput => ({
  clientId, deletedAt: null, status: 'ACTIVE', phone: { not: null }, whatsappOffers: true, whatsappStoppedAt: null
});

const liveOrder = { status: { not: 'CANCELLED' as const }, deletedAt: null };

/** The customer filter for an audience, at this moment. */
export async function whereFor(clientId: string, a: Audience, now = new Date()): Promise<Prisma.CustomerWhereInput> {
  const and: Prisma.CustomerWhereInput[] = [reachable(clientId)];
  if (a.customerIds) and.push({ id: { in: a.customerIds } });
  if (a.tags?.length) {
    // Groups keep the spelling they were first given ("vip" and "VIP" are one group), so match every
    // spelling this shop has actually used.
    const wanted = new Set(a.tags.map(t => t.toLowerCase()));
    const used = await prisma.$queryRaw<{ tag: string }[]>`SELECT DISTINCT unnest(tags) AS tag FROM customers WHERE client_id = ${clientId}`;
    const spellings = used.map(u => u.tag).filter(t => wanted.has(t.toLowerCase()));
    and.push({ tags: { hasSome: spellings.length ? spellings : a.tags } });
  }
  if (a.minPoints) and.push({ loyaltyPoints: { gte: a.minPoints } });
  if (a.boughtWithinDays) {
    const since = new Date(now.getTime() - a.boughtWithinDays * 86_400_000);
    and.push({ salesOrders: { some: { ...liveOrder, createdAt: { gte: since } } } });
  }
  if (a.notBoughtForDays) {
    const since = new Date(now.getTime() - a.notBoughtForDays * 86_400_000);
    and.push({ salesOrders: { some: liveOrder } });
    and.push({ salesOrders: { none: { ...liveOrder, createdAt: { gte: since } } } });
  }
  if (a.minSpend) {
    const spenders = await prisma.salesOrder.groupBy({
      by: ['customerId'],
      where: { clientId, ...liveOrder },
      _sum: { total: true },
      having: { total: { _sum: { gte: a.minSpend } } }
    });
    and.push({ id: { in: spenders.map(s => s.customerId).filter(Boolean) } });
  }
  return { AND: and };
}

/** How many a campaign would reach now, with a few names so the shop can see it is right. */
export async function preview(clientId: string, a: Audience) {
  const where = await whereFor(clientId, a);
  const [count, sample, everyone, agreed] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({ where, take: 5, orderBy: { name: 'asc' }, select: { id: true, name: true, loyaltyPoints: true } }),
    prisma.customer.count({ where: { clientId, deletedAt: null, phone: { not: null } } }),
    prisma.customer.count({ where: reachable(clientId) })
  ]);
  return { count, sample, customersWithPhone: everyone, agreedToOffers: agreed };
}

/** Plain words for an audience, for the list and the confirm box. */
export function describeAudience(a: Audience): string {
  const parts: string[] = [];
  if (a.customerIds) return `${a.customerIds.length} chosen customer${a.customerIds.length === 1 ? '' : 's'}`;
  if (a.tags?.length) parts.push(`in ${a.tags.join(' or ')}`);
  if (a.boughtWithinDays) parts.push(`bought in the last ${a.boughtWithinDays} days`);
  if (a.notBoughtForDays) parts.push(`nothing bought for ${a.notBoughtForDays} days`);
  if (a.minSpend) parts.push(`spent at least ₹${a.minSpend.toLocaleString('en-IN')}`);
  if (a.minPoints) parts.push(`hold ${a.minPoints.toLocaleString('en-IN')}+ points`);
  return parts.length ? `Customers who agreed to offers, ${parts.join(', ')}` : 'Every customer who agreed to offers';
}
