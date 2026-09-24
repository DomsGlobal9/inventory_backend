/**
 * WhatsApp campaigns: one message to many customers, from the shop's own number.
 *
 * The rules that matter, in one place:
 *
 * ONLY PEOPLE WHO AGREED. A campaign reaches customers recorded as agreeing to offers, never anyone
 * who replied STOP (audience.ts). Every message ends with the STOP line (message.ts).
 *
 * SLOWLY, TO KEEP THE NUMBER SAFE. The shop's number is a normal WhatsApp number linked like
 * WhatsApp Web. Hundreds of messages at once is exactly what gets such a number banned -- and then
 * the shop loses its bills and purchase orders too. So a campaign never hands everything over at
 * once. The sender (sender.ts) gives WhatsApp a few at a time, only between 10 am and 8 pm shop
 * time, and at most half of the number's daily allowance, so bills always have room.
 *
 * ONE OFFER IN 72 HOURS. A customer gets at most one campaign message from a shop in any 72 hours;
 * a later campaign skips them if their turn comes inside that time (audience.recentlyOffered).
 *
 * FIXED WHEN STARTED. Pressing Start writes the list of customers and freezes what is sent -- words,
 * picture, link -- into the campaign's snapshot. Somebody who agrees later is not added; somebody who
 * replies STOP, or is deleted, before their turn is skipped with the reason.
 *
 * NO MESSAGE WITHOUT ITS LINK. A campaign with a link first makes every customer's short link
 * (PREPARING), and only then starts sending. If making them fails, it waits and tries again.
 *
 * ONCE PER CUSTOMER. The message key is the campaign and the customer, so a retry, a restart or
 * two servers never send the same person the same campaign twice.
 */
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, forbidden, notFound } from '../../utils/httpError';
import { grants, holdsEverything } from '../../config/permissions';
import { getShopSettings } from '../../lib/clientSettings';
import { normalisePhone } from '../../lib/phone';
import { getSettings as loyaltySettings, rupeesOf, valueOf } from '../loyalty';
import { shopNumber } from '../whatsapp/service';
import { whatsappClient, whatsappConfigured, WhatsAppServiceError } from '../whatsapp/client';
import { links, newRecipientRef, LinkRuleError } from '../links';
import { checkAudience, describeAudience, preview as previewAudience, whereFor, Audience } from './audience';
import { checkCaption, checkLinkPlacement, checkName, checkText, render } from './message';
import { checkCampaignLink, shopPhone, shortLinkLength, storedLink, type CampaignLink } from './link';
import { fromProductImage, fromUpload, mediaView, ownMedia } from './media';
import { dailyBudget } from './sender';

export type Actor = { id: string; clientId: string; name?: string | null; permissions?: string[]; roles?: string[] };
const may = (a: Actor, key: string) => holdsEverything(a.permissions, a.roles) || grants(a.permissions ?? [], key);
function requireMay(a: Actor, key: 'campaign:view' | 'campaign:send') {
  if (!may(a, key)) {
    throw forbidden(key === 'campaign:send'
      ? 'Sending campaigns is not part of your role. Ask the owner.'
      : 'Campaigns are not part of your role. Ask the owner.');
  }
}

export const MAX_RECIPIENTS = 5000;
/** Links are made in batches this size while PREPARING. */
export const LINK_BATCH = 500;
export const LINK_OWNER = 'campaigns';

/** What was frozen at Start. */
export interface Snapshot {
  text: string;
  media: { id: string; url: string; width: number; height: number } | null;
  link: CampaignLink | null;
  shopName: string;
  frozenAt: string;
}

export function storedSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Snapshot;
  return typeof s.text === 'string' ? s : null;
}

const withMedia = { media: { select: { id: true, url: true, width: true, height: true, byteSize: true } } } as const;

async function find(clientId: string, id: string) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Campaign not found');
  const c = await prisma.campaign.findFirst({ where: { id, clientId }, include: withMedia });
  if (!c) throw notFound('Campaign not found');
  return c;
}

