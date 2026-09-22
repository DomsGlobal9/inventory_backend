/**
 * WhatsApp for Inventory: linking the shop's own number, sending its documents from it, the
 * nightly Day Book from the ScaleEzy number, and the delivery ticks that come back.
 *
 * The rules that matter, in one place:
 *
 * WHO RECEIVES A DOCUMENT IS DECIDED HERE, never by the browser. A purchase order goes to that
 * order's supplier, a bill to that sale's customer, from this shop's records. The browser only
 * sends the PDF it already makes for Download, and says which document it is. So nobody can
 * send a shop's purchase order to a number of their choosing through this app.
 *
 * FROM WHOSE NUMBER: a shop's documents go from the shop's own linked number. The Day Book goes
 * from ScaleEzy's number to the owner. A customer never hears from ScaleEzy's number.
 *
 * WHO MAY: linking needs whatsapp:manage. Sending needs whatever already allowed the thing on
 * paper -- sending a purchase order to the supplier, receiving goods, seeing orders or returns.
 * The nightly Day Book is the owner's own choice, so only the owner sets it.
 *
 * NEVER TWICE: each press of a Send button carries its own id, which the WhatsApp Service keeps
 * as the message's idempotency key -- a retry of the same press returns the same message, and a
 * double click inside a minute is refused by the service's own duplicate rule. The Day Book's key
 * is the shop and the day, so a restart at 10 pm cannot send the same night twice.
 */
import crypto from 'crypto';
import { PurchaseOrderStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { normalisePhone } from '../../lib/phone';
import { getShopSettings } from '../../lib/clientSettings';
import { sendMail } from '../../lib/mailer';
import { grants, holdsEverything, getPermission } from '../../config/permissions';
import { todayKey, isValidDayKey, startOfLocalDay } from '../../utils/businessDay';
import { dayBookService } from '../daybook.service';
import { purchaseOrderService } from '../purchase-order.service';
import { COUNTER_SOURCE } from '../counter-sale/counter-sale.service';
import { renderDayBookPdf } from './daybook-pdf';
import { whatsappClient, whatsappConfigured, WhatsAppServiceError, type MessageStatus } from './client';
import { markStopped } from '../campaigns/consent';

export type Actor = { id: string; clientId: string; name?: string | null; permissions?: string[]; roles?: string[] };
export type SendKind = 'PURCHASE_ORDER' | 'GOODS_RECEIPT' | 'BILL' | 'RETURN_NOTE';
export const SEND_KINDS: readonly SendKind[] = ['PURCHASE_ORDER', 'GOODS_RECEIPT', 'BILL', 'RETURN_NOTE'];

/** The service's own message kinds (PLAN-whatsapp.md section 4). */
const SERVICE_KIND: Record<SendKind | 'DAY_BOOK' | 'TEST' | 'DISCONNECTED' | 'CAMPAIGN' | 'LOYALTY', string> = {
  PURCHASE_ORDER: 'C1', BILL: 'C2', GOODS_RECEIPT: 'C3', RETURN_NOTE: 'C5', DAY_BOOK: 'S6', DISCONNECTED: 'S4', TEST: 'TEST',
  CAMPAIGN: 'C8', LOYALTY: 'C9'
};

/** What allowed the same document on paper allows it on WhatsApp. */
const SEND_PERMISSION: Record<SendKind, string> = {
  PURCHASE_ORDER: 'purchase_order:update',
  GOODS_RECEIPT: 'purchase_order:receive',
  BILL: 'sales_order:view',
  RETURN_NOTE: 'return:view'
};

/** How far a message has got. A tick arriving late never moves it backwards. */
const RANK: Record<string, number> = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 5, EXPIRED: 5 };

const MAX_PDF_BYTES = 5 * 1024 * 1024;

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

const isOwner = (a: Actor) => holdsEverything(a.permissions, a.roles);
const may = (a: Actor, permission: string) => isOwner(a) || grants(a.permissions ?? [], permission);
function requireMay(a: Actor, permission: string) {
  if (!may(a, permission)) {
    const def = getPermission(permission);
    throw fail(403, `You do not have permission to: ${(def?.label ?? permission).toLowerCase()}. Ask whoever manages your team.`);
  }
}

/** Only the last four digits ever leave this module: enough to recognise, not a list of numbers. */
export const maskPhone = (digits: string | null | undefined) => (digits ? `••••${digits.slice(-4)}` : '');

/** A stored phone as WhatsApp wants it (digits with country code), or a sentence saying why not. */
function whatsappDigits(raw: string | null | undefined, whose: string): string {
  if (!raw || !String(raw).trim()) throw fail(400, `${whose} has no phone number saved. Add one, then send again.`);
  const r = normalisePhone(raw);
  if (!r.ok) throw fail(400, `${whose}'s phone number cannot be used on WhatsApp: ${r.reason}`);
  return r.value.replace(/^\+/, '');
}

