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
import { OfferDraft, validateOffer, effectiveStatus, dedupeTargets, normaliseTags } from './rules';
import { normaliseSchedule, OfferSchedule } from './schedule';
import { generateCodes, validateCodeBatch, canonicalCode } from './codes';
import { forgetShopSettings } from '../../lib/clientSettings';
import { markOfferMirrorsDirty } from '../shopify-discounts/dirty';

/** Which fields, when changed, mean the rule itself is different and history must be kept. */
const RULE_FIELDS = [
  'trigger', 'couponCode', 'level', 'valueType', 'value', 'maxDiscount',
  'scope', 'minSubtotal', 'minQuantity', 'channels', 'locationIds',
  'startsAt', 'endsAt', 'usageLimit', 'usageLimitPerCustomer', 'priority', 'stackable',
  'perPiece', 'customerTags', 'schedule', 'uniqueCodes'
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
      include: {
        targets: true,
        exclusions: true,
        // COUNTED only. A use given back by a cancelled order is history, not usage -- counting it
        // made the list say an offer had been used more times than its own allowance said, and a
        // merchant watching "first 50" saw it fill up with orders that never happened.
        _count: { select: { redemptions: { where: { status: 'COUNTED' } } } }
      },
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
        exclusions: true,
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

  async create(
    clientId: string, input: OfferInput, userId?: string,
    /** For a copy: what the original already named may be kept even if it is binned since. */
    kept: { targets: string[]; locations: string[] } = { targets: [], locations: [] }
  ) {
    input = this.prepare(input);
    const problems = validateOffer(input);
    if (problems.length) throw badRequest(problems.join(' '));
    await this.checkReferences(clientId, input, kept);
    await this.checkSharedCodeFree(clientId, input.couponCode);

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
            couponCode: input.trigger === 'CODE' && input.couponCode ? String(input.couponCode).trim() : null,
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
            perPiece: !!input.perPiece,
            customerTags: input.customerTags ?? [],
            schedule: (input.schedule ?? Prisma.JsonNull) as any,
            uniqueCodes: !!input.uniqueCodes,
            // Always DRAFT. An offer becomes live by a deliberate act, never as a side effect of
            // being typed -- somebody half way through writing a 50% discount must not have it
            // running while they think about it.
            status: 'DRAFT',
            createdBy: userId ?? null,
            targets: {
              create: (input.targets ?? []).map(t => ({ scope: t.scope as any, refId: t.refId }))
            },
            exclusions: {
              create: (input.exclusions ?? []).map(t => ({ scope: t.scope as any, refId: t.refId }))
            }
          },
          include: { targets: true, exclusions: true }
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
    const existing = await prisma.offer.findFirst({ where: { id, clientId }, include: { targets: true, exclusions: true } });
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
      stackable: input.stackable ?? existing.stackable,
      perPiece: input.perPiece ?? existing.perPiece,
      exclusions: input.exclusions ?? existing.exclusions.map(t => ({ scope: t.scope, refId: t.refId })),
      customerTags: input.customerTags ?? existing.customerTags,
      schedule: input.schedule === undefined ? existing.schedule : input.schedule,
      uniqueCodes: input.uniqueCodes ?? existing.uniqueCodes
    };

    const prepared = this.prepare(merged);
    Object.assign(merged, prepared);
    const problems = validateOffer(merged);
    if (problems.length) throw badRequest(problems.join(' '));
    await this.checkReferences(clientId, merged, {
      targets: [...existing.targets, ...existing.exclusions].map(t => t.refId),
      locations: existing.locationIds
    });
    if ((merged.couponCode ?? null) !== (existing.couponCode ?? null)) {
      await this.checkSharedCodeFree(clientId, merged.couponCode);
    }

    /*
     * Turning single-use codes off, once codes exist.
     *
     * The codes are already printed on cards and in inboxes. Switching the offer to a shared code
     * would make every one of them stop working without anyone being told. Refused; the honest way
     * is a new offer.
     */
    if (existing.uniqueCodes && !merged.uniqueCodes) {
      const made = await prisma.offerCode.count({ where: { offerId: id } });
      if (made > 0) {
        throw conflict(`This offer has ${made} single-use code${made === 1 ? '' : 's'} already made, and they would all stop working. Duplicate it into a new offer instead.`);
      }
    }

    /*
     * Changing a live offer that people have already used.
     *
     * Allowed, and versioned -- a merchant genuinely does need to extend a sale or fix a wrong
     * percentage mid-flight. What must not happen is the change reaching back: the orders already
     * placed keep pointing at the version that priced them.
     */
    try {
      const saved = await prisma.$transaction(async (tx) => {
        await tx.offerTarget.deleteMany({ where: { offerId: id } });
        await tx.offerExclusion.deleteMany({ where: { offerId: id } });

        const updated = await tx.offer.update({
          where: { id },
          data: {
            name: String(merged.name).trim(),
            description: merged.description ?? null,
            trigger: merged.trigger as any,
            couponCode: merged.trigger === 'CODE' && merged.couponCode ? String(merged.couponCode).trim() : null,
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
            perPiece: !!merged.perPiece,
            customerTags: merged.customerTags ?? [],
            schedule: (merged.schedule ?? Prisma.JsonNull) as any,
            uniqueCodes: !!merged.uniqueCodes,
            targets: {
              create: (merged.targets ?? []).map(t => ({ scope: t.scope as any, refId: t.refId }))
            },
            exclusions: {
              create: (merged.exclusions ?? []).map(t => ({ scope: t.scope as any, refId: t.refId }))
            }
          },
          include: { targets: true, exclusions: true }
        });

        if (this.ruleChanged(existing, updated)) {
          const version = await this.writeVersion(tx, updated, userId, note);
          await tx.offer.update({ where: { id }, data: { currentVersionId: version.id } });
          return { ...updated, currentVersionId: version.id };
        }

        return updated;
      }, { timeout: 20000 });

      // After the commit, never inside it: a Shopify copy must not be able to stop an offer saving.
      await markOfferMirrorsDirty(id);
      return saved;
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
    const offer = await prisma.offer.findFirst({ where: { id, clientId }, include: { targets: true, exclusions: true } });
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
        targets: offer.targets.map(t => ({ scope: t.scope, refId: t.refId })),
        exclusions: offer.exclusions.map(t => ({ scope: t.scope, refId: t.refId }))
      } as any);
      if (problems.length) throw badRequest(problems.join(' '));

      if (offer.uniqueCodes && (await prisma.offerCode.count({ where: { offerId: id, usedAt: null } })) === 0) {
        throw badRequest('This offer has no unused codes yet. Make its codes first, then start it.');
      }

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
    // Paused, resumed or retired: every Shopify copy follows. Pausing ends the copy there, resuming
    // puts its dates back, retiring removes it.
    await markOfferMirrorsDirty(id);
    return prisma.offer.findFirstOrThrow({ where: { id }, include: { targets: true } });
  }

  /**
   * Everything an offer names really exists, in THIS shop.
   *
   * Checked on save rather than trusted from the screen: an id the screen sent could be another
   * shop's product (the offer would then apply to nothing here, silently), a product since moved
   * to the bin, or a location that was closed. Each is refused by name, so the merchant knows which
   * choice to remove.
   */
  private async checkReferences(
    clientId: string,
    input: OfferInput,
    kept: { targets: string[]; locations: string[] } = { targets: [], locations: [] }
  ) {
    const scope = input.scope ?? 'ALL';
    // Only what this save ADDS. A product that went to the bin after the offer named it must not
    // stop the merchant renaming the offer; the engine already skips products that cannot sell.
    const ids = (input.targets ?? []).map(t => t.refId).filter(id => !kept.targets.includes(id));

    if (scope === 'PRODUCT' && ids.length) {
      const found = await prisma.product.findMany({
        where: { id: { in: ids }, clientId }, select: { id: true, title: true, status: true, trashedAt: true }
      });
      const byId = new Map(found.map(p => [p.id, p]));
      const missing = ids.filter(id => !byId.has(id));
      if (missing.length) throw badRequest(`${missing.length === 1 ? 'One chosen product no longer exists' : `${missing.length} chosen products no longer exist`} in this shop. Remove ${missing.length === 1 ? 'it' : 'them'} and save again.`);
      const binned = found.filter(p => p.trashedAt || p.status === 'TRASHED');
      if (binned.length) throw badRequest(`${binned.map(p => p.title).slice(0, 3).join(', ')} ${binned.length === 1 ? 'is' : 'are'} in the bin. Remove ${binned.length === 1 ? 'it' : 'them'} from the offer, or restore ${binned.length === 1 ? 'it' : 'them'} first.`);
    }

    if (scope === 'VARIANT' && ids.length) {
      const found = await prisma.productVariant.findMany({ where: { id: { in: ids }, clientId }, select: { id: true } });
      const missing = ids.length - new Set(found.map(v => v.id)).size;
      if (missing > 0) throw badRequest(`${missing === 1 ? 'One chosen item no longer exists' : `${missing} chosen items no longer exist`} in this shop. Remove ${missing === 1 ? 'it' : 'them'} and save again.`);
    }

    // What it leaves out has to be this shop's too -- but a binned product may be left out; leaving
    // out something that cannot sell is harmless.
    const outProducts = (input.exclusions ?? []).filter(e => e.scope === 'PRODUCT' && !kept.targets.includes(e.refId)).map(e => e.refId);
    const outVariants = (input.exclusions ?? []).filter(e => e.scope === 'VARIANT' && !kept.targets.includes(e.refId)).map(e => e.refId);
    if (outProducts.length && (await prisma.product.count({ where: { clientId, id: { in: outProducts } } })) !== new Set(outProducts).size) {
      throw badRequest('A product this offer leaves out no longer exists in this shop. Remove it and save again.');
    }
    if (outVariants.length && (await prisma.productVariant.count({ where: { clientId, id: { in: outVariants } } })) !== new Set(outVariants).size) {
      throw badRequest('An item this offer leaves out no longer exists in this shop. Remove it and save again.');
    }

    const locationIds = (input.locationIds ?? []).filter(id => !kept.locations.includes(id));
    if (locationIds.length) {
      const found = await prisma.stockLocation.findMany({
        where: { id: { in: locationIds }, clientId }, select: { id: true, name: true, active: true }
      });
      if (found.length !== new Set(locationIds).size) {
        throw badRequest('One of the chosen locations no longer exists in this shop. Choose again.');
      }
      const closed = found.filter(l => !l.active);
      if (closed.length) throw badRequest(`${closed.map(l => l.name).join(', ')} ${closed.length === 1 ? 'is' : 'are'} closed. Choose an open location.`);
    }
  }

  /** One shape for every save: duplicates gone, tags tidied, per-piece only where it means something. */
  private prepare(input: OfferInput): OfferInput {
    const scope = String(input.scope ?? 'ALL');
    // Junk is passed through untouched for validateOffer to refuse in words; only good entries are
    // tidied. Silently dropping a malformed entry would save an offer that is not what was sent.
    if (input.exclusions != null && (!Array.isArray(input.exclusions)
        || input.exclusions.some((e: any) => !e || typeof e !== 'object' || !String(e.refId ?? '').trim()))) {
      return input;
    }
    if (input.customerTags != null && (!Array.isArray(input.customerTags) || input.customerTags.some((t: any) => typeof t !== 'string'))) {
      return input;
    }
    for (const v of [input.perPiece, input.uniqueCodes, input.stackable]) {
      if (v != null && typeof v !== 'boolean') return input;
    }
    const exclusions = (input.exclusions ?? []).map(e => ({ scope: e.scope, refId: String(e.refId ?? '').trim() }));
    const outByKey = new Map<string, { scope: string; refId: string }>();
    for (const e of exclusions) {
      const key = `${e.scope}:${e.scope === 'DRESS_TYPE' ? e.refId.toLowerCase() : e.refId}`;
      if (!outByKey.has(key)) outByKey.set(key, e);
    }
    const level = input.level ?? 'LINE';
    return {
      ...input,
      targets: dedupeTargets(scope, input.targets ?? []) as any,
      exclusions: [...outByKey.values()],
      customerTags: normaliseTags(input.customerTags),
      schedule: input.schedule == null ? null : normaliseSchedule(input.schedule as OfferSchedule),
      // Per piece is a property of an amount off items. On a percentage or a bill it means nothing,
      // and storing it there would make two identical offers look different in their history.
      perPiece: input.valueType === 'FIXED_AMOUNT' && level === 'LINE' ? !!input.perPiece : false,
      // Kept as sent, so "single-use codes on an automatic offer" is refused rather than quietly undone.
      uniqueCodes: !!input.uniqueCodes,
      couponCode: input.trigger === 'CODE' && input.uniqueCodes ? null : input.couponCode
    };
  }

  /** A shared code must not be one of the single-use codes already printed. */
  private async checkSharedCodeFree(clientId: string, couponCode?: string | null) {
    if (!couponCode) return;
    const taken = await prisma.offerCode.findFirst({ where: { clientId, code: canonicalCode(couponCode) }, select: { id: true } });
    if (taken) throw conflict(`${canonicalCode(couponCode)} is already one of your single-use codes. Pick a different code.`);
  }

  /**
   * A copy to start from.
   *
   * Last Deepavali's sale, ready to be this Deepavali's. Always a DRAFT, never used, and never
   * carrying the original's single-use codes -- those belong to the original's customers. Dates in
   * the past are not copied: a copy that has already ended is a copy nobody can start.
   */
  async duplicate(clientId: string, id: string, userId?: string) {
    const source = await prisma.offer.findFirst({ where: { id, clientId }, include: { targets: true, exclusions: true } });
    if (!source) throw notFound('That offer no longer exists.');

    const now = new Date();
    const startsAt = source.startsAt > now ? source.startsAt : now;
    const endsAt = source.endsAt && source.endsAt > startsAt ? source.endsAt : null;

    let couponCode: string | null = null;
    if (source.trigger === 'CODE' && !source.uniqueCodes && source.couponCode) {
      const base = source.couponCode.toUpperCase().replace(/-COPY\d*$/, '').slice(0, 24);
      for (let n = 1; n < 100 && !couponCode; n++) {
        const candidate = n === 1 ? `${base}-COPY` : `${base}-COPY${n}`;
        const clash = await prisma.offer.findFirst({ where: { clientId, couponCode: { equals: candidate, mode: 'insensitive' } }, select: { id: true } })
          ?? await prisma.offerCode.findFirst({ where: { clientId, code: candidate }, select: { id: true } });
        if (!clash) couponCode = candidate;
      }
    }

    // Only locations still open: a copy should not fail to save over a shop that has since closed.
    const openLocations = source.locationIds.length
      ? (await prisma.stockLocation.findMany({ where: { clientId, id: { in: source.locationIds }, active: true }, select: { id: true } })).map(l => l.id)
      : [];

    const attempt = (couponCode: string | null) => this.create(clientId, {
      name: `Copy of ${source.name}`.slice(0, 120),
      description: source.description,
      trigger: source.trigger as any,
      couponCode,
      level: source.level as any,
      valueType: source.valueType as any,
      value: Number(source.value),
      maxDiscount: source.maxDiscount == null ? null : Number(source.maxDiscount),
      scope: source.scope as any,
      targets: source.targets.map(t => ({ scope: t.scope, refId: t.refId })),
      exclusions: source.exclusions.map(t => ({ scope: t.scope, refId: t.refId })),
      minSubtotal: source.minSubtotal == null ? null : Number(source.minSubtotal),
      minQuantity: source.minQuantity,
      channels: source.channels as any,
      locationIds: openLocations,
      startsAt,
      endsAt,
      usageLimit: source.usageLimit,
      usageLimitPerCustomer: source.usageLimitPerCustomer,
      priority: source.priority,
      stackable: source.stackable,
      perPiece: source.perPiece,
      customerTags: source.customerTags,
      schedule: source.schedule,
      uniqueCodes: source.uniqueCodes
    } as any, userId, {
      // A product binned since the original was written must not make the copy impossible.
      targets: [...source.targets, ...source.exclusions].map(t => t.refId),
      locations: []
    });

    for (let tries = 0; ; tries++) {
      try {
        return await attempt(couponCode);
      } catch (error: any) {
        const clash = error?.statusCode === 409 && /already uses the code/.test(String(error?.message));
        if (!clash || !couponCode || tries >= 5) throw error;
        // Two people pressed Duplicate at once and the other copy took this code first.
        const base = couponCode.replace(/-COPY\d*$/, '');
        const n = Number((couponCode.match(/-COPY(\d*)$/)?.[1] || '1')) + 1;
        couponCode = `${base}-COPY${n}`;
      }
    }
  }

  /**
   * Make a batch of single-use codes.
   *
   * Written with skipDuplicates and counted afterwards, so a code another request made in the same
   * instant is simply not ours -- and the shortfall is made up, rather than the whole batch failing.
   */
  async makeCodes(clientId: string, id: string, prefix: string, count: number) {
    const offer = await prisma.offer.findFirst({ where: { id, clientId }, select: { id: true, uniqueCodes: true, status: true } });
    if (!offer) throw notFound('That offer no longer exists.');
    if (!offer.uniqueCodes) throw badRequest('This offer uses one shared code, not single-use codes.');
    if (offer.status === 'ARCHIVED') throw conflict('This offer has been retired, so it cannot have new codes.');

    const problems = validateCodeBatch(prefix, Number(count));
    if (problems.length) throw badRequest(problems.join(' '));

    const existingTotal = await prisma.offerCode.count({ where: { offerId: id } });
    if (existingTotal + Number(count) > 50000) {
      throw badRequest('An offer can have at most 50,000 codes.');
    }

    let made = 0;
    for (let round = 0; round < 5 && made < count; round++) {
      const batch = generateCodes(prefix, count - made);
      // Never the same as any shared code in this shop.
      const shared = await prisma.offer.findMany({
        where: { clientId, couponCode: { in: batch, mode: 'insensitive' } }, select: { couponCode: true }
      });
      const blocked = new Set(shared.map(s => String(s.couponCode).toUpperCase()));
      const rows = batch.filter(c => !blocked.has(c)).map(code => ({ clientId, offerId: id, code }));
      const result = await prisma.offerCode.createMany({ data: rows, skipDuplicates: true });
      made += result.count;
    }

    const totals = await this.codeCounts(id);
    return { made, ...totals };
  }

  private async codeCounts(offerId: string) {
    const [total, used] = await Promise.all([
      prisma.offerCode.count({ where: { offerId } }),
      prisma.offerCode.count({ where: { offerId, usedAt: { not: null } } })
    ]);
    return { total, used, unused: total - used };
  }

  /** The codes, a page at a time, or every unused one for copying out. */
  async listCodes(clientId: string, id: string, opts: { status?: string; q?: string; take?: number; skip?: number; all?: boolean } = {}) {
    const offer = await prisma.offer.findFirst({ where: { id, clientId }, select: { id: true } });
    if (!offer) throw notFound('That offer no longer exists.');

    const where: Prisma.OfferCodeWhereInput = {
      offerId: id,
      ...(opts.status === 'USED' ? { usedAt: { not: null } } : opts.status === 'UNUSED' ? { usedAt: null } : {}),
      ...(opts.q ? { code: { contains: canonicalCode(opts.q) } } : {})
    };
    const take = opts.all ? 50000 : Math.min(Math.max(Number(opts.take) || 50, 1), 200);
    const rows = await prisma.offerCode.findMany({
      where, orderBy: [{ usedAt: { sort: 'desc', nulls: 'last' } }, { code: 'asc' }],
      take, skip: opts.all ? 0 : Math.max(Number(opts.skip) || 0, 0),
      select: { code: true, usedAt: true, salesOrderId: true, createdAt: true }
    });

    const orders = rows.some(r => r.salesOrderId)
      ? await prisma.salesOrder.findMany({
          where: { clientId, id: { in: rows.map(r => r.salesOrderId).filter(Boolean) as string[] } },
          select: { id: true, orderNumber: true }
        })
      : [];
    const numberOf = new Map(orders.map(o => [o.id, o.orderNumber]));

    return {
      ...(await this.codeCounts(id)),
      matching: await prisma.offerCode.count({ where }),
      codes: rows.map(r => ({ code: r.code, usedAt: r.usedAt, orderId: r.salesOrderId, orderNumber: r.salesOrderId ? numberOf.get(r.salesOrderId) ?? null : null }))
    };
  }

  /** The shop-wide rule for discounts at the till. */
  async getSettings(clientId: string) {
    const row = await prisma.clientSettings.findUnique({ where: { clientId }, select: { manualDiscountMaxPercent: true } });
    return { manualDiscountMaxPercent: row?.manualDiscountMaxPercent == null ? null : Number(row.manualDiscountMaxPercent) };
  }

  async setSettings(clientId: string, input: { manualDiscountMaxPercent?: number | string | null }) {
    const raw = input.manualDiscountMaxPercent;
    const value = raw === '' || raw == null ? null : Number(raw);
    if (value != null && (!Number.isFinite(value) || value <= 0 || value > 100)) {
      throw badRequest('The till limit is a percentage above 0 and up to 100. Leave it empty for no limit.');
    }
    if (value != null && Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
      throw badRequest('Give the till limit to at most two decimal places.');
    }
    await prisma.clientSettings.upsert({
      where: { clientId },
      create: { clientId, manualDiscountMaxPercent: value == null ? null : new Prisma.Decimal(value) },
      update: { manualDiscountMaxPercent: value == null ? null : new Prisma.Decimal(value) }
    });
    // Seen by the very next order, not a minute later.
    forgetShopSettings(clientId);
    return this.getSettings(clientId);
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
          stackable: offer.stackable,
          perPiece: offer.perPiece,
          exclusions: (offer.exclusions ?? []).map((t: any) => ({ scope: t.scope, refId: t.refId })),
          customerTags: offer.customerTags ?? [],
          schedule: offer.schedule ?? null,
          uniqueCodes: offer.uniqueCodes
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
      } else if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
        // A schedule. String() of two different objects is "[object Object]" both times.
        if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) return true;
      } else if (String(a ?? '') !== String(b ?? '')) {
        return true;
      }
    }

    const targetKey = (t: any) => `${t.scope}:${t.refId}`;
    const beforeTargets = (before.targets ?? []).map(targetKey).sort().join('|');
    const afterTargets = (after.targets ?? []).map(targetKey).sort().join('|');
    if (beforeTargets !== afterTargets) return true;
    const beforeOut = (before.exclusions ?? []).map(targetKey).sort().join('|');
    const afterOut = (after.exclusions ?? []).map(targetKey).sort().join('|');
    return beforeOut !== afterOut;
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
