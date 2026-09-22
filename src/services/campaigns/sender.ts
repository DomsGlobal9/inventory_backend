/**
 * Hands campaign messages to WhatsApp, a few at a time. Run every couple of minutes by the
 * campaigns scheduler; safe to run twice at once, or on two servers.
 *
 * WHY SO SLOW. A shop's number is linked like WhatsApp Web, and a burst of messages from such a
 * number is what WhatsApp bans. The WhatsApp Service already spaces messages 4-9 s apart and caps a
 * number at 40 a day for its first two weeks and 200 after. On top of that, a campaign:
 *   - takes at most HALF of that daily allowance (20, then 100 a day), so bills, purchase orders and
 *     receipts pressed during the day always get through;
 *   - keeps at most IN_FLIGHT messages waiting at the service, so a bill pressed now is never stuck
 *     behind a hundred offers;
 *   - sends only between 10 am and 8 pm in the shop's own time -- nobody wants an offer at 11 pm.
 * A big campaign therefore takes days. The page says so before Start.
 *
 * EACH CUSTOMER ONCE. A recipient is claimed (WAITING -> HANDING) before the call, and the call's
 * key is the campaign and the customer, so a crash between the call and the write is repaired by
 * simply trying again: the service returns the same message.
 *
 * WHAT WAS FROZEN. The words, picture and link come from the campaign's snapshot (made at Start),
 * never from the draft or today's settings. Each customer's {link} is their own short link, made
 * before sending began (PREPARING); a customer whose link is somehow missing is not sent to.
 *
 * ONE OFFER IN 72 HOURS. Checked at each customer's turn, not at Start: a campaign can run for days,
 * and a customer offered something two days before Start may be free by the time their turn comes.
 */
import { prisma } from '../../lib/prisma';
import { getShopSettings } from '../../lib/clientSettings';
import { todayKey, startOfLocalDay } from '../../utils/businessDay';
import { sendShopText, shopNumber } from '../whatsapp/service';
import { WhatsAppServiceError } from '../whatsapp/client';
import { getSettings as loyaltySettings, rupeesOf, valueOf } from '../loyalty';
import { render } from './message';
import { markStopped } from './consent';
import { recentlyOffered } from './audience';
import { links } from '../links';
import type { Snapshot } from './campaign.service';

export const IN_FLIGHT = 3;
export const SEND_FROM_HOUR = 10;
export const SEND_UNTIL_HOUR = 20;
const NEW_NUMBER_DAYS = 14;
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** Campaign messages a day for a number linked at `linkedAt`: half the service's daily cap. */
export function dailyBudget(linkedAt: Date | null, now = new Date()): number {
  const settled = linkedAt && now.getTime() - linkedAt.getTime() >= NEW_NUMBER_DAYS * 86_400_000;
  return settled ? 100 : 20;
}

export function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(now);
  return Number(h) % 24;
}

export const withinSendingHours = (now: Date, timeZone: string) => {
  const h = localHour(now, timeZone);
  return h >= SEND_FROM_HOUR && h < SEND_UNTIL_HOUR;
};

type ShopResult = { clientId: string; handed: number; skipped: number; failed: number; waitingBecause?: string };

/**
 * One pass. `onlyClients` limits it to those shops -- the tests use it, because the development
 * database is the production one and a pass over every shop would send real shops' campaigns.
 * `ignoreHours` is for tests too.
 */
