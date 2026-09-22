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
 * FIXED WHEN STARTED. Pressing Start writes the list of customers. Somebody who agrees later is not
 * added; somebody who replies STOP, or is deleted, before their turn is skipped with the reason.
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
import { checkAudience, describeAudience, preview as previewAudience, whereFor, Audience } from './audience';
import { checkName, checkText, render } from './message';
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

async function find(clientId: string, id: string) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Campaign not found');
  const c = await prisma.campaign.findFirst({ where: { id, clientId } });
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

function view(c: any, stats?: Record<string, number>) {
  const audience = (c.audience ?? {}) as Audience;
  return {
    id: c.id, name: c.name, text: c.text, status: c.status, source: c.source,
    audience, audienceText: describeAudience(audience),
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
    take: 100
  });
  const stats = await statsFor(rows.map(r => r.id));
  return rows.map(r => view(r, stats.get(r.id)));
}

export async function get(actor: Actor, id: string) {
  requireMay(actor, 'campaign:view');
  const c = await find(actor.clientId, id);
  const stats = await statsFor([c.id]);
  const recipients = await prisma.$queryRaw<{ id: string; customer_id: string; name: string | null; phone: string | null; state: string; skip_reason: string | null; status: string | null; fail_reason: string | null; handed_at: Date | null }[]>`
    SELECT r.id, r.customer_id, c.name, c.phone, r.state, r.skip_reason, m.status, m.fail_reason, r.handed_at
      FROM campaign_recipients r
      JOIN customers c ON c.id = r.customer_id
      LEFT JOIN whatsapp_messages m ON m.id = r.message_id
     WHERE r.campaign_id = ${c.id}
     ORDER BY r.handed_at DESC NULLS LAST, c.name ASC
     LIMIT 500`;
  return {
    ...view(c, stats.get(c.id)),
    recipients: recipients.map(r => ({
      id: r.id,
      customerId: r.customer_id,
      name: r.name,
      phone: r.phone ? `••••${r.phone.slice(-4)}` : null,
      state: r.state === 'HANDED' ? (r.status ?? 'QUEUED') : r.state,
      reason: r.skip_reason ?? r.fail_reason ?? null,
      at: r.handed_at
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

export async function create(actor: Actor, input: Record<string, unknown>) {
  requireMay(actor, 'campaign:send');
  const c = await prisma.campaign.create({
    data: {
      clientId: actor.clientId,
      name: checkName(input.name),
      text: checkText(input.text),
      audience: checkAudience(input.audience) as Prisma.InputJsonValue,
      startAt: startAtOf(input.startAt),
      createdById: actor.id
    }
  });
  return view(c);
}

export async function update(actor: Actor, id: string, input: Record<string, unknown>) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.status !== 'DRAFT') throw conflict('This campaign has started, so its words and customers are fixed. Make a copy to change them.');
  const data: Prisma.CampaignUpdateInput = {};
  if (input.name !== undefined) data.name = checkName(input.name);
  if (input.text !== undefined) data.text = checkText(input.text);
  if (input.audience !== undefined) data.audience = checkAudience(input.audience) as Prisma.InputJsonValue;
  if (input.startAt !== undefined) data.startAt = startAtOf(input.startAt);
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

export async function copy(actor: Actor, id: string) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.source !== 'MANUAL') throw badRequest('Automatic messages cannot be copied. Change their words in Loyalty settings.');
  const made = await prisma.campaign.create({
    data: { clientId: actor.clientId, name: `${c.name} (copy)`.slice(0, 80), text: c.text, audience: c.audience as Prisma.InputJsonValue, createdById: actor.id }
  });
  return view(made);
}

export async function preview(actor: Actor, audience: unknown) {
  requireMay(actor, 'campaign:view');
  return previewAudience(actor.clientId, checkAudience(audience));
}

/** What the page needs beside the list: is WhatsApp ready, and how fast a campaign can go. */
export async function overview(actor: Actor) {
  requireMay(actor, 'campaign:view');
  let whatsapp: { status: string; linkedAt: string | null } | null = null;
  let problem: string | null = null;
  if (!whatsappConfigured()) problem = 'WhatsApp sending is not set up for ScaleEzy yet.';
  else {
    try { const n = await shopNumber(actor.clientId); whatsapp = { status: n.status, linkedAt: n.linkedAt }; }
    catch (e) { problem = e instanceof WhatsAppServiceError ? e.message : 'WhatsApp could not be reached just now.'; }
  }
  const [agreed, withPhone, stopped] = await Promise.all([
    prisma.customer.count({ where: { clientId: actor.clientId, deletedAt: null, whatsappOffers: true, whatsappStoppedAt: null, phone: { not: null } } }),
    prisma.customer.count({ where: { clientId: actor.clientId, deletedAt: null, phone: { not: null } } }),
    prisma.customer.count({ where: { clientId: actor.clientId, deletedAt: null, whatsappStoppedAt: { not: null } } })
  ]);
  const linkedAt = whatsapp?.linkedAt ? new Date(whatsapp.linkedAt) : null;
  return {
    whatsapp, problem,
    perDay: dailyBudget(linkedAt),
    hours: '10 am to 8 pm',
    customers: { withPhone, agreed, stopped },
    canSend: may(actor, 'campaign:send')
  };
}

/**
 * Start: the customers are written now, and the sender takes it from here. `expected` is the count
 * the person was shown; if the list has changed a lot since, they are asked to look again.
 */
export async function start(actor: Actor, id: string, input: { expected?: unknown } = {}) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
  if (c.status !== 'DRAFT') throw conflict('This campaign has already been started.');
  const where = await whereFor(actor.clientId, c.audience as Audience);
  const customers = await prisma.customer.findMany({ where, select: { id: true }, take: MAX_RECIPIENTS + 1 });
  if (customers.length === 0) throw badRequest('Nobody matches these choices yet. Only customers who agreed to offers on WhatsApp can be sent a campaign.');
  if (customers.length > MAX_RECIPIENTS) throw badRequest(`A campaign can reach at most ${MAX_RECIPIENTS.toLocaleString('en-IN')} customers. Narrow the choices.`);
  if (typeof input.expected === 'number' && Math.abs(input.expected - customers.length) > Math.max(5, input.expected * 0.1)) {
    throw Object.assign(conflict(`This now reaches ${customers.length} customers, not ${input.expected}. Check the list and press Start again.`), {
      details: { code: 'AUDIENCE_CHANGED', count: customers.length }
    });
  }
  await prisma.$transaction(async tx => {
    const claimed = await tx.campaign.updateMany({
      where: { id: c.id, clientId: actor.clientId, status: 'DRAFT' },
      data: { status: 'SENDING', startedAt: new Date() }
    });
    if (claimed.count === 0) throw conflict('This campaign has just been started by somebody else.');
    await tx.campaignRecipient.createMany({
      data: customers.map(cu => ({ campaignId: c.id, clientId: actor.clientId, customerId: cu.id })),
      skipDuplicates: true
    });
  }, { timeout: 30000, maxWait: 15000 });
  return get(actor, c.id);
}

export async function pause(actor: Actor, id: string) {
  requireMay(actor, 'campaign:send');
  const c = await find(actor.clientId, id);
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
    prisma.campaignRecipient.updateMany({ where: { campaignId: c.id, state: 'WAITING' }, data: { state: 'SKIPPED', skipReason: 'The campaign was stopped.' } })
  ]);
  return get(actor, c.id);
}

