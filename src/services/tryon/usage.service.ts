import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { todayKey } from '../../utils/businessDay';

/**
 * Counting try-on usage, and holding clients to an allowance.
 *
 * The unit is a GENERATION, counted by outcome, and that choice is the whole design:
 *
 *   started    reached the gateway
 *   completed  ran to the end
 *   failed     started, then broke
 *   cancelled  the merchant navigated away or pressed stop
 *
 * Counting requests instead would charge for a job that failed halfway, charge for one the
 * merchant cancelled, and charge twice for a timeout retry -- three ways of billing someone
 * for something they did not get. Keeping the outcomes apart means the commercial decision
 * ("do we charge for failures?") stays a decision rather than being baked in by whatever was
 * easiest to count.
 *
 * `viewsGenerated` is recorded only when the stream actually says so, and is deliberately NOT
 * four times `completed`. Three views out of four is a real outcome; rounding it up to a whole
 * generation would be inventing data, which this codebase has been burned by before.
 */

/**
 * Which try-on is being metered.
 *
 * Every method takes it last and defaults to CATALOG_TRYON, so the merchant-facing catalog
 * flow reads exactly as it did before shopper try-on existed. That default is not laziness:
 * it means the second service could be added without touching a single existing call site,
 * and therefore without a chance of silently re-pointing the meter that is already running.
 */
export type TryOnService = 'CATALOG_TRYON' | 'SHOPPER_TRYON';

export interface UsageSummary {
  clientId: string;
  service: TryOnService;
  month: string;
  generations: number;
  completed: number;
  failed: number;
  cancelled: number;
  viewsGenerated: number;
  monthlyLimit: number | null;
  remaining: number | null;
  /** True once usage is close enough that the merchant should be told before it bites. */
  approachingLimit: boolean;
  overLimit: boolean;
}

/**
 * When to start warning, rather than at the moment of refusal -- which is too late to act on.
 *
 * Two triggers, because one is not enough. A percentage alone is useless on a small allowance:
 * at a limit of 4, eighty per cent is 3.2, so the warning first appears at 4 -- the point of
 * refusal. A fixed remainder alone is useless on a large one: five left out of a thousand is a
 * warning that arrives far too late to order more. Whichever fires first is the useful one.
 */
const WARN_AT_FRACTION = 0.8;
const WARN_WHEN_REMAINING = 5;

/**
 * What the refusal message calls the thing they have run out of.
 *
 * A shopper standing in a shop scanning a QR code is not "a workspace" and has not "used its
 * generations" -- the two services are refused in front of completely different people, and
 * the wording follows the person rather than the code path.
 */
const SERVICE_NOUN: Record<TryOnService, string> = {
  CATALOG_TRYON: 'catalogue try-on generations',
  SHOPPER_TRYON: 'shopper try-ons'
};

export class TryOnUsageService {
  /** The shop's own day, so a day's usage matches the day the merchant experienced. */
  private async dayKeyFor(clientId: string): Promise<string> {
    const { timezone } = await getShopSettings(clientId);
    return todayKey(timezone);
  }

  /**
   * Records one outcome.
   *
   * Never throws, and is never awaited by the request that caused it. A meter that can fail a
   * generation is worse than a meter that occasionally loses a count -- the merchant's work is
   * the real thing here, and the number is bookkeeping.
   */
  async record(clientId: string, outcome: {
    started?: boolean;
    completed?: boolean;
    failed?: boolean;
    cancelled?: boolean;
    viewsGenerated?: number;
  }, service: TryOnService = 'CATALOG_TRYON') {
    try {
      const day = await this.dayKeyFor(clientId);
      const inc = {
        started: outcome.started ? 1 : 0,
        completed: outcome.completed ? 1 : 0,
        failed: outcome.failed ? 1 : 0,
        cancelled: outcome.cancelled ? 1 : 0,
        viewsGenerated: outcome.viewsGenerated ?? 0
      };

      await prisma.tryOnUsage.upsert({
        where: { uq_tryon_usage_day: { clientId, service, day } },
        create: { clientId, service, day, ...inc },
        update: {
          started: { increment: inc.started },
          completed: { increment: inc.completed },
          failed: { increment: inc.failed },
          cancelled: { increment: inc.cancelled },
          viewsGenerated: { increment: inc.viewsGenerated }
        }
      });
    } catch (error) {
      console.error(`[TryOnUsage] could not record usage for ${clientId}; the generation is unaffected`, error);
    }
  }