/** One press of a Send button: letters, digits and dashes, from the browser. */
function pressId(nonce: unknown): string {
  const s = typeof nonce === 'string' ? nonce.trim() : '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(s)) throw fail(400, 'This request is missing its send id. Reload the page and press Send again.');
  return s;
}

/** The PDF the browser made, checked before anything is sent anywhere. */
function checkPdf(base64: unknown): string {
  if (typeof base64 !== 'string' || !base64) throw fail(400, 'The PDF did not arrive. Please press Send again.');
  const clean = base64.replace(/^data:application\/pdf;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw fail(400, 'The PDF did not arrive intact. Please press Send again.');
  // 4 base64 characters carry 3 bytes; checked before decoding so a huge upload is not held in memory twice.
  if (Math.floor(clean.length * 3 / 4) > MAX_PDF_BYTES + 3) throw fail(413, 'This PDF is larger than 5 MB, which is too big to send on WhatsApp.');
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length > MAX_PDF_BYTES) throw fail(413, 'This PDF is larger than 5 MB, which is too big to send on WhatsApp.');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw fail(400, 'That file is not a PDF.');
  return clean;
}

function safeFileName(name: unknown, fallback: string): string {
  const base = (typeof name === 'string' ? name : '').replace(/\.pdf$/i, '').replace(/[^\w.\- ]+/g, '-').trim().slice(0, 90);
  return `${base || fallback}.pdf`;
}

type Target = { to: string; recipientName: string; reference: string; text: string; fileName: string };

/**
 * Who a document goes to, and what the message says, read from this shop's own records.
 * Scoped by clientId at every lookup: an id from another shop is simply "not found".
 */
async function targetFor(clientId: string, kind: SendKind, id: string): Promise<Target> {
  const { businessName } = await getShopSettings(clientId);
  const shop = businessName || 'our shop';

  if (kind === 'PURCHASE_ORDER') {
    const po = await prisma.purchaseOrder.findFirst({ where: { id, clientId }, include: { supplier: true } });
    if (!po) throw fail(404, 'That purchase order was not found.');
    if (po.status === PurchaseOrderStatus.CANCELLED) throw fail(409, `${po.poNumber} is cancelled, so it is not sent to the supplier.`);
    return {
      to: whatsappDigits(po.supplier.phone, po.supplier.name),
      recipientName: po.supplier.name,
      reference: po.poNumber,
      text: `Hello ${po.supplier.name},\n\nPlease find our purchase order *${po.poNumber}* attached.\n\n${shop}`,
      fileName: po.poNumber
    };
  }

  if (kind === 'GOODS_RECEIPT') {
    const grn = await prisma.purchaseReceipt.findFirst({ where: { id, clientId }, include: { po: { include: { supplier: true } } } });
    if (!grn) throw fail(404, 'That goods receipt was not found.');
    const supplier = grn.po.supplier;
    return {
      to: whatsappDigits(supplier.phone, supplier.name),
      recipientName: supplier.name,
      reference: grn.receiptNumber,
      text: `Hello ${supplier.name},\n\nWe have received goods against *${grn.po.poNumber}*. Our receipt *${grn.receiptNumber}* is attached.\n\n${shop}`,
      fileName: `${grn.receiptNumber}-${grn.po.poNumber}`
    };
  }

  if (kind === 'BILL') {
    const order = await prisma.salesOrder.findFirst({ where: { id, clientId }, include: { customer: true } });
    if (!order) throw fail(404, 'That sale was not found.');
    if (order.sourceSystem !== COUNTER_SOURCE) throw fail(409, 'Bills are only for sales made at the counter with New sale.');
    return {
      to: whatsappDigits(order.customer.phone, order.customer.name || 'This customer'),
      recipientName: order.customer.name || 'the customer',
      reference: order.orderNumber,
      text: `Thank you for shopping at ${shop}${order.customer.name ? `, ${order.customer.name}` : ''}.\n\nYour bill *${order.orderNumber}* is attached.`,
      fileName: `Bill-${order.orderNumber}`
    };
  }

  const ret = await prisma.salesReturn.findFirst({ where: { id, clientId }, include: { salesOrder: { include: { customer: true } } } });
  if (!ret) throw fail(404, 'That return was not found.');
  if (ret.status !== 'COMPLETED') throw fail(409, `${ret.returnNumber} is not finished yet. Send the return note once the return is completed.`);
  const customer = ret.salesOrder.customer;
  return {
    to: whatsappDigits(customer.phone, customer.name || 'This customer'),
    recipientName: customer.name || 'the customer',
    reference: ret.returnNumber,
    text: `Hello${customer.name ? ` ${customer.name}` : ''},\n\nYour return *${ret.returnNumber}* against order ${ret.salesOrder.orderNumber} is complete. The return note is attached.\n\n${shop}`,
    fileName: `Return-${ret.returnNumber}`
  };
}