/** How far a campaign has got, from its recipients and their WhatsApp ticks. */
async function statsFor(campaignIds: string[]) {
  const out = new Map<string, Record<string, number>>();
  if (campaignIds.length === 0) return out;
  const rows = await prisma.$queryRaw<{ campaign_id: string; bucket: string; n: bigint }[]>`
    SELECT r.campaign_id,
           CASE WHEN r.state = 'HANDED' THEN COALESCE(m.status, 'QUEUED') ELSE r.state END AS bucket,
           COUNT(*) AS n
      FROM campaign_recipients r
      LEFT JOIN whatsapp_messages m ON m.id = r.message_id
     WHERE r.campaign_id IN (${Prisma.join(campaignIds)})
     GROUP BY 1, 2`;
  for (const r of rows) {
    const s = out.get(r.campaign_id) ?? {};
    s[r.bucket] = Number(r.n);
    out.set(r.campaign_id, s);
  }
  return out;
}

function summarise(s: Record<string, number> = {}) {
  const n = (k: string) => s[k] ?? 0;
  const read = n('READ');
  const delivered = n('DELIVERED') + read;
  const sent = n('SENT') + delivered;
  const failed = n('FAILED') + n('EXPIRED');
  const waiting = n('WAITING') + n('HANDING') + n('QUEUED') + n('SENDING');
  const skipped = n('SKIPPED');
  return { total: Object.values(s).reduce((a, b) => a + b, 0), waiting, sent, delivered, read, failed, skipped };
}

/** The link as the editor shows it again; the address is the shop's own, nothing private. */
const linkView = (l: CampaignLink | null) => (l ? { type: l.type, target: l.target, days: l.days, phone: l.phone ?? null, chatText: l.chatText ?? null } : null);

function view(c: any, stats?: Record<string, number>) {
  const audience = (c.audience ?? {}) as Audience;
  const snapshot = storedSnapshot(c.snapshot);
  return {
    id: c.id, name: c.name, text: c.text, status: c.status, source: c.source,
    audience, audienceText: describeAudience(audience),
    media: c.media ? mediaView(c.media) : null,
    link: linkView(storedLink(c.link)),
    // What went out, once started: the page shows this rather than today's settings.
    sent: snapshot ? { text: snapshot.text, media: snapshot.media, link: linkView(snapshot.link), shopName: snapshot.shopName, frozenAt: snapshot.frozenAt } : null,
    prepareError: c.prepareError ?? null,
    startAt: c.startAt, startedAt: c.startedAt, finishedAt: c.finishedAt, createdAt: c.createdAt,
    progress: summarise(stats)
  };
}

export async function list(actor: Actor, input: { source?: unknown } = {}) {
  requireMay(actor, 'campaign:view');
  const auto = input.source === 'AUTO';
  const rows = await prisma.campaign.findMany({
    where: { clientId: actor.clientId, source: auto ? { not: 'MANUAL' } : 'MANUAL' },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: withMedia
  });
  const stats = await statsFor(rows.map(r => r.id));
  // Taps for the whole list in one query: the list is where an owner looks to see whether last
  // week's offer worked, and "sent 300" without "42 tapped" is the half of that they came for.
  // Which campaigns count is the same test the campaign page uses -- the frozen snapshot, not
  // today's draft settings -- so the two screens can never disagree about one campaign. A draft
  // has no snapshot and no links, so it rightly says nothing about taps rather than zero.
  const withLinks = rows.filter(r => !!storedSnapshot(r.snapshot)?.link).map(r => r.id);
  const linkStats = await links.statsForMany(actor.clientId, LINK_OWNER, withLinks);
  return rows.map(r => {
    const v = view(r, stats.get(r.id));
    const ls = linkStats.get(r.id);
    return { ...v, progress: { ...v.progress, tapped: ls?.tapped ?? null, taps: ls?.totalTaps ?? null } };
  });
}

/** Why customers were not sent it, counted: "12 not sent: number not on WhatsApp". */
async function reasonsFor(campaignId: string) {
  const rows = await prisma.$queryRaw<{ code: string | null; reason: string | null; n: bigint }[]>`
    SELECT COALESCE(r.skip_code, m.fail_code, 'OTHER') AS code, MIN(COALESCE(r.skip_reason, m.fail_reason)) AS reason, COUNT(*) AS n
      FROM campaign_recipients r
      LEFT JOIN whatsapp_messages m ON m.id = r.message_id
     WHERE r.campaign_id = ${campaignId}
       AND (r.state IN ('SKIPPED', 'FAILED') OR m.status IN ('FAILED', 'EXPIRED'))
     GROUP BY 1
     ORDER BY 3 DESC`;
  return rows.map(r => ({ code: r.code ?? 'OTHER', reason: r.reason, count: Number(r.n) }));
}

