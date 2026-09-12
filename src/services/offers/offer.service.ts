/**
 * Writing, changing and retiring an offer.
 *
 * The one thing this file exists to protect is that **an offer's history is never rewritten**.
 * Every change that alters what the rule DOES writes a new immutable OfferVersion, and an order
 * records the version it used. Editing "20% off" down to "10% off" in November therefore cannot
 * change what October's customers were charged -- which is precisely what happens in every system
 * where a report joins to a mutable rule.
 *
 * Applying an offer is Phase 3 and lives elsewhere. Nothing here prices anything.
 */

import { prisma } from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { generateSequentialCode } from '../../utils/codeGenerator';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { OfferDraft, validateOffer, effectiveStatus } from './rules';

/** Which fields, when changed, mean the rule itself is different and history must be kept. */
const RULE_FIELDS = [
  'trigger', 'couponCode', 'level', 'valueType', 'value', 'maxDiscount',
  'scope', 'minSubtotal', 'minQuantity', 'channels', 'locationIds',
  'startsAt', 'endsAt', 'usageLimit', 'usageLimitPerCustomer', 'priority', 'stackable'
] as const;

export interface OfferInput extends OfferDraft {
  description?: string | null;
  channels?: string[] | null;
  locationIds?: string[] | null;
}