/** Keeps our own record of a message, keyed by the service's id so a retried press updates one row. */
async function record(clientId: string, kind: string, referenceId: string | null, to: string, sentBy: string | null, sent: { id: string; status: MessageStatus }) {
  return prisma.whatsAppMessage.upsert({
    where: { serviceMessageId: sent.id },
    create: { clientId, serviceMessageId: sent.id, kind, referenceId, toMasked: maskPhone(to), status: sent.status, sentBy },
    update: {}
  });
}

const publicMessage = (m: { id: string; kind: string; referenceId: string | null; toMasked: string; status: string; failReason: string | null; createdAt: Date; updatedAt: Date }) => ({
  id: m.id, kind: m.kind, referenceId: m.referenceId, to: m.toMasked, status: m.status, failReason: m.failReason, sentAt: m.createdAt, updatedAt: m.updatedAt
});

// ── The shop's screen ──────────────────────────────────────────────────────────────────────

/** Anyone who may send some document on WhatsApp, or manage it, may see whether it is linked. */
const MAY_SEE_WHATSAPP = ['whatsapp:manage', ...Object.values(SEND_PERMISSION)];

export async function getOverview(actor: Actor) {
  if (!MAY_SEE_WHATSAPP.some(p => may(actor, p))) {
    throw fail(403, 'WhatsApp is not part of your role. Ask whoever manages your team.');
  }
  const configured = whatsappConfigured();
  let account: { status: string; phone: string | null; linkedAt: string | null } | null = null;
  let problem: string | null = null;
  if (configured) {
    try {
      const a = await whatsappClient.account(actor.clientId);
      // The service masks its own way; every screen here shows ••••1234.
      const last4 = (a.phone ?? '').replace(/\D/g, '').slice(-4);
      account = { status: a.status, phone: last4 ? `••••${last4}` : null, linkedAt: a.linkedAt };
    } catch (e) {
      problem = e instanceof WhatsAppServiceError ? e.message : 'WhatsApp could not be reached just now.';
    }
  }
  const owner = isOwner(actor);
  const settings = owner ? await prisma.whatsAppSettings.findUnique({ where: { clientId: actor.clientId } }) : null;
  return {
    configured,
    account,
    problem,
    canManage: may(actor, 'whatsapp:manage'),
    isOwner: owner,
    dayBook: owner ? {
      enabled: settings?.dayBookEnabled ?? false,
      time: settings?.dayBookTime ?? '22:00',
      to: settings?.dayBookTo ? `+${settings.dayBookTo}` : null
    } : null
  };
}

export async function link(actor: Actor, method: unknown, phone: unknown) {
  requireMay(actor, 'whatsapp:manage');
  if (method !== 'qr' && method !== 'code') throw fail(400, 'Choose how to link: scan a QR code, or type a code on the phone.');
  let digits: string | undefined;
  if (method === 'code') digits = whatsappDigits(typeof phone === 'string' ? phone : null, 'The phone you are linking');
  return whatsappClient.link(actor.clientId, method, digits);
}

export async function disconnect(actor: Actor) {
  requireMay(actor, 'whatsapp:manage');
  return whatsappClient.disconnect(actor.clientId);
}

export async function sendTest(actor: Actor, to: unknown, nonce: unknown) {
  requireMay(actor, 'whatsapp:manage');
  const digits = whatsappDigits(typeof to === 'string' ? to : null, 'The number to test with');
  const { businessName } = await getShopSettings(actor.clientId);
  const sent = await whatsappClient.send({
    from: { clientId: actor.clientId },
    to: digits,
    text: `This is a test from ${businessName || 'your shop'} on ScaleEzy. Your shop's WhatsApp is linked and sending.`,
    kind: SERVICE_KIND.TEST,
    reference: 'TEST',
    idempotencyKey: `TEST:${actor.clientId}:${pressId(nonce)}`
  });
  return publicMessage(await record(actor.clientId, 'TEST', null, digits, actor.id, sent));
}

export async function sendDocument(actor: Actor, input: { kind: unknown; id: unknown; pdfBase64: unknown; fileName?: unknown; nonce: unknown }) {
  const kind = input.kind as SendKind;
  if (!SEND_KINDS.includes(kind)) throw fail(400, 'That document cannot be sent on WhatsApp.');
  requireMay(actor, SEND_PERMISSION[kind]);
  const id = typeof input.id === 'string' && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : null;
  if (!id) throw fail(400, 'Which document to send is missing.');
  const press = pressId(input.nonce);
  const base64 = checkPdf(input.pdfBase64);
  const target = await targetFor(actor.clientId, kind, id);

  const sent = await whatsappClient.send({
    from: { clientId: actor.clientId },
    to: target.to,
    text: target.text,
    document: { fileName: safeFileName(input.fileName, target.fileName), mimeType: 'application/pdf', base64 },
    kind: SERVICE_KIND[kind],
    reference: `${kind}:${id}`,
    idempotencyKey: `${kind}:${id}:${press}`
  });
  const row = await record(actor.clientId, kind, id, target.to, actor.id, sent);
  return { ...publicMessage(row), recipientName: target.recipientName };
}