export async function get(actor: Actor, id: string) {
  requireMay(actor, 'campaign:view');
  const c = await find(actor.clientId, id);
  const stats = await statsFor([c.id]);
  const recipients = await prisma.$queryRaw<{ id: string; customer_id: string; name: string | null; phone: string | null; state: string; skip_reason: string | null; status: string | null; fail_reason: string | null; handed_at: Date | null; link_ref: string | null }[]>`
    SELECT r.id, r.customer_id, c.name, c.phone, r.state, r.skip_reason, m.status, m.fail_reason, r.handed_at, r.link_ref
      FROM campaign_recipients r
      JOIN customers c ON c.id = r.customer_id
      LEFT JOIN whatsapp_messages m ON m.id = r.message_id
     WHERE r.campaign_id = ${c.id}
     ORDER BY r.handed_at DESC NULLS LAST, c.name ASC
     LIMIT 500`;
  const hasLinks = !!storedSnapshot(c.snapshot)?.link;
  const owner = { module: LINK_OWNER, ref: c.id };
  const [linkStats, taps, reasons, switchedOff] = await Promise.all([
    hasLinks ? links.statsFor(actor.clientId, owner) : null,
    hasLinks ? links.tapsByRecipient(actor.clientId, owner, recipients.map(r => r.link_ref).filter((x): x is string => !!x)) : new Map(),
    c.status === 'DRAFT' ? [] : reasonsFor(c.id),
    hasLinks ? links.switchedOffByShop(actor.clientId, owner) : false
  ]);
  const v = view(c, stats.get(c.id));
  return {
    ...v,
    // The shop switched this campaign's links off (the page offers "Switch links on" instead).
    linksOff: switchedOff,
    // Customers who opened their link at least once (each has their own), and every open by a person.
    progress: { ...v.progress, tapped: linkStats?.tapped ?? null, taps: linkStats?.totalTaps ?? null },
    notSent: reasons,
    recipients: recipients.map(r => ({
      id: r.id,
      customerId: r.customer_id,
      name: r.name,
      phone: r.phone ? `••••${r.phone.slice(-4)}` : null,
      state: r.state === 'HANDED' ? (r.status ?? 'QUEUED') : r.state,
      reason: r.skip_reason ?? r.fail_reason ?? null,
      at: r.handed_at,
      tapped: r.link_ref ? (taps.get(r.link_ref)?.tapCount ?? 0) : null
    }))
  };
}

function startAtOf(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw badRequest('That start time is not a date and time.');
  if (d.getTime() > Date.now() + 90 * 86_400_000) throw badRequest('Start a campaign within the next 90 days.');
  return d;
}

const shopNameOf = async (clientId: string) => (await getShopSettings(clientId)).businessName || 'our shop';

/** Words, picture and link that belong together, checked as one. */
async function checkContent(clientId: string, text: string, mediaId: string | null, link: CampaignLink | null) {
  checkLinkPlacement(text, !!link);
  if (mediaId) checkCaption(text, await shopNameOf(clientId), link ? shortLinkLength() : 0);
}

export async function create(actor: Actor, input: Record<string, unknown>) {
  requireMay(actor, 'campaign:send');
  const name = checkName(input.name);
  const text = checkText(input.text);
  const media = await ownMedia(actor.clientId, input.mediaId);
  const link = await checkCampaignLink(actor.clientId, input.link, { campaignName: name });
  await checkContent(actor.clientId, text, media?.id ?? null, link);
  const c = await prisma.campaign.create({
    data: {
      clientId: actor.clientId,
      name,
      text,
      audience: checkAudience(input.audience) as Prisma.InputJsonValue,
      startAt: startAtOf(input.startAt),
      mediaId: media?.id ?? null,
      link: (link ?? Prisma.DbNull) as any,
      createdById: actor.id
    },
    include: withMedia
  });
  return view(c);
}