/** The words as a customer will read them, filled in for somebody. */
export async function personalise(clientId: string, text: string, customer: { name: string | null; loyaltyPoints: number }) {
  const [{ businessName }, s] = await Promise.all([getShopSettings(clientId), loyaltySettings(clientId)]);
  return render(text, {
    name: customer.name,
    shop: businessName || 'our shop',
    points: customer.loyaltyPoints,
    pointsValue: rupeesOf(valueOf(Math.max(0, customer.loyaltyPoints), s))
  });
}

/**
 * "Send me a test": the message, filled in with the sender's own name, to a number the person types
 * -- their own phone, usually. Typed rather than taken from the shop's link because the WhatsApp
 * Service never hands the app a full phone number (it masks every one), so the shop's own number is
 * not known here. The same as Settings > WhatsApp's test, and only for those who may send campaigns.
 */
export async function sendTest(actor: Actor, input: { text?: unknown; campaignId?: unknown; to?: unknown }) {
  requireMay(actor, 'campaign:send');
  const text = input.campaignId ? (await find(actor.clientId, String(input.campaignId))).text : checkText(input.text);
  const typed = typeof input.to === 'string' ? input.to.trim() : '';
  if (!typed) throw badRequest('Type the WhatsApp number to send the test to, for example your own.');
  const phone = normalisePhone(typed);
  if (!phone.ok) throw badRequest(phone.reason);
  const to = phone.value.replace(/^\+/, '');
  const n = await shopNumber(actor.clientId);
  if (n.status !== 'CONNECTED') throw badRequest("Link the shop's WhatsApp in Settings → WhatsApp first. The test goes from that number.");
  const body = await personalise(actor.clientId, text, { name: actor.name ?? null, loyaltyPoints: 250 });
  const sent = await whatsappClient.send({
    from: { clientId: actor.clientId },
    to,
    text: `[Test] ${body}`,
    kind: 'TEST',
    reference: 'CAMPAIGN_TEST',
    idempotencyKey: `CAMPAIGN_TEST:${actor.clientId}:${crypto.randomUUID()}`
  });
  return { sent: true, status: sent.status, to: `••••${to.slice(-4)}` };
}