/**
 * A text from the shop's own number, for the campaigns module: a campaign message, a birthday wish,
 * a points notice. The caller has already decided who may receive it (agreed to offers, not STOP);
 * the WhatsApp Service still refuses anyone who replied STOP, whatever this app thinks.
 *
 * The idempotency key is the caller's: one campaign and one customer is one message, however many
 * times this is retried.
 */
export async function sendShopText(input: {
  clientId: string; to: string; text: string; kind: 'CAMPAIGN' | 'LOYALTY'; referenceId: string | null;
  idempotencyKey: string; sentBy: string | null;
}) {
  const to = whatsappDigits(input.to, 'This customer');
  const sent = await whatsappClient.send({
    from: { clientId: input.clientId },
    to,
    text: input.text,
    kind: SERVICE_KIND[input.kind],
    reference: input.referenceId ? `${input.kind}:${input.referenceId}` : input.kind,
    idempotencyKey: input.idempotencyKey
  });
  return record(input.clientId, input.kind, input.referenceId, to, input.sentBy, sent);
}

/** The shop's linked number, in full, for a campaign's "send me a test" -- or null if not linked. */
export async function shopNumber(clientId: string): Promise<{ digits: string | null; status: string; linkedAt: string | null }> {
  const a = await whatsappClient.account(clientId);
  return { digits: (a.phone ?? '').replace(/\D/g, '') || null, status: a.status, linkedAt: a.linkedAt };
}

/** The latest message for one document: what its Send button shows. */
export async function latestFor(actor: Actor, kind: unknown, id: unknown) {
  if (!SEND_KINDS.includes(kind as SendKind) || typeof id !== 'string') throw fail(400, 'Which document is missing.');
  requireMay(actor, SEND_PERMISSION[kind as SendKind]);
  const m = await prisma.whatsAppMessage.findFirst({
    where: { clientId: actor.clientId, kind: kind as string, referenceId: id },
    orderBy: { createdAt: 'desc' }
  });
  if (!m) return null;
  // Still waiting after half a minute: say why (the shop's WhatsApp is not connected, or today's
  // limit is used up), so "Waiting to send" is never a mystery. Best effort -- the status stands
  // without it.
  let waitingReason: string | null = null;
  if (m.status === 'QUEUED' && m.serviceMessageId && Date.now() - m.createdAt.getTime() > 30_000) {
    waitingReason = await whatsappClient.message(m.serviceMessageId).then(r => r.waitingReason ?? null).catch(() => null);
  }
  return { ...publicMessage(m), waitingReason };
}

// ── The nightly Day Book ───────────────────────────────────────────────────────────────────

export async function saveDayBookSettings(actor: Actor, input: { enabled: unknown; time: unknown; to: unknown }) {
  if (!isOwner(actor)) throw fail(403, 'Only the shop owner can choose the nightly Day Book.');
  const enabled = input.enabled === true;
  const time = typeof input.time === 'string' ? input.time.trim() : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail(400, 'Choose a time like 22:00.');
  let to: string | null = null;
  if (input.to !== null && input.to !== undefined && String(input.to).trim() !== '') {
    to = whatsappDigits(String(input.to), 'The number for the Day Book');
  }
  if (enabled && !to) throw fail(400, 'Enter the WhatsApp number the Day Book should go to.');
  const saved = await prisma.whatsAppSettings.upsert({
    where: { clientId: actor.clientId },
    create: { clientId: actor.clientId, dayBookEnabled: enabled, dayBookTime: time, dayBookTo: to, updatedBy: actor.id },
    update: { dayBookEnabled: enabled, dayBookTime: time, dayBookTo: to, updatedBy: actor.id }
  });
  return { enabled: saved.dayBookEnabled, time: saved.dayBookTime, to: saved.dayBookTo ? `+${saved.dayBookTo}` : null };
}

/**
 * "Send me today's Day Book now": the owner trying it out, or wanting it early. Its own key per
 * press, so it never stands in for tonight's.
 */
export async function sendDayBookNow(actor: Actor, nonce: unknown) {
  if (!isOwner(actor)) throw fail(403, 'Only the shop owner can have the Day Book sent.');
  const settings = await prisma.whatsAppSettings.findUnique({ where: { clientId: actor.clientId } });
  if (!settings?.dayBookTo) throw fail(400, 'Save the WhatsApp number the Day Book should go to first.');
  const { timezone } = await getShopSettings(actor.clientId);
  const dayKey = todayKey(timezone);
  await requireDayBookAllowance(actor.clientId, timezone);
  const sent = await sendDayBook(actor.clientId, dayKey, settings.dayBookTo, `DAY_BOOK_NOW:${actor.clientId}:${pressId(nonce)}`, { sentBy: actor.id });
  return { status: sent.status, to: maskPhone(settings.dayBookTo) };
}