export async function runCampaignTick(now = new Date(), opts: { onlyClients?: string[]; ignoreHours?: boolean } = {}) {
  // Campaigns still making their links: finish those first (a later run carries on if it is big).
  const { prepareAll } = await import('./campaign.service');
  await prepareAll({ onlyClients: opts.onlyClients }).catch(e => console.error('[campaigns] preparing links failed:', (e as Error)?.message));

  // A claim left by a crash goes back in the queue; its key makes the retry safe.
  await prisma.campaignRecipient.updateMany({
    where: { state: 'HANDING', handedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) }, ...(opts.onlyClients ? { clientId: { in: opts.onlyClients } } : {}) },
    data: { state: 'WAITING', handedAt: null }
  });

  const sending = await prisma.campaign.findMany({
    where: {
      status: 'SENDING',
      OR: [{ startAt: null }, { startAt: { lte: now } }],
      ...(opts.onlyClients ? { clientId: { in: opts.onlyClients } } : {})
    },
    orderBy: { startedAt: 'asc' },
    select: { id: true, clientId: true }
  });
  const shops = [...new Set(sending.map(c => c.clientId))];
  const results: ShopResult[] = [];
  for (const clientId of shops) {
    try {
      results.push(await runShop(clientId, sending.filter(c => c.clientId === clientId).map(c => c.id), now, !!opts.ignoreHours));
    } catch (e) {
      console.error('[campaigns] a shop failed:', (e as Error)?.message);
    }
  }
  await finishDone(opts.onlyClients);
  return results;
}