export async function update(actor: Actor, id: string, input: Record<string, unknown>) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.status !== 'DRAFT') throw conflict('This campaign has started, so its words and customers are fixed. Make a copy to change them.');
  const data: Prisma.CampaignUncheckedUpdateInput = {};
  const name = input.name !== undefined ? checkName(input.name) : c.name;
  const text = input.text !== undefined ? checkText(input.text) : c.text;
  if (input.name !== undefined) data.name = name;
  if (input.text !== undefined) data.text = text;
  if (input.audience !== undefined) data.audience = checkAudience(input.audience) as Prisma.InputJsonValue;
  if (input.startAt !== undefined) data.startAt = startAtOf(input.startAt);
  let mediaId = c.mediaId;
  if (input.mediaId !== undefined) { mediaId = (await ownMedia(actor.clientId, input.mediaId))?.id ?? null; data.mediaId = mediaId; }
  let link = storedLink(c.link);
  if (input.link !== undefined) { link = await checkCampaignLink(actor.clientId, input.link, { campaignName: name }); data.link = (link ?? Prisma.DbNull) as any; }
  await checkContent(actor.clientId, text, mediaId, link);
  const r = await prisma.campaign.updateMany({ where: { id: c.id, clientId: actor.clientId, status: 'DRAFT' }, data: data as any });
  if (r.count === 0) throw conflict('This campaign has just been started by somebody else.');
  return get(actor, c.id);
}

export async function remove(actor: Actor, id: string) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.status !== 'DRAFT') throw conflict('Only a campaign that was never started can be deleted. Stop it instead.');
  await prisma.campaign.deleteMany({ where: { id: c.id, clientId: actor.clientId, status: 'DRAFT' } });
  return { deleted: true };
}

/** A new draft with the same words, picture, link and customers' description. */
export async function copy(actor: Actor, id: string) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.source !== 'MANUAL') throw badRequest('Automatic messages cannot be copied. Change their words in Loyalty settings.');
  // A started campaign copies what it SENT; a draft copies itself.
  const s = storedSnapshot(c.snapshot);
  const made = await prisma.campaign.create({
    data: {
      clientId: actor.clientId, name: `${c.name} (copy)`.slice(0, 80), text: s?.text ?? c.text,
      audience: c.audience as Prisma.InputJsonValue, createdById: actor.id,
      mediaId: s ? s.media?.id ?? null : c.mediaId,
      link: ((s ? s.link : storedLink(c.link)) ?? Prisma.DbNull) as any
    },
    include: withMedia
  });
  return view(made);
}

export async function preview(actor: Actor, audience: unknown) {
  requireMay(actor, 'campaign:view');
  return previewAudience(actor.clientId, checkAudience(audience));
}

/** What the page needs beside the list: is WhatsApp ready, how fast a campaign can go, and what it may carry. */
export async function overview(actor: Actor) {
  requireMay(actor, 'campaign:view');
  let whatsapp: { status: string; linkedAt: string | null } | null = null;
  let problem: string | null = null;
  let picture = false;
  if (!whatsappConfigured()) problem = 'WhatsApp sending is not set up for ScaleEzy yet.';
  else {
    try { const n = await shopNumber(actor.clientId); whatsapp = { status: n.status, linkedAt: n.linkedAt }; }
    catch (e) { problem = e instanceof WhatsAppServiceError ? e.message : 'WhatsApp could not be reached just now.'; }
    // Pictures only once the live WhatsApp Service says it can send them.
    picture = await whatsappClient.capabilities().then(c => !!c.image).catch(() => false);
  }
  const [agreed, withPhone, stopped, phone] = await Promise.all([
    prisma.customer.count({ where: { clientId: actor.clientId, deletedAt: null, whatsappOffers: true, whatsappStoppedAt: null, phone: { not: null } } }),
    prisma.customer.count({ where: { clientId: actor.clientId, deletedAt: null, phone: { not: null } } }),
    prisma.customer.count({ where: { clientId: actor.clientId, deletedAt: null, whatsappStoppedAt: { not: null } } }),
    shopPhone(actor.clientId)
  ]);
  const linkedAt = whatsapp?.linkedAt ? new Date(whatsapp.linkedAt) : null;
  return {
    whatsapp, problem,
    perDay: dailyBudget(linkedAt),
    hours: '10 am to 8 pm',
    customers: { withPhone, agreed, stopped },
    canSend: may(actor, 'campaign:send'),
    features: { picture, link: links.available(), shopPhone: phone }
  };
}

// ── Pictures ──────────────────────────────────────────────────────────────────────────────

export async function uploadMedia(actor: Actor, input: { base64?: unknown }) {
  requireMay(actor, 'campaign:send');
  return fromUpload(actor.clientId, actor.id, input.base64);
}

export async function mediaFromProduct(actor: Actor, input: { productImageId?: unknown }) {
  requireMay(actor, 'campaign:send');
  return fromProductImage(actor.clientId, actor.id, input.productImageId);
}