/** "HH:MM" of this instant in a time zone, 24-hour. */
function localClock(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/**
 * Builds one shop's Day Book for one day and hands it to the WhatsApp Service, from the ScaleEzy
 * number. Its key is the shop and the day: however often this runs, one Day Book per night.
 */
export async function sendDayBook(
  clientId: string, dayKey: string, to: string, idempotencyKey = `DAY_BOOK:${clientId}:${dayKey}`,
  opts: { fromKey?: string | null; locationId?: string | null; sentBy?: string | null } = {}
) {
  // A range runs from fromKey to dayKey; one day is a range of itself.
  const fromKey = opts.fromKey && opts.fromKey !== dayKey ? opts.fromKey : null;
  const locationId = opts.locationId || undefined;
  const [day, shop, location] = await Promise.all([
    fromKey ? dayBookService.getRange(clientId, fromKey, dayKey, locationId) : dayBookService.getDay(clientId, dayKey, locationId),
    getShopSettings(clientId),
    locationId ? prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { name: true } }) : null
  ]);
  if (locationId && !location) throw fail(404, 'That location was not found.');
  const heading = dayBookHeading(fromKey, dayKey);
  const pdf = await renderDayBookPdf({ day, heading, businessName: shop.businessName || '', locationName: location?.name, timeZone: shop.timezone });
  // "up to 9:40 pm" only means something for a day that is still running.
  const upTo = day.inProgress ? `, up to ${localClock(new Date(), shop.timezone)}` : '';
  const where = location ? ` (${location.name})` : '';
  const span = fromKey ? `${fromKey}..${dayKey}` : dayKey;
  const sent = await whatsappClient.send({
    from: 'scaleezy',
    to,
    text: `Day Book for ${shop.businessName || 'your shop'}${where} - ${heading}${upTo}.\n\nFrom ScaleEzy. Change or stop this in Settings > WhatsApp.`,
    document: { fileName: `day-book-${fromKey ? `${fromKey}-to-${dayKey}` : dayKey}.pdf`, mimeType: 'application/pdf', base64: pdf.toString('base64') },
    kind: SERVICE_KIND.DAY_BOOK,
    reference: `DAY_BOOK:${span}`,
    idempotencyKey
  });
  await record(clientId, 'DAY_BOOK', span, to, opts.sentBy ?? null, sent);
  return sent;
}