export class OfferService {
  /**
   * The offers a merchant sees, filtered by what they ARE rather than what their column says.
   *
   * Filtering on the column alone is wrong in a way that is easy to miss: an offer switched on in
   * August with an end date in September still has status ACTIVE, so "show me what is running"
   * returned offers the very same screen labelled "Ended". Scheduled ones had the same problem
   * from the other side -- an offer that starts next Friday is ACTIVE in the column and is not
   * running at all.
   *
   * So SCHEDULED and EXPIRED are real filters here, expressed as the date conditions that define
   * them, rather than states anything has to remember to write.
   */
  async list(clientId: string, filters: { status?: string; search?: string } = {}) {
    const now = new Date();

    const byStatus = (wanted?: string): Prisma.OfferWhereInput => {
      switch (wanted) {
        case undefined:
        case '':
        case 'ALL':
          return {};
        // Running NOW: switched on, started, and not yet finished.
        case 'ACTIVE':
          return {
            status: 'ACTIVE',
            startsAt: { lte: now },
            OR: [{ endsAt: null }, { endsAt: { gt: now } }]
          };
        // Switched on, but its moment has not come.
        case 'SCHEDULED':
          return { status: 'ACTIVE', startsAt: { gt: now } };
        // Switched on, and time ended it.
        case 'EXPIRED':
          return { status: 'ACTIVE', endsAt: { lte: now } };
        default:
          return { status: wanted as any };
      }
    };

    const offers = await prisma.offer.findMany({
      where: {
        clientId,
        ...byStatus(filters.status),
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { offerCode: { contains: filters.search, mode: 'insensitive' } },
                { couponCode: { contains: filters.search, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      include: { targets: true, _count: { select: { redemptions: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }]
    });

    return offers.map(o => ({
      ...o,
      redemptionCount: (o as any)._count.redemptions,
      // What it IS, not what the column says. A merchant reading a list needs to see that an
      // offer they switched on last month stopped on its own three weeks ago.
      effectiveStatus: effectiveStatus(o as any, now)
    }));
  }

  async getById(clientId: string, id: string) {
    const offer = await prisma.offer.findFirst({
      where: { id, clientId },
      include: {
        targets: true,
        versions: { orderBy: { version: 'desc' }, take: 20 },
        _count: { select: { redemptions: true } }
      }
    });
    if (!offer) throw notFound('That offer no longer exists.');

    // What it has actually saved people, which is the only number that says whether it worked.
    const totals = await prisma.offerRedemption.aggregate({
      where: { offerId: id, status: 'COUNTED' },
      _sum: { amount: true },
      _count: true
    });

    return {
      ...offer,
      effectiveStatus: effectiveStatus(offer as any),
      redemptionCount: totals._count,
      totalDiscounted: totals._sum.amount ?? new Prisma.Decimal(0)
    };
  }

  async create(clientId: string, input: OfferInput, userId?: string) {
    const problems = validateOffer(input);
    if (problems.length) throw badRequest(problems.join(' '));

    const offerCode = await generateSequentialCode(clientId, 'OFR', 'OFFER');

    try {
      return await prisma.$transaction(async (tx) => {
        const offer = await tx.offer.create({
          data: {
            clientId,
            offerCode,
            name: String(input.name).trim(),
            description: input.description ?? null,
            trigger: (input.trigger ?? 'AUTOMATIC') as any,
            couponCode: input.trigger === 'CODE' ? String(input.couponCode).trim() : null,
            level: (input.level ?? 'LINE') as any,
            valueType: input.valueType as any,
            value: new Prisma.Decimal(Number(input.value)),
            maxDiscount: input.maxDiscount == null ? null : new Prisma.Decimal(Number(input.maxDiscount)),
            scope: (input.scope ?? 'ALL') as any,
            minSubtotal: input.minSubtotal == null ? null : new Prisma.Decimal(Number(input.minSubtotal)),
            minQuantity: input.minQuantity ?? null,
            channels: (input.channels ?? []) as any,
            locationIds: input.locationIds ?? [],
            startsAt: new Date(input.startsAt as any),
            endsAt: input.endsAt ? new Date(input.endsAt as any) : null,
            usageLimit: input.usageLimit ?? null,
            usageLimitPerCustomer: input.usageLimitPerCustomer ?? null,
            priority: input.priority ?? 0,
            stackable: input.stackable ?? false,
            // Always DRAFT. An offer becomes live by a deliberate act, never as a side effect of
            // being typed -- somebody half way through writing a 50% discount must not have it
            // running while they think about it.
            status: 'DRAFT',
            createdBy: userId ?? null,
            targets: {
              create: (input.targets ?? []).map(t => ({ scope: t.scope as any, refId: t.refId }))
            }
          },
          include: { targets: true }
        });

        const version = await this.writeVersion(tx, offer, userId, 'Created');
        await tx.offer.update({ where: { id: offer.id }, data: { currentVersionId: version.id } });

        return { ...offer, currentVersionId: version.id };
      }, { timeout: 20000 });
    } catch (error: any) {
      throw this.translate(error, input);
    }
  }

  /**
   * Change an offer.
   *
   * A version is written only when the RULE changed. Renaming an offer or fixing a typo in its
   * description does not deserve a version -- a version history where nineteen of twenty entries
   * are "changed the name" is one nobody reads, and the one entry that matters is lost in it.
   */
  async update(clientId: string, id: string, input: OfferInput, userId?: string, note?: string) {
    const existing = await prisma.offer.findFirst({ where: { id, clientId }, include: { targets: true } });
    if (!existing) throw notFound('That offer no longer exists.');

    if (existing.status === 'ARCHIVED') {
      throw conflict('This offer has been archived. Copy it into a new one rather than changing it.');
    }

    const merged: OfferInput = {
      name: input.name ?? existing.name,
      description: input.description === undefined ? existing.description : input.description,
      trigger: (input.trigger ?? existing.trigger) as any,
      couponCode: input.couponCode === undefined ? existing.couponCode : input.couponCode,
      level: (input.level ?? existing.level) as any,
      valueType: (input.valueType ?? existing.valueType) as any,
      value: input.value ?? Number(existing.value),
      maxDiscount: input.maxDiscount === undefined
        ? (existing.maxDiscount == null ? null : Number(existing.maxDiscount))
        : input.maxDiscount,
      scope: (input.scope ?? existing.scope) as any,
      targets: input.targets ?? existing.targets.map(t => ({ scope: t.scope, refId: t.refId })),
      minSubtotal: input.minSubtotal === undefined
        ? (existing.minSubtotal == null ? null : Number(existing.minSubtotal))
        : input.minSubtotal,
      minQuantity: input.minQuantity === undefined ? existing.minQuantity : input.minQuantity,
      channels: input.channels ?? (existing.channels as any),
      locationIds: input.locationIds ?? existing.locationIds,
      startsAt: input.startsAt ?? existing.startsAt,
      endsAt: input.endsAt === undefined ? existing.endsAt : input.endsAt,
      usageLimit: input.usageLimit === undefined ? existing.usageLimit : input.usageLimit,
      usageLimitPerCustomer: input.usageLimitPerCustomer === undefined
        ? existing.usageLimitPerCustomer : input.usageLimitPerCustomer,
      priority: input.priority ?? existing.priority,
      stackable: input.stackable ?? existing.stackable
    };

    const problems = validateOffer(merged);
    if (problems.length) throw badRequest(problems.join(' '));

    /*
     * Changing a live offer that people have already used.
     *
     * Allowed, and versioned -- a merchant genuinely does need to extend a sale or fix a wrong
     * percentage mid-flight. What must not happen is the change reaching back: the orders already
     * placed keep pointing at the version that priced them.
     */
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.offerTarget.deleteMany({ where: { offerId: id } });

        const updated = await tx.offer.update({
          where: { id },
          data: {
            name: String(merged.name).trim(),
            description: merged.description ?? null,
            trigger: merged.trigger as any,
            couponCode: merged.trigger === 'CODE' ? String(merged.couponCode).trim() : null,
            level: merged.level as any,
            valueType: merged.valueType as any,
            value: new Prisma.Decimal(Number(merged.value)),
            maxDiscount: merged.maxDiscount == null ? null : new Prisma.Decimal(Number(merged.maxDiscount)),
            scope: merged.scope as any,
            minSubtotal: merged.minSubtotal == null ? null : new Prisma.Decimal(Number(merged.minSubtotal)),
            minQuantity: merged.minQuantity ?? null,
            channels: (merged.channels ?? []) as any,
            locationIds: merged.locationIds ?? [],
            startsAt: new Date(merged.startsAt as any),
            endsAt: merged.endsAt ? new Date(merged.endsAt as any) : null,
            usageLimit: merged.usageLimit ?? null,
            usageLimitPerCustomer: merged.usageLimitPerCustomer ?? null,
            priority: merged.priority ?? 0,
            stackable: merged.stackable ?? false,
            targets: {
              create: (merged.targets ?? []).map(t => ({ scope: t.scope as any, refId: t.refId }))
            }
          },
          include: { targets: true }
        });

        if (this.ruleChanged(existing, updated)) {
          const version = await this.writeVersion(tx, updated, userId, note);
          await tx.offer.update({ where: { id }, data: { currentVersionId: version.id } });
          return { ...updated, currentVersionId: version.id };
        }

        return updated;
      }, { timeout: 20000 });
    } catch (error: any) {
      throw this.translate(error, merged);
    }
  }

  /**
   * Switch an offer on, off, or away.
   *
   * The transitions are deliberately few. An offer is DRAFT until somebody starts it; ACTIVE and
   * PAUSED go back and forth; ARCHIVED is the end. EXPIRED is never set by hand -- it is what
   * time did, and `effectiveStatus` derives it, so a merchant cannot "un-expire" something by
   * pressing a button instead of changing its dates.
   */
  async setStatus(clientId: string, id: string, next: 'ACTIVE' | 'PAUSED' | 'ARCHIVED', userId?: string) {
    const offer = await prisma.offer.findFirst({ where: { id, clientId }, include: { targets: true } });
    if (!offer) throw notFound('That offer no longer exists.');

    if (offer.status === next) return offer;

    if (offer.status === 'ARCHIVED') {
      throw conflict('This offer has been archived and cannot be started again.');
    }

    if (next === 'ACTIVE') {
      // Checked again on the way in, because an offer can be left as a draft for weeks and the
      // world moves: its end date may now be in the past, or a product it names may be gone.
      const problems = validateOffer({
        ...offer,
        value: Number(offer.value),
        maxDiscount: offer.maxDiscount == null ? null : Number(offer.maxDiscount),
        minSubtotal: offer.minSubtotal == null ? null : Number(offer.minSubtotal),
        targets: offer.targets.map(t => ({ scope: t.scope, refId: t.refId }))
      } as any);
      if (problems.length) throw badRequest(problems.join(' '));

      if (offer.endsAt && offer.endsAt <= new Date()) {
        throw badRequest('This offer already ended. Change its dates before starting it.');
      }
    }

    /*
     * Claimed, not written.
     *
     * The same compare-and-set used for confirming an order, and for the same reason: two people
     * pressing Start at once must not both succeed. Here it is far less costly than
     * double-reserving stock, but a rule that is only applied where it hurts is a rule nobody
     * remembers to apply.
     */
    const claimed = await prisma.offer.updateMany({
      where: { id, clientId, status: offer.status },
      data: {
        status: next,
        ...(next === 'ARCHIVED' ? { archivedAt: new Date() } : {})
      }
    });

    if (claimed.count === 0) {
      throw conflict('Somebody changed this offer at the same moment. Refresh to see where it got to.');
    }

    void userId;
    return prisma.offer.findFirstOrThrow({ where: { id }, include: { targets: true } });
  }

  /** The immutable record of what the rule said. */
  private async writeVersion(tx: any, offer: any, userId?: string, note?: string) {
    const last = await tx.offerVersion.findFirst({
      where: { offerId: offer.id }, orderBy: { version: 'desc' }, select: { version: true }
    });

    return tx.offerVersion.create({
      data: {
        offerId: offer.id,
        version: (last?.version ?? 0) + 1,
        changedBy: userId ?? null,
        changeNote: note ?? null,
        // Everything that decides what the offer DOES. Not the name or the description: those do
        // not change a price, and a version history full of renames is one nobody reads.
        snapshot: {
          trigger: offer.trigger,
          couponCode: offer.couponCode,
          level: offer.level,
          valueType: offer.valueType,
          value: String(offer.value),
          maxDiscount: offer.maxDiscount == null ? null : String(offer.maxDiscount),
          scope: offer.scope,
          targets: (offer.targets ?? []).map((t: any) => ({ scope: t.scope, refId: t.refId })),
          minSubtotal: offer.minSubtotal == null ? null : String(offer.minSubtotal),
          minQuantity: offer.minQuantity,
          channels: offer.channels,
          locationIds: offer.locationIds,
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
          usageLimit: offer.usageLimit,
          usageLimitPerCustomer: offer.usageLimitPerCustomer,
          priority: offer.priority,
          stackable: offer.stackable
        }
      }
    });
  }

  /** Did anything that affects a price actually change? */
  private ruleChanged(before: any, after: any): boolean {
    for (const field of RULE_FIELDS) {
      const a = before[field];
      const b = after[field];
      if (a instanceof Date || b instanceof Date) {
        if (String(a?.valueOf?.() ?? a) !== String(b?.valueOf?.() ?? b)) return true;
      } else if (Array.isArray(a) || Array.isArray(b)) {
        if (JSON.stringify(a ?? []) !== JSON.stringify(b ?? [])) return true;
      } else if (String(a ?? '') !== String(b ?? '')) {
        return true;
      }
    }

    const targetKey = (t: any) => `${t.scope}:${t.refId}`;
    const beforeTargets = (before.targets ?? []).map(targetKey).sort().join('|');
    const afterTargets = (after.targets ?? []).map(targetKey).sort().join('|');
    return beforeTargets !== afterTargets;
  }

  /** A duplicate coupon code, said the way a merchant would ask about it. */
  private translate(error: any, input: OfferInput) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target) ? (error.meta!.target as string[]) : [];
      if (target.includes('coupon_code')) {
        return conflict(
          `Another offer already uses the code ${String(input.couponCode ?? '').trim()}. ` +
          `Pick a different one.`
        );
      }
    }
    return error;
  }
}

export const offerService = new OfferService();