/** The shop's products that have photos, for choosing a campaign picture. Names and photos only. */
export async function productPhotos(actor: Actor, search: unknown) {
  requireMay(actor, 'campaign:send');
  const q = typeof search === 'string' ? search.trim().slice(0, 80) : '';
  const rows = await prisma.product.findMany({
    where: {
      clientId: actor.clientId,
      status: { notIn: ['ARCHIVED', 'TRASHED'] },
      images: { some: {} },
      ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { productCode: { contains: q, mode: 'insensitive' } }] } : {})
    },
    // No `take` on the photographs any more, and six distinct ones kept below instead.
    // One photograph of a colour is registered against every size of that colour, so a saree in
    // three sizes gave the same picture three times -- and six rows could be two pictures shown
    // three times each. 24 products x a handful of photographs is a small read.
    select: { id: true, title: true, images: { select: { id: true, url: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }, { createdAt: 'asc' }] } },
    orderBy: { updatedAt: 'desc' },
    take: 24
  });
  return rows.map(p => {
    const seen = new Set<string>();
    const images = p.images.filter(i => !seen.has(i.url) && seen.add(i.url)).slice(0, 6);
    return { id: p.id, title: p.title, images: images.map(i => ({ id: i.id, url: i.url })) };
  });
}

// ── Start, and making the links ───────────────────────────────────────────────────────────

/**
 * Start: the customers are written now and what is sent is frozen. `expected` is the count the person
 * was shown; if the list has changed a lot since, they are asked to look again.
 */
export async function start(actor: Actor, id: string, input: { expected?: unknown } = {}) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.status !== 'DRAFT') throw conflict('This campaign has already been started.');
  const link = storedLink(c.link);
  if (link && !links.available()) throw conflict('Links in campaigns are switched off on ScaleEzy just now, so this cannot start. Take the link out, or try later.');
  const shopName = await shopNameOf(actor.clientId);
  // Checked again: the shop's name may have grown since the draft was saved.
  checkLinkPlacement(c.text, !!link);
  if (c.media) checkCaption(c.text, shopName, link ? shortLinkLength() : 0);

  const where = await whereFor(actor.clientId, c.audience as Audience);
  const customers = await prisma.customer.findMany({ where, select: { id: true }, take: MAX_RECIPIENTS + 1 });
  if (customers.length === 0) throw badRequest('Nobody matches these choices yet. Only customers who agreed to offers on WhatsApp can be sent a campaign.');
  if (customers.length > MAX_RECIPIENTS) throw badRequest(`A campaign can reach at most ${MAX_RECIPIENTS.toLocaleString('en-IN')} customers. Narrow the choices.`);
  if (typeof input.expected === 'number' && Math.abs(input.expected - customers.length) > Math.max(5, input.expected * 0.1)) {
    throw Object.assign(conflict(`This now reaches ${customers.length} customers, not ${input.expected}. Check the list and press Start again.`), {
      details: { code: 'AUDIENCE_CHANGED', count: customers.length }
    });
  }
  const now = new Date();
  const snapshot: Snapshot = {
    text: c.text,
    media: c.media ? { id: c.media.id, url: c.media.url, width: c.media.width, height: c.media.height } : null,
    link,
    shopName,
    frozenAt: now.toISOString()
  };
  await prisma.$transaction(async tx => {
    const claimed = await tx.campaign.updateMany({
      where: { id: c.id, clientId: actor.clientId, status: 'DRAFT' },
      data: { status: link ? 'PREPARING' : 'SENDING', startedAt: now, snapshot: snapshot as unknown as Prisma.InputJsonValue, prepareError: null }
    });
    if (claimed.count === 0) throw conflict('This campaign has just been started by somebody else.');
    await tx.campaignRecipient.createMany({
      data: customers.map(cu => ({ campaignId: c.id, clientId: actor.clientId, customerId: cu.id, linkRef: link ? newRecipientRef() : null })),
      skipDuplicates: true
    });
  }, { timeout: 30000, maxWait: 15000 });
  // Most campaigns are small: their links are made straight away, and the scheduler finishes any that are not.
  if (link) await prepareLinks(c.id).catch(e => console.error('[campaigns] making links at start failed:', (e as Error)?.message));
  return get(actor, c.id);
}