/** "Friday, 18 September 2026", or "1 Sep 2026 to 18 Sep 2026". The Day Book page prints the same. */
export function dayBookHeading(fromKey: string | null, dayKey: string): string {
  const at = (k: string) => new Date(`${k}T12:00:00Z`);
  if (!fromKey) return at(dayKey).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const short = (k: string) => at(k).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${short(fromKey)} to ${short(dayKey)}`;
}

// ── The Day Book page's own Send button ────────────────────────────────────────────────────

/**
 * Day Books a shop may ask for in one day, the nightly one apart. They all leave from ScaleEzy's
 * one number, whose daily allowance every shop shares: without this, one shop pressing Send all
 * afternoon would use up the night's Day Books for everybody else.
 */
export const DAY_BOOKS_ON_REQUEST_PER_DAY = 10;
const DAY_BOOK_PERMISSION = 'report:financial';

async function dayBooksAskedForToday(clientId: string, timezone: string): Promise<number> {
  return prisma.whatsAppMessage.count({
    where: { clientId, kind: 'DAY_BOOK', sentBy: { not: null }, createdAt: { gte: startOfLocalDay(todayKey(timezone), timezone) } }
  });
}

async function requireDayBookAllowance(clientId: string, timezone: string) {
  if (await dayBooksAskedForToday(clientId, timezone) >= DAY_BOOKS_ON_REQUEST_PER_DAY) {
    throw fail(429, `This shop has already had ${DAY_BOOKS_ON_REQUEST_PER_DAY} Day Books sent today, which is the limit. Download the PDF instead, or send it tomorrow.`);
  }
}

/** What the Day Book page needs to draw its button: can it send, to whom, how many are left. */
export async function getDayBookSending(actor: Actor) {
  requireMay(actor, DAY_BOOK_PERMISSION);
  const [settings, shop] = await Promise.all([
    prisma.whatsAppSettings.findUnique({ where: { clientId: actor.clientId } }),
    getShopSettings(actor.clientId)
  ]);
  const sentToday = await dayBooksAskedForToday(actor.clientId, shop.timezone);
  return {
    configured: whatsappConfigured(),
    to: settings?.dayBookTo ? maskPhone(settings.dayBookTo) : null,
    isOwner: isOwner(actor),
    sentToday,
    limit: DAY_BOOKS_ON_REQUEST_PER_DAY
  };
}

/**
 * The Day Book page's Send on WhatsApp: the day on the screen, or the range, for the location on
 * the screen. It always goes to the number the owner saved for the Day Book, never to one from
 * the browser -- these are the shop's profit figures.
 */
export async function sendDayBookFromPage(actor: Actor, input: { date?: unknown; from?: unknown; to?: unknown; locationId?: unknown; nonce?: unknown }) {
  requireMay(actor, DAY_BOOK_PERMISSION);
  const key = (v: unknown) => (typeof v === 'string' && isValidDayKey(v) ? v : null);
  const date = key(input.date), from = key(input.from), to = key(input.to);
  if (!date && !(from && to)) throw fail(400, 'Which day, or which days, to send is missing.');
  const lastKey = (date ?? to)!;
  const fromKey = date ? null : from;
  const locationId = typeof input.locationId === 'string' && /^[0-9a-f-]{36}$/i.test(input.locationId) ? input.locationId : null;
  if (input.locationId && !locationId) throw fail(400, 'That location was not found.');

  const [settings, shop] = await Promise.all([
    prisma.whatsAppSettings.findUnique({ where: { clientId: actor.clientId } }),
    getShopSettings(actor.clientId)
  ]);
  if (lastKey > todayKey(shop.timezone)) throw fail(400, 'A day that has not come yet has no Day Book.');
  if (!settings?.dayBookTo) {
    throw fail(400, isOwner(actor)
      ? 'Save the WhatsApp number the Day Book should go to first, in Settings > WhatsApp.'
      : 'The shop owner has not saved a WhatsApp number for the Day Book yet. They can do it in Settings > WhatsApp.');
  }
  await requireDayBookAllowance(actor.clientId, shop.timezone);
  const sent = await sendDayBook(actor.clientId, lastKey, settings.dayBookTo, `DAY_BOOK_PAGE:${actor.clientId}:${pressId(input.nonce)}`,
    { fromKey, locationId, sentBy: actor.id });
  const row = await prisma.whatsAppMessage.findUnique({ where: { serviceMessageId: sent.id } });
  return { id: row?.id ?? null, status: sent.status, to: maskPhone(settings.dayBookTo) };
}

/** Where a Day Book sent from the page has got to, for the chip beside the button. */
export async function dayBookMessage(actor: Actor, id: unknown) {
  requireMay(actor, DAY_BOOK_PERMISSION);
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw fail(400, 'Which message is missing.');
  const m = await prisma.whatsAppMessage.findFirst({ where: { id, clientId: actor.clientId, kind: 'DAY_BOOK' } });
  if (!m) return null;
  let waitingReason: string | null = null;
  if (m.status === 'QUEUED' && m.serviceMessageId && Date.now() - m.createdAt.getTime() > 30_000) {
    waitingReason = await whatsappClient.message(m.serviceMessageId).then(r => r.waitingReason ?? null).catch(() => null);
  }
  return { ...publicMessage(m), waitingReason };
}

/**
 * One tick of the nightly job: every shop whose chosen time has passed today and whose Day Book
 * for today has not gone yet. The shop is claimed with a conditional update first, so two ticks
 * (or two servers) cannot both send; a failure hands the claim back for the next tick. After
 * midnight a missed day is not sent late -- tomorrow's is.
 */
export async function runDayBookTick(now = new Date(), opts: { onlyClients?: string[] } = {}) {
  if (!whatsappConfigured()) return { sent: 0, failed: 0 };
  // onlyClients is for the verification suite, which shares a database with real shops: a tick
  // with a pretend clock must never claim a real shop's night.
  const due = await prisma.whatsAppSettings.findMany({
    where: { dayBookEnabled: true, dayBookTo: { not: null }, ...(opts.onlyClients ? { clientId: { in: opts.onlyClients } } : {}) }
  });
  let sent = 0, failed = 0;
  for (const s of due) {
    try {
      const { timezone } = await getShopSettings(s.clientId);
      const dayKey = todayKey(timezone);
      if (s.dayBookLastSentFor === dayKey) continue;
      if (localClock(now, timezone) < s.dayBookTime) continue;

      const claimed = await prisma.whatsAppSettings.updateMany({
        where: { clientId: s.clientId, dayBookEnabled: true, OR: [{ dayBookLastSentFor: null }, { dayBookLastSentFor: { not: dayKey } }] },
        data: { dayBookLastSentFor: dayKey }
      });
      if (claimed.count === 0) continue;
      try {
        await sendDayBook(s.clientId, dayKey, s.dayBookTo!);
        sent++;
      } catch (err) {
        // Give the night back, so the next tick tries again -- still before midnight, or not at all.
        await prisma.whatsAppSettings.updateMany({ where: { clientId: s.clientId, dayBookLastSentFor: dayKey }, data: { dayBookLastSentFor: s.dayBookLastSentFor } });
        failed++;
        console.error(`[whatsapp] Day Book for ${s.clientId} not handed over:`, (err as Error)?.message);
      }
    } catch (err) {
      failed++;
      console.error(`[whatsapp] Day Book check for ${s.clientId} failed:`, (err as Error)?.message);
    }
  }
  return { sent, failed };
}

// ── Events from the WhatsApp Service ───────────────────────────────────────────────────────

export function verifySignature(rawBody: Buffer, header: unknown): boolean {
  const secret = env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret || typeof header !== 'string') return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * One event, already verified. Each is handled once: the service delivers at least once, and the
 * event id is written first so a repeat is recognised and ignored.
 */
export async function handleEvent(event: { id?: unknown; type?: unknown; data?: any }) {
  if (typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') return { handled: false };
  const fresh = await prisma.whatsAppEventSeen.createMany({ data: [{ id: event.id }], skipDuplicates: true });
  if (fresh.count === 0) return { handled: false, duplicate: true };

  const d = event.data ?? {};
  if (event.type === 'message.status' && typeof d.messageId === 'string' && typeof d.status === 'string') {
    const row = await prisma.whatsAppMessage.findUnique({ where: { serviceMessageId: d.messageId } });
    if (!row) return { handled: false };
    // Ticks can arrive out of order. A finished message stays finished, and otherwise a status
    // only ever moves forward: DELIVERED arriving after READ changes nothing.
    const next = RANK[d.status];
    if (next === undefined || ['READ', 'FAILED', 'EXPIRED'].includes(row.status) || next <= (RANK[row.status] ?? -1)) {
      return { handled: true };
    }
    await prisma.whatsAppMessage.update({
      where: { id: row.id },
      data: { status: d.status, failReason: typeof d.failReason === 'string' ? d.failReason : null }
    });
    // A purchase order counts as sent once WhatsApp has it -- the same rule as email.
    if (row.kind === 'PURCHASE_ORDER' && row.referenceId && ['SENT', 'DELIVERED', 'READ'].includes(d.status)) {
      const po = await prisma.purchaseOrder.findFirst({ where: { id: row.referenceId, clientId: row.clientId }, select: { status: true } });
      if (po?.status === PurchaseOrderStatus.DRAFT) {
        await purchaseOrderService.updatePOStatus(row.clientId, row.referenceId, PurchaseOrderStatus.SENT).catch(err =>
          console.error('[whatsapp] could not mark the purchase order sent:', (err as Error)?.message));
      }
    }
    return { handled: true };
  }

  // A customer replied STOP to a shop's number. The service already never sends to them again; the
  // shop's own records say so too, so campaigns stop choosing them and the customer page shows why.
  if (event.type === 'contact.opted_out' && d.kind === 'CLIENT' && typeof d.clientId === 'string' && typeof d.contact === 'string') {
    await markStopped(d.clientId, d.contact);
    return { handled: true };
  }
    if (event.type === 'account.disconnected' && d.kind === 'CLIENT' && typeof d.clientId === 'string') {
    await tellOwnerDisconnected(d.clientId);
    return { handled: true };
  }
  if (d.kind === 'SCALEEZY' && (event.type === 'account.disconnected' || event.type === 'account.connected')) {
    // Not awaited: the service gives up on an answer after 10 s, and email can take longer.
    alertRun = tellPlatformAdmins(event.type === 'account.connected' ? 'BACK' : d.status === 'LOGGED_OUT' ? 'LOGGED_OUT' : 'DISCONNECTED')
      .catch(err => console.error('[whatsapp] platform alert failed:', (err as Error)?.message));
    return { handled: true };
  }
  return { handled: true };
}

/**
 * ScaleEzy's own number dropped (or came back). Every shop's Day Book and alerts go out from it, so
 * the people who run ScaleEzy hear by email at once instead of from a shop whose Day Book never came.
 * At most one email of each kind per 6 hours, so a number that keeps flapping does not flood the inbox;
 * "back" only follows a drop we actually reported. One backend instance, so memory is enough.
 */
const ALERT_GAP_MS = 6 * 60 * 60 * 1000;
const lastAlert = new Map<string, number>();
/** Swappable so the test never emails the real admins; `forget` clears the 6-hour memory for tests. */
export const platformAlertMail = {
  send: sendMail,
  /** WHATSAPP_ALERT_EMAILS; a function so the test can set it without touching the environment. */
  to: (): string | undefined => env.WHATSAPP_ALERT_EMAILS,
  forget: () => lastAlert.clear(),
  /** Resolves once the emails of the latest alert have been tried (for tests). */
  settled: () => alertRun
};
let alertRun: Promise<unknown> = Promise.resolve();

async function tellPlatformAdmins(what: 'LOGGED_OUT' | 'DISCONNECTED' | 'BACK') {
  const now = Date.now();
  if (what === 'BACK') {
    const dropped = Math.max(lastAlert.get('LOGGED_OUT') ?? 0, lastAlert.get('DISCONNECTED') ?? 0);
    if (!dropped || (lastAlert.get('BACK') ?? 0) > dropped) return;
  } else if (now - (lastAlert.get(what) ?? 0) < ALERT_GAP_MS) {
    return;
  }
  // Claimed before the first await, so a second event arriving meanwhile does not send it again.
  const before = lastAlert.get(what);
  lastAlert.set(what, now);

  const written = (platformAlertMail.to() ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const listed = written.filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  if (listed.length < written.length) console.error(`[whatsapp] WHATSAPP_ALERT_EMAILS: skipped ${written.length - listed.length} entr${written.length - listed.length === 1 ? 'y that is' : 'ies that are'} not an email address`);
  // A list with nothing usable falls back to the admins, so a typo never means nobody is told.
  const admins = listed.length
    ? listed.map(email => ({ email, name: 'ScaleEzy team' }))
    : await prisma.platformAdmin.findMany({ where: { status: 'ACTIVE' }, select: { email: true, name: true } });
  const reconnect = [
    'To connect it again (about 2 minutes, with the ScaleEzy phone in your hand):',
    '1. On the phone: WhatsApp > Linked devices. Leave any "ScaleEzy (Chrome)" there alone.',
    '2. On the computer, in backend/whatsapp-service/service, run:',
    '   npm run link:scaleezy -- --base https://whatsapp-service-gv88.onrender.com',
    '3. A QR page opens by itself. Scan it from Linked devices > Link a device.',
    'Full guide: backend/whatsapp-service/docs/HOW-IT-WORKS.md, "Reconnecting a number that logged out".'
  ].join('\n');
  const mail = {
    LOGGED_OUT: {
      subject: "ScaleEzy's WhatsApp number was logged out",
      body: `ScaleEzy's own WhatsApp number was logged out. Until it is linked again, no shop gets its Day Book, alerts or login messages on WhatsApp. It will not come back by itself.\n\n${reconnect}`
    },
    DISCONNECTED: {
      subject: "ScaleEzy's WhatsApp number is not connected",
      body: `ScaleEzy's own WhatsApp number stopped answering. The phone may be switched off or without internet. It usually comes back by itself once the phone is online. Messages wait and go out then; anything still waiting after a day is dropped.\n\nIf you do not get a "back" email within an hour, check the phone. If WhatsApp there shows no "ScaleEzy (Chrome)" under Linked devices, link it again:\n\n${reconnect}`
    },
    BACK: {
      subject: "ScaleEzy's WhatsApp number is back",
      body: "ScaleEzy's own WhatsApp number is connected again. Day Books and alerts are going out as normal."
    }
  }[what];
  const sent = await Promise.all(admins.map(a =>
    platformAlertMail.send({ to: a.email, subject: mail.subject, text: `Hello ${a.name},\n\n${mail.body}\n\nScaleEzy`, kind: `scaleezy-whatsapp-${what.toLowerCase()}` })
      .then(r => { if (!r.sent) console.error('[whatsapp] platform alert email not sent:', r.reason); return r.sent; })
      .catch(err => { console.error('[whatsapp] platform alert email not sent:', (err as Error)?.message); return false; })
  ));
  // Only a sent email keeps the 6-hour quiet time; after a mail outage the next event tries again.
  if (!sent.includes(true)) {
    if (before === undefined) lastAlert.delete(what);
    else lastAlert.set(what, before);
  }
}