  /**
   * This month's usage, and where it stands against the allowance.
   *
   * Charged generations are `completed` plus `failed`: a failure still consumed GPU time, and
   * a client retrying a broken run all day is exactly the case an allowance exists to catch.
   * Cancellations are not counted -- the merchant stopped it deliberately, usually within
   * seconds, and charging for that teaches them not to press stop.
   */
  async summary(clientId: string, month?: string, service: TryOnService = 'CATALOG_TRYON'): Promise<UsageSummary> {
    const { timezone } = await getShopSettings(clientId);
    const currentMonth = month ?? todayKey(timezone).slice(0, 7);

    const [rows, limitRow] = await Promise.all([
      prisma.tryOnUsage.findMany({
        where: { clientId, service, day: { startsWith: currentMonth } },
        select: { completed: true, failed: true, cancelled: true, viewsGenerated: true }
      }),
      prisma.clientServiceLimit.findUnique({
        where: { uq_client_service_limit: { clientId, service } },
        select: { monthlyLimit: true }
      })
    ]);

    const completed = rows.reduce((a, r) => a + r.completed, 0);
    const failed = rows.reduce((a, r) => a + r.failed, 0);
    const cancelled = rows.reduce((a, r) => a + r.cancelled, 0);
    const viewsGenerated = rows.reduce((a, r) => a + r.viewsGenerated, 0);

    const generations = completed + failed;
    const monthlyLimit = limitRow?.monthlyLimit ?? null;
    const remaining = monthlyLimit === null ? null : Math.max(monthlyLimit - generations, 0);

    return {
      clientId,
      service,
      month: currentMonth,
      generations,
      completed,
      failed,
      cancelled,
      viewsGenerated,
      monthlyLimit,
      remaining,
      approachingLimit:
        monthlyLimit !== null &&
        generations < monthlyLimit &&
        (generations >= monthlyLimit * WARN_AT_FRACTION || (remaining ?? 0) <= WARN_WHEN_REMAINING),
      overLimit: monthlyLimit !== null && generations >= monthlyLimit
    };
  }

  /**
   * Refuses a generation when the client is out of allowance.
   *
   * Blocks rather than allowing an overage, because there is no billing system behind this yet
   * -- allowing it would mean unmetered GPU spend with nothing to invoice against, which is the
   * worse failure of the two. The message names the limit and the number, because being
   * stopped by a figure you were never shown is the worst version of this feature; the merchant
   * also sees it on their own Settings screen well before this point.
   *
   * No limit set means no limit. That is deliberate for a platform that already has customers:
   * this must not switch off try-on for 37 shops on the day it deploys.
   */
  async assertWithinLimit(clientId: string, service: TryOnService = 'CATALOG_TRYON') {
    const usage = await this.summary(clientId, undefined, service);
    if (usage.overLimit) {
      throw Object.assign(
        new Error(
          `This workspace has used its ${usage.monthlyLimit} ${SERVICE_NOUN[service]} for ${usage.month}. ` +
          `Ask Scaleezy to raise the limit to carry on.`
        ),
        { statusCode: 429 }
      );
    }
    return usage;
  }

  /** Daily usage for a client, for the console's chart. */
  async daily(clientId: string, days = 30, service: TryOnService = 'CATALOG_TRYON') {
    return prisma.tryOnUsage.findMany({
      where: { clientId, service },
      orderBy: { day: 'desc' },
      take: days,
      select: { day: true, started: true, completed: true, failed: true, cancelled: true, viewsGenerated: true }
    });
  }

  /** Sets or clears a client's monthly allowance. Null clears it. */
  async setMonthlyLimit(
    clientId: string, monthlyLimit: number | null, updatedByAdmin: string,
    service: TryOnService = 'CATALOG_TRYON'
  ) {
    if (monthlyLimit !== null && (!Number.isInteger(monthlyLimit) || monthlyLimit < 0)) {
      throw Object.assign(new Error('A limit must be a whole number, or blank for unlimited'), { statusCode: 400 });
    }

    await prisma.clientServiceLimit.upsert({
      where: { uq_client_service_limit: { clientId, service } },
      create: { clientId, service, monthlyLimit, updatedByAdmin },
      update: { monthlyLimit, updatedByAdmin }
    });

    return this.summary(clientId, undefined, service);
  }
}

export const tryOnUsageService = new TryOnUsageService();