/**
 * PREPARING: make each customer's short link, in batches, then start sending. Safe to run twice or
 * on two servers: making links is idempotent (same customer, same link), and the move to SENDING
 * happens once, only when nobody is left without a link. A failure is written down and tried again
 * on the next run; nothing is ever sent without its link.
 */
export async function prepareLinks(campaignId: string, opts: { maxBatches?: number } = {}): Promise<'SENDING' | 'PREPARING' | 'GONE'> {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, status: 'PREPARING' }, select: { id: true, clientId: true, snapshot: true, createdById: true } });
  if (!c) return 'GONE';
  const link = storedSnapshot(c.snapshot)?.link;
  if (!link) {
    await prisma.campaign.updateMany({ where: { id: c.id, status: 'PREPARING' }, data: { status: 'SENDING', prepareError: null } });
    return 'SENDING';
  }
  try {
    for (let batch = 0; batch < (opts.maxBatches ?? 20); batch++) {
      const todo = await prisma.campaignRecipient.findMany({
        where: { campaignId: c.id, linkRef: { not: null }, linkCode: null },
        select: { id: true, linkRef: true },
        orderBy: { id: 'asc' },
        take: LINK_BATCH
      });
      if (todo.length === 0) break;
      const made = await links.makeLinks({
        clientId: c.clientId,
        owner: { module: LINK_OWNER, ref: c.id },
        links: todo.map(r => ({ recipientRef: r.linkRef!, targetType: link.type, target: link.target })),
        days: link.days,
        createdById: c.createdById
      });
      const values = todo.map((r, i) => Prisma.sql`(${r.id}, ${made[i].code})`);
      await prisma.$executeRaw`
        UPDATE campaign_recipients AS r SET link_code = v.code
          FROM (VALUES ${Prisma.join(values)}) AS v(id, code)
         WHERE r.id = v.id AND r.link_code IS NULL`;
    }
    const left = await prisma.campaignRecipient.count({ where: { campaignId: c.id, linkRef: { not: null }, linkCode: null } });
    if (left > 0) return 'PREPARING';
    await prisma.campaign.updateMany({ where: { id: c.id, status: 'PREPARING' }, data: { status: 'SENDING', prepareError: null } });
    return 'SENDING';
  } catch (e) {
    const why = e instanceof LinkRuleError ? e.message : 'The links could not all be made just now. ScaleEzy tries again every few minutes.';
    await prisma.campaign.updateMany({ where: { id: c.id, status: 'PREPARING' }, data: { prepareError: why } });
    console.error('[campaigns] making links failed:', (e as Error)?.message);
    return 'PREPARING';
  }
}

/** Every campaign still making links (or only `onlyClients`'). Run by the scheduler. */
export async function prepareAll(opts: { onlyClients?: string[] } = {}) {
  const waiting = await prisma.campaign.findMany({
    where: { status: 'PREPARING', ...(opts.onlyClients ? { clientId: { in: opts.onlyClients } } : {}) },
    select: { id: true },
    orderBy: { startedAt: 'asc' },
    take: 20
  });
  const out: Record<string, string> = {};
  for (const w of waiting) out[w.id] = await prepareLinks(w.id);
  return out;
}

export async function pause(actor: Actor, id: string) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.status === 'PREPARING') throw conflict('It is still getting its links ready. Pause it once it is sending, or stop it.');
  const r = await prisma.campaign.updateMany({ where: { id: c.id, clientId: actor.clientId, status: 'SENDING' }, data: { status: 'PAUSED' } });
  if (r.count === 0) throw conflict(c.status === 'PAUSED' ? 'This campaign is already paused.' : 'Only a campaign that is sending can be paused.');
  return get(actor, c.id);
}

export async function resume(actor: Actor, id: string) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  const r = await prisma.campaign.updateMany({ where: { id: c.id, clientId: actor.clientId, status: 'PAUSED' }, data: { status: 'SENDING' } });
  if (r.count === 0) throw conflict('Only a paused campaign can carry on.');
  return get(actor, c.id);
}

/** Stop for good. Messages already handed to WhatsApp still go; the rest are never sent. */
export async function cancel(actor: Actor, id: string) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.status === 'DONE' || c.status === 'CANCELLED') throw conflict('This campaign has already finished.');
  await prisma.$transaction([
    prisma.campaign.updateMany({ where: { id: c.id, clientId: actor.clientId }, data: { status: 'CANCELLED', finishedAt: new Date() } }),
    prisma.campaignRecipient.updateMany({ where: { campaignId: c.id, state: 'WAITING' }, data: { state: 'SKIPPED', skipReason: 'The campaign was stopped.', skipCode: 'CAMPAIGN_STOPPED' } })
  ]);
  return get(actor, c.id);
}