/**
 * The shop's WhatsApp dropped. The owner hears by email, and on WhatsApp from the ScaleEzy number
 * if they have given one for the Day Book. Never allowed to fail the event.
 */
async function tellOwnerDisconnected(clientId: string) {
  const [shop, owners, settings] = await Promise.all([
    getShopSettings(clientId),
    prisma.user.findMany({
      where: { clientId, status: 'ACTIVE', roles: { some: { role: { name: 'SUPER_ADMIN' } } } },
      select: { email: true, name: true }
    }),
    prisma.whatsAppSettings.findUnique({ where: { clientId } })
  ]);
  const shopName = shop.businessName || 'your shop';
  const line = `${shopName}'s WhatsApp was disconnected, so bills and purchase orders cannot be sent from it. Link it again in ScaleEzy: Settings > WhatsApp.`;
  for (const o of owners) {
    await sendMail({ to: o.email, subject: `${shopName}: WhatsApp disconnected`, text: `Hello ${o.name},\n\n${line}\n\nScaleEzy`, kind: 'whatsapp-disconnected' })
      .catch(err => console.error('[whatsapp] disconnect email not sent:', (err as Error)?.message));
  }
  if (settings?.dayBookTo) {
    await whatsappClient.send({
      from: 'scaleezy', to: settings.dayBookTo, text: line, kind: SERVICE_KIND.DISCONNECTED,
      reference: 'DISCONNECTED', idempotencyKey: `DISCONNECTED:${clientId}:${new Date().toISOString().slice(0, 13)}`
    }).catch(err => console.error('[whatsapp] disconnect WhatsApp not sent:', (err as Error)?.message));
  }
}