async function runShop(clientId: string, campaignIds: string[], now: Date, ignoreHours: boolean): Promise<ShopResult> {
  const res: ShopResult = { clientId, handed: 0, skipped: 0, failed: 0 };
  const { timezone, businessName } = await getShopSettings(clientId);
  if (!ignoreHours && !withinSendingHours(now, timezone)) return { ...res, waitingBecause: 'hours' };

  let account;
  try { account = await shopNumber(clientId); } catch { return { ...res, waitingBecause: 'unreachable' }; }
  if (account.status !== 'CONNECTED') return { ...res, waitingBecause: 'not_connected' };

  const budget = dailyBudget(account.linkedAt ? new Date(account.linkedAt) : null, now);
  const [handedToday, inFlight] = await Promise.all([
    prisma.campaignRecipient.count({ where: { clientId, state: { in: ['HANDED', 'HANDING'] }, handedAt: { gte: startOfLocalDay(todayKey(timezone), timezone) } } }),
    prisma.whatsAppMessage.count({ where: { clientId, kind: 'CAMPAIGN', status: { in: ['QUEUED', 'SENDING'] }, createdAt: { gte: new Date(now.getTime() - 86_400_000) } } })
  ]);
  let room = Math.min(budget - handedToday, IN_FLIGHT - inFlight);
  if (room <= 0) return { ...res, waitingBecause: handedToday >= budget ? 'daily_budget' : 'in_flight' };

  const loyalty = await loyaltySettings(clientId);
  const shop = businessName || 'our shop';

  for (const campaignId of campaignIds) {
    if (room <= 0) break;
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, status: 'SENDING' }, select: { id: true, text: true, source: true, snapshot: true } });
    if (!campaign) continue;
    // Started before snapshots existed: its words as they were, no picture, no link.
    const snap = (campaign.snapshot ?? null) as unknown as Snapshot | null;
    const words = snap?.text ?? campaign.text;
    const imageUrl = snap?.media?.url ?? null;
    const hasLink = !!snap?.link;
    const offer = campaign.source === 'MANUAL';
    const next = await prisma.campaignRecipient.findMany({
      // A few spare, so customers skipped on the way do not leave the room unused.
      where: { campaignId, state: 'WAITING' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: room + 20, select: { id: true, customerId: true, linkCode: true }
    });
    // Asked once for this handful, not once per customer.
    const offeredRecently = offer ? await recentlyOffered(clientId, now, { exceptCampaignId: campaignId, customerIds: next.map(r => r.customerId) }) : new Set<string>();
    for (const r of next) {
      if (room <= 0) break;
      const claimed = await prisma.campaignRecipient.updateMany({ where: { id: r.id, state: 'WAITING' }, data: { state: 'HANDING', handedAt: now } });
      if (claimed.count === 0) continue;

      // Checked again now, not when the campaign started: they may have said STOP since.
      const c = await prisma.customer.findFirst({
        where: { id: r.customerId, clientId },
        select: { name: true, phone: true, deletedAt: true, status: true, whatsappOffers: true, whatsappStoppedAt: true, loyaltyPoints: true }
      });
      const skip: [string, string] | null = !c || c.deletedAt ? ['DELETED', 'The customer was deleted.']
        : c.whatsappStoppedAt ? ['OPTED_OUT', 'The customer replied STOP.']
        : !c.whatsappOffers ? ['NO_CONSENT', 'The customer no longer agrees to offers.']
        : !c.phone ? ['NO_PHONE', 'The customer has no phone number.']
        : c.status !== 'ACTIVE' ? ['INACTIVE', 'The customer is not active.']
        : offeredRecently.has(r.customerId) ? ['RECENT_OFFER', 'Had an offer from the shop in the last 3 days.']
        : null;
      if (skip) {
        await prisma.campaignRecipient.update({ where: { id: r.id }, data: { state: 'SKIPPED', skipCode: skip[0], skipReason: skip[1], handedAt: null } });
        res.skipped += 1;
        continue;
      }

      let link: string | null = null;
      if (hasLink) {
        // Never without the link: back to making links, and nobody else in this campaign goes now.
        if (!r.linkCode || !links.available()) {
          await prisma.campaignRecipient.update({ where: { id: r.id }, data: { state: 'WAITING', handedAt: null } });
          if (!r.linkCode) await prisma.campaign.updateMany({ where: { id: campaign.id, status: 'SENDING' }, data: { status: 'PREPARING' } });
          break;
        }
        link = links.shortUrl(r.linkCode);
      }

      const text = render(words, {
        name: c!.name, shop: snap?.shopName ?? shop, points: c!.loyaltyPoints, pointsValue: rupeesOf(valueOf(Math.max(0, c!.loyaltyPoints), loyalty)), link
      });
      try {
        const row = await sendShopText({
          clientId, to: c!.phone!.replace(/^\+/, ''), text, kind: 'CAMPAIGN', referenceId: campaign.id,
          idempotencyKey: `CAMPAIGN:${campaign.id}:${r.customerId}`, sentBy: null,
          imageUrl, linkPreview: hasLink && !imageUrl
        });
        await prisma.campaignRecipient.update({ where: { id: r.id }, data: { state: 'HANDED', messageId: row.id, handedAt: now } });
        res.handed += 1;
        room -= 1;
      } catch (e) {
        // "The request is not valid" is the service refusing what WE sent -- e.g. a WhatsApp Service not
        // yet updated to know campaign messages. Not the customer's fault: they wait their turn again.
        if (e instanceof WhatsAppServiceError && e.statusCode < 500 && !/request is not valid/i.test(e.message)) {
          if (/STOP/.test(e.message)) await markStopped(clientId, c!.phone!);
          await prisma.campaignRecipient.update({ where: { id: r.id }, data: { state: 'FAILED', skipCode: /STOP/.test(e.message) ? 'OPTED_OUT' : 'REFUSED', skipReason: e.message, handedAt: null } });
          res.failed += 1;
          continue;
        }
        // WhatsApp down or the number dropped: put it back, and leave this shop for now.
        await prisma.campaignRecipient.update({ where: { id: r.id }, data: { state: 'WAITING', handedAt: null } });
        return { ...res, waitingBecause: 'unreachable' };
      }
    }
  }
  return res;
}

/** A sending campaign with nobody left to hand over is done. */
async function finishDone(onlyClients?: string[]) {
  const open = await prisma.campaign.findMany({
    where: { status: 'SENDING', ...(onlyClients ? { clientId: { in: onlyClients } } : {}) },
    select: { id: true }
  });
  for (const c of open) {
    const left = await prisma.campaignRecipient.count({ where: { campaignId: c.id, state: { in: ['WAITING', 'HANDING'] } } });
    if (left === 0) await prisma.campaign.updateMany({ where: { id: c.id, status: 'SENDING' }, data: { status: 'DONE', finishedAt: new Date() } });
  }
}
