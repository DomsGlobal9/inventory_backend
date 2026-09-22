/**
 * The automatic messages, prepared once a day per shop: birthday and anniversary wishes, and the
 * reminder a week before points lapse. Each day's lot is an ordinary campaign (source BIRTHDAY,
 * ANNIVERSARY or POINTS_EXPIRING), so it is sent by the same slow sender, shows in the same list
 * with its ticks, and can be stopped like any other.
 *
 * Also once a day: quiet customers' points lapse, and birthday gift points are given.
 *
 * ONCE A DAY. A shop's day is claimed first (loyalty_settings.auto_prepared_for), so the job
 * running twice, or on two servers, prepares one lot. Prepared at 10 am shop time or later -- the
 * same hour campaigns start sending.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { localDayKey } from '../../utils/businessDay';
import {
  birthdayKeysFor, DEFAULT_ANNIVERSARY_TEXT, DEFAULT_BIRTHDAY_TEXT, getSettings, giveBirthdayPoints, lapseQuietPoints
} from '../loyalty';
import { reachable } from './audience';
import { localHour, SEND_FROM_HOUR } from './sender';

const DAY = 86_400_000;
const shortDate = (dayKey: string) => {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

async function makeCampaign(clientId: string, source: string, name: string, text: string, customerIds: string[], mediaId: string | null = null) {
  if (customerIds.length === 0) return null;
  // The day's name carries the date: the same lot already made in the last two days is not made again,
  // even if the day's claim was somehow lost.
  const made = await prisma.campaign.findFirst({ where: { clientId, source, name, createdAt: { gte: new Date(Date.now() - 2 * DAY) } }, select: { id: true } });
  if (made) return null;
  // The wish's picture, if the shop chose one and it still exists. Frozen like any campaign's.
  const media = mediaId ? await prisma.campaignMedia.findFirst({ where: { id: mediaId, clientId }, select: { id: true, url: true, width: true, height: true } }) : null;
  const shopName = (await getShopSettings(clientId)).businessName || 'our shop';
  const now = new Date();
  return prisma.$transaction(async tx => {
    const c = await tx.campaign.create({
      data: {
        clientId, source, name, text, status: 'SENDING', startedAt: now,
        audience: { customerIds } as Prisma.InputJsonValue,
        mediaId: media?.id ?? null,
        snapshot: { text, media, link: null, shopName, frozenAt: now.toISOString() } as Prisma.InputJsonValue
      }
    });
    await tx.campaignRecipient.createMany({ data: customerIds.map(customerId => ({ campaignId: c.id, clientId, customerId })), skipDuplicates: true });
    return c.id;
  }, { timeout: 30000, maxWait: 15000 });
}

export type PrepareResult = { clientId: string; lapsed: number; birthdayPoints: number; birthdays: number; anniversaries: number; expiring: number };

/** One shop's day. Returns null when it is too early or the day was already prepared. */
export async function prepareShopDay(clientId: string, now = new Date(), opts: { ignoreHours?: boolean } = {}): Promise<PrepareResult | null> {
  const { timezone } = await getShopSettings(clientId);
  if (!opts.ignoreHours && localHour(now, timezone) < SEND_FROM_HOUR) return null;
  const day = localDayKey(now, timezone);
  const claimed = await prisma.loyaltySettings.updateMany({
    where: { clientId, OR: [{ autoPreparedFor: null }, { autoPreparedFor: { not: day } }] },
    data: { autoPreparedFor: day }
  });
  if (claimed.count === 0) return null;

  const s = await getSettings(clientId);
  const out: PrepareResult = { clientId, lapsed: 0, birthdayPoints: 0, birthdays: 0, anniversaries: 0, expiring: 0 };
  const year = Number(day.slice(0, 4));
  const todays = birthdayKeysFor(day);

  out.lapsed = await lapseQuietPoints(clientId, day, now);

  // Birthday gift points go to every customer whose birthday it is, message or not.
  if (s.enabled && s.birthdayPoints > 0) {
    const born = await prisma.customer.findMany({ where: { clientId, deletedAt: null, status: 'ACTIVE', birthday: { in: todays } }, select: { id: true } });
    for (const c of born) if ((await giveBirthdayPoints(clientId, c.id, year).catch(() => null)) !== null) out.birthdayPoints += 1;
  }

  if (s.birthdayWish) {
    const ids = (await prisma.customer.findMany({ where: { ...reachable(clientId), birthday: { in: todays } }, select: { id: true } })).map(c => c.id);
    const gift = s.enabled && s.birthdayPoints > 0
      ? `\n\nWe have added ${s.birthdayPoints.toLocaleString('en-IN')} points to your account as a gift. You now have {points} points.`
      : '';
    if (await makeCampaign(clientId, 'BIRTHDAY', `Birthday wishes, ${shortDate(day)}`, (s.birthdayText || DEFAULT_BIRTHDAY_TEXT) + gift, ids, s.birthdayMediaId ?? null)) out.birthdays = ids.length;
  }

  if (s.anniversaryWish) {
    const ids = (await prisma.customer.findMany({ where: { ...reachable(clientId), anniversary: { in: todays } }, select: { id: true } })).map(c => c.id);
    if (await makeCampaign(clientId, 'ANNIVERSARY', `Anniversary wishes, ${shortDate(day)}`, s.anniversaryText || DEFAULT_ANNIVERSARY_TEXT, ids, s.anniversaryMediaId ?? null)) out.anniversaries = ids.length;
  }

  // A week's notice: points lapse `expiryMonths` after the last purchase or use, so remind whoever's
  // lapse day falls exactly seven days from today.
  if (s.enabled && s.expiryReminder && s.expiryMonths > 0) {
    const from = new Date(now.getTime() + 7 * DAY);
    from.setMonth(from.getMonth() - s.expiryMonths);
    const to = new Date(from.getTime() + DAY);
    const ids = (await prisma.customer.findMany({
      where: { ...reachable(clientId), loyaltyPoints: { gt: 0 }, loyaltyActiveAt: { gte: from, lt: to } }, select: { id: true }
    })).map(c => c.id);
    const lapseDay = shortDate(localDayKey(new Date(now.getTime() + 7 * DAY), timezone));
    const text = `Hello {name}, your {points} points at {shop} (worth {points_value}) lapse on ${lapseDay}. Visit us before then to use them on your next purchase.`;
    if (await makeCampaign(clientId, 'POINTS_EXPIRING', `Points lapsing ${lapseDay}`, text, ids)) out.expiring = ids.length;
  }
  return out;
}

/** Every shop with loyalty or wishes switched on (or only `onlyClients`). */
export async function runDailyPrepare(now = new Date(), opts: { onlyClients?: string[]; ignoreHours?: boolean } = {}) {
  const shops = await prisma.loyaltySettings.findMany({
    where: {
      OR: [{ enabled: true }, { birthdayWish: true }, { anniversaryWish: true }],
      ...(opts.onlyClients ? { clientId: { in: opts.onlyClients } } : {})
    },
    select: { clientId: true }
  });
  const done: PrepareResult[] = [];
  for (const s of shops) {
    try {
      const r = await prepareShopDay(s.clientId, now, opts);
      if (r) done.push(r);
    } catch (e) {
      console.error('[campaigns] daily prepare failed for a shop:', (e as Error)?.message);
    }
  }
  return done;
}
