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

/** Every live customer, reachable or not: what the shop's choices are applied to in the breakdown. */
const everyone = (clientId: string): Prisma.CustomerWhereInput => ({ clientId, deletedAt: null, status: 'ACTIVE' });

const liveOrder = { status: { not: 'CANCELLED' as const }, deletedAt: null };

/** At most one offer per customer per shop in any 72 hours (decision D3, 22 Sep 2026). */
export const RECENT_OFFER_HOURS = 72;

/**
 * Customers this shop has already sent an offer to in the last 72 hours: a message of one of its own
 * campaigns (not wishes or points reminders) that WhatsApp accepted and did not then fail, or one being
 * handed over right now. Test sends are not campaigns' messages and never count.
 */
export async function recentlyOffered(clientId: string, now = new Date(), opts: { exceptCampaignId?: string; customerIds?: string[] } = {}): Promise<Set<string>> {
  const since = new Date(now.getTime() - RECENT_OFFER_HOURS * 3_600_000);
  const rows = await prisma.$queryRaw<{ customer_id: string }[]>`
    SELECT DISTINCT r.customer_id
      FROM campaign_recipients r
      JOIN campaigns c ON c.id = r.campaign_id
      LEFT JOIN whatsapp_messages m ON m.id = r.message_id
     WHERE r.client_id = ${clientId}
       AND c.source = 'MANUAL'
       AND r.state IN ('HANDED', 'HANDING')
       AND r.handed_at >= ${since}
       AND (m.status IS NULL OR m.status NOT IN ('FAILED', 'EXPIRED'))
       ${opts.exceptCampaignId ? Prisma.sql`AND r.campaign_id <> ${opts.exceptCampaignId}` : Prisma.empty}
       ${opts.customerIds ? Prisma.sql`AND r.customer_id IN (${opts.customerIds.length ? Prisma.join(opts.customerIds) : Prisma.sql`NULL`})` : Prisma.empty}`;
  return new Set(rows.map(r => r.customer_id));
}

/** The customer filter for an audience, at this moment. `base` is who it may reach at all. */
export async function whereFor(clientId: string, a: Audience, now = new Date(), base: Prisma.CustomerWhereInput = reachable(clientId)): Promise<Prisma.CustomerWhereInput> {
  const and: Prisma.CustomerWhereInput[] = [base];
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

/**
 * How many a campaign would reach now, with a few names so the shop can see it is right, and -- the
 * dry run -- how many of the customers its choices describe are left out, and why, before anything
 * is sent.
 */
export async function preview(clientId: string, a: Audience, now = new Date()) {
  const where = await whereFor(clientId, a, now);
  const chosen = await whereFor(clientId, a, now, everyone(clientId));
  const [count, sample, withPhone, agreed, matched, noPhone, stopped, notAgreed, reachIds] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({ where, take: 5, orderBy: { name: 'asc' }, select: { id: true, name: true, loyaltyPoints: true } }),
    prisma.customer.count({ where: { clientId, deletedAt: null, phone: { not: null } } }),
    prisma.customer.count({ where: reachable(clientId) }),
    prisma.customer.count({ where: chosen }),
    prisma.customer.count({ where: { AND: [chosen, { phone: null }] } }),
    prisma.customer.count({ where: { AND: [chosen, { phone: { not: null } }, { whatsappStoppedAt: { not: null } }] } }),
    prisma.customer.count({ where: { AND: [chosen, { phone: { not: null } }, { whatsappStoppedAt: null }, { whatsappOffers: false }] } }),
    prisma.customer.findMany({ where, select: { id: true }, take: 20_000 })
  ]);
  const recent = await recentlyOffered(clientId, now, { customerIds: reachIds.map(r => r.id) });
  return {
    count, sample, customersWithPhone: withPhone, agreedToOffers: agreed,
    breakdown: {
      matched,
      noPhone,
      stopped,
      notAgreed,
      reachable: count,
      /** Had an offer in the last 72 hours: skipped if it is still within 72 hours when their turn comes. */
      recentOffer: recent.size,
      willGet: count - recent.size
    }
  };
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
