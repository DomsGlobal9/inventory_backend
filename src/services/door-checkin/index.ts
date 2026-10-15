/**
 * Door QR check-in: a customer scans the QR at a store's door, WhatsApp opens with "I'm at the shop"
 * and a door code already written, and they press send. The WhatsApp Service passes on only the
 * number and the code (contact.checked_in); here the code says which store, the number says who,
 * and the store's salespeople see them in "In the store now" before they reach the first rack.
 *
 * The customer chose to send it, so a short welcome back from the shop's own number is a reply to
 * them, not a message out of the blue. Nothing is sent to anybody who replied STOP: the WhatsApp
 * Service refuses that whatever this app asks.
 */
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma';
import { normalisePhone } from '../../lib/phone';
import { badRequest, conflict, notFound } from '../../utils/httpError';
import { groupNamesOf } from '../customer-groups';

/** How long someone counts as "in the store now", and as the same visit if they scan twice. */
export const VISIT_MS = 2 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: read off a printed standee

/**
 * A store's door code: six letters and digits, the same every time for that store, so a standee
 * printed once keeps working. Worked out, not stored -- nothing to set up, nothing to lose.
 */
export function doorCode(clientId: string, locationId: string): string {
  const h = crypto.createHash('sha256').update(`door:${clientId}:${locationId}`).digest();
  return Array.from(h.subarray(0, 6), b => ALPHABET[b % 32]).join('');
}

async function storeForCode(clientId: string, code: string) {
  const stores = await prisma.stockLocation.findMany({ where: { clientId, active: true }, select: { id: true, name: true } });
  return stores.find(s => doorCode(clientId, s.id) === code.toUpperCase()) ?? null;
}

const mask = (e164: string) => e164.length > 7 ? `${e164.slice(0, 5)} ${e164.slice(5, 7)}${'•'.repeat(Math.max(3, e164.length - 9))}${e164.slice(-2)}` : e164;

/** Swappable so a test checks the welcome without sending it. */
export const checkinWelcome = {
  send: async (input: { clientId: string; to: string; text: string; idempotencyKey: string }) => {
    // Loaded here: the WhatsApp module is the one that calls record(), and importing it at the top
    // would make each module wait on the other.
    const { sendShopText } = await import('../whatsapp/service');
    return sendShopText({ ...input, kind: 'WELCOME', referenceId: null, sentBy: null });
  }
};

export const doorCheckins = {
  /** contact.checked_in from the WhatsApp Service. Null when the code names no store of this shop. */
  async record(clientId: string, contactDigits: string, code: string, now = new Date()) {
    const phone = normalisePhone(`+${String(contactDigits).replace(/\D/g, '')}`);
    if (!phone.ok) return null;
    const store = await storeForCode(clientId, code);
    if (!store) return null;

    // Scanning twice, or a friend's phone scanning the same code: one arrival per visit.
    const same = await prisma.storeCheckin.findFirst({
      where: { clientId, locationId: store.id, phone: phone.value, createdAt: { gte: new Date(now.getTime() - VISIT_MS) } },
      orderBy: { createdAt: 'desc' }
    });
    if (same) {
      if (!same.takenAt) await prisma.storeCheckin.update({ where: { id: same.id }, data: { createdAt: now } });
      return { id: same.id, fresh: false };
    }

    const customer = await prisma.customer.findFirst({
      where: { clientId, phone: phone.value, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true }
    });
    const row = await prisma.storeCheckin.create({ data: { clientId, locationId: store.id, phone: phone.value, customerId: customer?.id ?? null, createdAt: now } });

    const shop = (await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } }))?.businessName?.trim() || 'the shop';
    const first = customer?.name.trim().split(/\s+/)[0];
    const text = first
      ? `Welcome back, ${first}! Someone from ${shop} will be with you in a moment.`
      : `Welcome to ${shop}! Someone will be with you in a moment.`;
    // Best effort: a shop whose WhatsApp is not linked still sees the customer in the list.
    await checkinWelcome.send({ clientId, to: phone.value, text, idempotencyKey: `welcome:${row.id}` })
      .catch(err => console.error('[door-checkin] welcome not sent:', (err as Error)?.message));
    return { id: row.id, fresh: true };
  },

  /** Who is in this store now: arrivals in the last two hours, newest first. */
  async list(clientId: string, locationId: unknown, now = new Date()) {
    if (typeof locationId !== 'string' || !locationId) throw badRequest('Say which store.');
    const rows = await prisma.storeCheckin.findMany({
      where: { clientId, locationId, createdAt: { gte: new Date(now.getTime() - VISIT_MS) } },
      orderBy: { createdAt: 'desc' }, take: 50
    });
    const ids = [...new Set(rows.map(r => r.customerId).filter((x): x is string => !!x))];
    const customers = ids.length ? await prisma.customer.findMany({ where: { id: { in: ids }, clientId }, select: { id: true, name: true, tags: true } }) : [];
    return Promise.all(rows.map(async r => {
      const c = customers.find(x => x.id === r.customerId);
      return {
        id: r.id, phone: r.phone, maskedPhone: mask(r.phone), at: r.createdAt,
        customer: c ? { id: c.id, name: c.name, groups: await groupNamesOf(clientId, c.tags) } : null,
        takenBy: r.takenByName, takenAt: r.takenAt
      };
    }));
  },

  /** "I'll take them": first salesperson wins, so two never walk up to the same customer. */
  async take(clientId: string, id: string, user: { id: string | null; name: string | null }) {
    const took = await prisma.storeCheckin.updateMany({
      where: { id, clientId, takenAt: null },
      data: { takenAt: new Date(), takenById: user.id, takenByName: user.name }
    });
    const row = await prisma.storeCheckin.findFirst({ where: { id, clientId } });
    if (!row) throw notFound('That arrival could not be found.');
    if (took.count === 0 && row.takenById !== user.id) throw conflict(`${row.takenByName || 'Someone'} is already with them.`);
    return { id: row.id, phone: row.phone };
  },

  /** What the door QR says and where it points, for printing the standee. */
  async doorQr(clientId: string, locationId: unknown) {
    if (typeof locationId !== 'string' || !locationId) throw badRequest('Say which store.');
    const store = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true, name: true } });
    if (!store) throw notFound('That store could not be found.');
    const shop = (await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } }))?.businessName?.trim() || 'the shop';
    const code = doorCode(clientId, store.id);
    const text = `Hi! I'm at ${shop}, ${store.name}. Check-in code: IN-${code}`;
    const { shopNumber } = await import('../whatsapp/service');
    const number = await shopNumber(clientId).catch(() => null);
    const digits = number?.status === 'CONNECTED' ? number.digits : null;
    return {
      shop, store: store.name, code: `IN-${code}`, text,
      number: digits, link: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null,
      reason: digits ? null : "Link the shop's WhatsApp number in Settings first. The QR opens a chat with that number."
    };
  }
};