/** Switch every link of a campaign off (a wrong price, a wrong page) -- or on again. */
export async function setLinks(actor: Actor, id: string, on: boolean) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  const owner = { module: LINK_OWNER, ref: c.id };
  const r = on ? await links.enableForOwner(actor.clientId, owner) : await links.disableForOwner(actor.clientId, owner, actor.id);
  return { ...r, campaign: await get(actor, c.id) };
}

// ── Test ──────────────────────────────────────────────────────────────────────────────────

/** The words as a customer will read them, filled in for somebody. */
export async function personalise(clientId: string, text: string, customer: { name: string | null; loyaltyPoints: number }, link: string | null = null) {
  const [{ businessName }, s] = await Promise.all([getShopSettings(clientId), loyaltySettings(clientId)]);
  return render(text, {
    name: customer.name,
    shop: businessName || 'our shop',
    points: customer.loyaltyPoints,
    pointsValue: rupeesOf(valueOf(Math.max(0, customer.loyaltyPoints), s)),
    link
  });
}

/**
 * "Send me a test": exactly what customers get -- the picture, the words, a real short link -- filled
 * in with the sender's own name, to a number the person types (their own phone, usually). The test's
 * link is marked as a test: its taps are not counted in the campaign, and a test never counts towards
 * a customer's one offer in 72 hours. Only for those who may send campaigns.
 */
export async function sendTest(actor: Actor, input: { text?: unknown; campaignId?: unknown; to?: unknown; mediaId?: unknown; link?: unknown; name?: unknown }) {
  requireMay(actor, 'campaign:send');
  let text: string;
  let mediaUrl: string | null;
  let link: CampaignLink | null;
  let ref: string;
  if (input.campaignId) {
    const c = await find(actor.clientId, String(input.campaignId));
    const s = storedSnapshot(c.snapshot);
    text = s?.text ?? c.text;
    mediaUrl = s ? s.media?.url ?? null : c.media?.url ?? null;
    link = s ? s.link : storedLink(c.link);
    ref = c.id;
  } else {
    // The editor's words, not saved yet.
    text = checkText(input.text);
    mediaUrl = (await ownMedia(actor.clientId, input.mediaId))?.url ?? null;
    link = await checkCampaignLink(actor.clientId, input.link, { campaignName: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'this offer' });
    checkLinkPlacement(text, !!link);
    if (mediaUrl) checkCaption(text, await shopNameOf(actor.clientId), link ? shortLinkLength() : 0);
    ref = 'test';
  }
  const typed = typeof input.to === 'string' ? input.to.trim() : '';
  if (!typed) throw badRequest('Type the WhatsApp number to send the test to, for example your own.');
  const phone = normalisePhone(typed);
  if (!phone.ok) throw badRequest(phone.reason);
  const to = phone.value.replace(/^\+/, '');
  const n = await shopNumber(actor.clientId);
  if (n.status !== 'CONNECTED') throw badRequest("Link the shop's WhatsApp in Settings → WhatsApp first. The test goes from that number.");

  let short: string | null = null;
  if (link) {
    const [made] = await links.makeLinks({
      clientId: actor.clientId, owner: { module: LINK_OWNER, ref }, isTest: true, days: 7, createdById: actor.id,
      links: [{ recipientRef: newRecipientRef(), targetType: link.type, target: link.target }]
    }).catch(e => { throw e instanceof LinkRuleError ? badRequest(e.message) : e; });
    short = made.shortUrl;
  }
  const body = await personalise(actor.clientId, text, { name: actor.name ?? null, loyaltyPoints: 250 }, short);
  const sent = await whatsappClient.send({
    from: { clientId: actor.clientId },
    to,
    text: `[Test] ${body}`,
    ...(mediaUrl ? { image: { url: mediaUrl } } : {}),
    ...(!mediaUrl && short ? { linkPreview: true } : {}),
    kind: 'TEST',
    reference: 'CAMPAIGN_TEST',
    idempotencyKey: `CAMPAIGN_TEST:${actor.clientId}:${crypto.randomUUID()}`
  });
  return { sent: true, status: sent.status, to: `••••${to.slice(-4)}`, link: short };
}
