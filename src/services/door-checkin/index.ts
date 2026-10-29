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
import { badRequest, conflict, forbidden, notFound, HttpError } from '../../utils/httpError';
import { groupNamesOf } from '../customer-groups';

/** How long someone counts as "in the store now", and as the same visit if they scan twice. */
export const VISIT_MS = 2 * 60 * 60 * 1000;
/** Waiting this long with nobody taking them: the owner's bell, and one "sorry for the wait". */
export const WAIT_ALERT_MS = 5 * 60 * 1000;

/** "They asked for Lakshmi": a 409 that carries the name, so the screen can ask "take them anyway?". */
export class AskedForSomeoneElse extends HttpError {
  askedFor: string;
  constructor(customer: string, askedFor: string) {
    super(409, `${customer} asked for ${askedFor}.`);
    this.askedFor = askedFor;
  }
}

type Handoff = { fromId: string | null; fromName: string | null; toId: string; toName: string; at: string };
const handoffsOf = (raw: unknown): Handoff[] => (Array.isArray(raw) ? raw as Handoff[] : []);
type Actor = { id: string | null; name: string | null; owner?: boolean };

/** A salesperson of this shop: an active user here. */
async function personOf(clientId: string, userId: unknown) {
  if (typeof userId !== 'string' || !userId) return null;
  return prisma.user.findFirst({ where: { id: userId, clientId, status: 'ACTIVE' }, select: { id: true, name: true } });
}
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
      where: { clientId, locationId: store.id, phone: phone.value, doneAt: null, createdAt: { gte: new Date(now.getTime() - VISIT_MS) } },
      orderBy: { createdAt: 'desc' }
    });
    if (same) {
      if (!same.takenAt) await prisma.storeCheckin.update({ where: { id: same.id }, data: { createdAt: now } });
      return { id: same.id, fresh: false };
    }

    const customer = await prisma.customer.findFirst({
      where: { clientId, phone: phone.value, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, whatsappStoppedAt: true }
    });
    const row = await prisma.storeCheckin.create({ data: { clientId, locationId: store.id, phone: phone.value, customerId: customer?.id ?? null, createdAt: now, waitingSince: now } });

    const shop = (await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true } }))?.businessName?.trim() || 'the shop';
    const first = customer?.name.trim().split(/\s+/)[0];
    const text = first
      ? `Welcome back, ${first}! Someone from ${shop} will be with you in a moment.`
      : `Welcome to ${shop}! Someone will be with you in a moment.`;
    // Somebody who replied STOP gets nothing, not even this: the WhatsApp Service would refuse it
    // anyway, and the shop's message log would show a failed welcome for no reason.
    if (customer?.whatsappStoppedAt) return { id: row.id, fresh: true };
    // Best effort: a shop whose WhatsApp is not linked still sees the customer in the list.
    await checkinWelcome.send({ clientId, to: phone.value, text, idempotencyKey: `welcome:${row.id}` })
      .catch(err => console.error('[door-checkin] welcome not sent:', (err as Error)?.message));
    return { id: row.id, fresh: true };
  },

  /**
   * Who is in this store now, and who each salesperson is with.
   *
   * Arrivals of the last two hours that are not finished: those nobody has taken first, longest
   * waiting first, then those somebody is with. A taken customer with a bill at this store since
   * they were taken is finished by that bill (worked out here, so nothing else has to remember).
   * `staff` is everybody active in the shop, with how many customers each is with now.
   */
  async list(clientId: string, locationId: unknown, now = new Date()) {
    if (typeof locationId !== 'string' || !locationId) throw badRequest('Say which store.');
    let rows = await prisma.storeCheckin.findMany({
      where: { clientId, locationId, doneAt: null, createdAt: { gte: new Date(now.getTime() - VISIT_MS) } },
      orderBy: { createdAt: 'desc' }, take: 50
    });

    // Billed since they were taken: done.
    const billed: string[] = [];
    for (const r of rows.filter(r => r.takenAt && r.customerId)) {
      const bill = await prisma.salesOrder.findFirst({
        where: { clientId, locationId, customerId: r.customerId!, createdAt: { gt: r.takenAt! }, status: { not: 'CANCELLED' } }, select: { id: true }
      });
      if (bill) billed.push(r.id);
    }
    if (billed.length) {
      await prisma.storeCheckin.updateMany({ where: { id: { in: billed }, doneAt: null }, data: { doneAt: now } });
      rows = rows.filter(r => !billed.includes(r.id));
    }

    const ids = [...new Set(rows.map(r => r.customerId).filter((x): x is string => !!x))];
    const [customers, earlier, people] = await Promise.all([
      ids.length ? prisma.customer.findMany({ where: { id: { in: ids }, clientId }, select: { id: true, name: true, tags: true } }) : [],
      // Who helped them on an earlier visit, most recent first: "last time: Lakshmi".
      ids.length ? prisma.storeCheckin.findMany({
        where: { clientId, customerId: { in: ids }, takenById: { not: null }, id: { notIn: rows.map(r => r.id) } },
        orderBy: { createdAt: 'desc' }, select: { customerId: true, takenById: true, takenByName: true }
      }) : [],
      prisma.user.findMany({ where: { clientId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 40 })
    ]);
    const lastHelped = new Map<string, { id: string; name: string }>();
    for (const e of earlier) if (e.customerId && !lastHelped.has(e.customerId) && e.takenById) lastHelped.set(e.customerId, { id: e.takenById, name: e.takenByName ?? 'them' });

    const order = [...rows].sort((a, b) =>
      (a.takenAt ? 1 : 0) - (b.takenAt ? 1 : 0)
      || (a.takenAt ? b.takenAt!.getTime() - a.takenAt.getTime() : a.waitingSince.getTime() - b.waitingSince.getTime()));
    const arrivals = await Promise.all(order.map(async r => {
      const c = customers.find(x => x.id === r.customerId);
      const last = handoffsOf(r.handoffs).at(-1);
      return {
        id: r.id, phone: r.phone, maskedPhone: mask(r.phone), at: r.createdAt, waitingSince: r.waitingSince,
        customer: c ? { id: c.id, name: c.name, groups: await groupNamesOf(clientId, c.tags) } : null,
        takenBy: r.takenByName, takenById: r.takenById, takenAt: r.takenAt,
        askedFor: r.askedForId ? { id: r.askedForId, name: r.askedForName ?? 'them' } : null,
        lastHelpedBy: c ? lastHelped.get(c.id) ?? null : null,
        passedBy: last && last.toId === r.takenById ? last.fromName : null,
        waitAlerted: !!r.waitAlertedAt
      };
    }));
    const staff = people.map(p => ({ id: p.id, name: p.name, with: rows.filter(r => r.takenById === p.id).length }));
    return { arrivals, staff };
  },

  /**
   * "I'll take them": first salesperson wins, so two never walk up to the same customer. If they
   * asked for somebody else, that is said first (AskedForSomeoneElse); `anyway` takes them all the same.
   */
  async take(clientId: string, id: string, user: Actor, anyway = false) {
    const row = await prisma.storeCheckin.findFirst({ where: { id, clientId } });
    if (!row) throw notFound('That arrival could not be found.');
    if (row.doneAt) throw conflict('They have already been helped.');
    if (!row.takenAt && row.askedForId && row.askedForId !== user.id && !anyway) {
      const name = row.customerId ? (await prisma.customer.findFirst({ where: { id: row.customerId, clientId }, select: { name: true } }))?.name : null;
      throw new AskedForSomeoneElse(name || 'They', row.askedForName || 'someone');
    }
    const took = await prisma.storeCheckin.updateMany({
      where: { id, clientId, takenAt: null },
      data: { takenAt: new Date(), takenById: user.id, takenByName: user.name }
    });
    const after = await prisma.storeCheckin.findFirstOrThrow({ where: { id, clientId } });
    if (took.count === 0 && after.takenById !== user.id) throw conflict(`${after.takenByName || 'Someone'} is already with them.`);
    // Somebody has them now: the waiting alert, if one went up, is settled.
    if (after.waitAlertId) await prisma.inventoryAlert.updateMany({ where: { id: after.waitAlertId, clientId }, data: { isResolved: true } }).catch(() => null);
    return { id: after.id, phone: after.phone, takenBy: after.takenByName };
  },

  /** "They asked for Lakshmi": shown to that person first. null: nobody in particular. */
  async askFor(clientId: string, id: string, userId: unknown) {
    const row = await prisma.storeCheckin.findFirst({ where: { id, clientId, doneAt: null } });
    if (!row) throw notFound('That arrival could not be found.');
    if (row.takenAt) throw conflict(`${row.takenByName || 'Someone'} is already with them.`);
    if (userId === null || userId === '') {
      await prisma.storeCheckin.update({ where: { id }, data: { askedForId: null, askedForName: null } });
      return { askedFor: null };
    }
    const person = await personOf(clientId, userId);
    if (!person) throw badRequest('Choose somebody who works in this shop.');
    await prisma.storeCheckin.update({ where: { id }, data: { askedForId: person.id, askedForName: person.name } });
    return { askedFor: { id: person.id, name: person.name } };
  },

  /** Pass a customer to another salesperson: by the person with them, or the owner. Kept on the record. */
  async pass(clientId: string, id: string, toUserId: unknown, actor: Actor) {
    const row = await prisma.storeCheckin.findFirst({ where: { id, clientId, doneAt: null } });
    if (!row) throw notFound('That arrival could not be found.');
    if (!row.takenAt) throw badRequest('Nobody is with them yet. Take them first, or say who they asked for.');
    if (row.takenById !== actor.id && !actor.owner) throw forbidden('Only the person with them, or the owner, can pass them on.');
    const to = await personOf(clientId, toUserId);
    if (!to) throw badRequest('Choose somebody who works in this shop.');
    if (to.id === row.takenById) throw badRequest(`They are already with ${to.name}.`);
    const handoffs = [...handoffsOf(row.handoffs), { fromId: row.takenById, fromName: row.takenByName, toId: to.id, toName: to.name, at: new Date().toISOString() }];
    // Only if they are still where this person saw them: two passes at once cannot both land.
    const moved = await prisma.storeCheckin.updateMany({
      where: { id, clientId, takenById: row.takenById, doneAt: null },
      data: { takenById: to.id, takenByName: to.name, takenAt: new Date(), handoffs: handoffs as any }
    });
    if (moved.count === 0) throw conflict('Someone moved them a moment ago. Look again.');
    return { id, takenBy: to.name, takenById: to.id };
  },

  /** Finished with them: the person with them, or the owner. */
  async done(clientId: string, id: string, actor: Actor) {
    const row = await prisma.storeCheckin.findFirst({ where: { id, clientId } });
    if (!row) throw notFound('That arrival could not be found.');
    if (row.doneAt) return { id, done: true };
    if (!row.takenAt) throw badRequest('Nobody is with them yet.');
    if (row.takenById !== actor.id && !actor.owner) throw forbidden('Only the person with them, or the owner, can finish with them.');
    await prisma.storeCheckin.updateMany({ where: { id, clientId, doneAt: null }, data: { doneAt: new Date() } });
    return { id, done: true };
  },

  /**
   * Customers who have waited WAIT_ALERT_MS with nobody taking them: the owner's bell (CUSTOMER_WAITING)
   * and one "sorry for the wait" on WhatsApp, which is a reply to the message they sent from the door.
   * Each arrival once, claimed first, so two servers never both send. `onlyClients` scopes it for tests.
   */
  async waitTick(now = new Date(), onlyClients?: string[]) {
    const due = await prisma.storeCheckin.findMany({
      where: {
        takenAt: null, doneAt: null, waitAlertedAt: null,
        createdAt: { gte: new Date(now.getTime() - VISIT_MS) },
        waitingSince: { lte: new Date(now.getTime() - WAIT_ALERT_MS) },
        ...(onlyClients ? { clientId: { in: onlyClients } } : {})
      },
      take: 100
    });
    let raised = 0;
    for (const r of due) {
      const claimed = await prisma.storeCheckin.updateMany({ where: { id: r.id, waitAlertedAt: null, takenAt: null }, data: { waitAlertedAt: now } });
      if (claimed.count === 0) continue;
      const [customer, store, settings] = await Promise.all([
        r.customerId ? prisma.customer.findFirst({ where: { id: r.customerId, clientId: r.clientId }, select: { name: true, whatsappStoppedAt: true } }) : null,
        prisma.stockLocation.findFirst({ where: { id: r.locationId, clientId: r.clientId }, select: { name: true } }),
        prisma.clientSettings.findUnique({ where: { clientId: r.clientId }, select: { businessName: true } })
      ]);
      const mins = Math.max(1, Math.round((now.getTime() - r.waitingSince.getTime()) / 60000));
      const who = customer?.name || `A customer (${mask(r.phone)})`;
      const alert = await prisma.inventoryAlert.create({
        data: {
          clientId: r.clientId, type: 'CUSTOMER_WAITING' as any, severity: 'WARNING', locationId: r.locationId,
          title: `${customer?.name || 'A customer'} is waiting at ${store?.name ?? 'the store'}`,
          message: `${who} has waited ${mins} minutes at ${store?.name ?? 'the store'} with nobody taking them. Open the Customer card to take them.`
        }
      });
      await prisma.storeCheckin.update({ where: { id: r.id }, data: { waitAlertId: alert.id } });
      raised++;
      // Nobody who replied STOP is written to, not even this.
      if (customer?.whatsappStoppedAt) continue;
      const shop = settings?.businessName?.trim() || 'the shop';
      const first = customer?.name.trim().split(/\s+/)[0];
      const text = first
        ? `Sorry for the wait, ${first}. Someone from ${shop} will be with you in a few minutes.`
        : `Sorry for the wait. Someone from ${shop} will be with you in a few minutes.`;
      await checkinWelcome.send({ clientId: r.clientId, to: r.phone, text, idempotencyKey: `sorry:${r.id}` })
        .catch(err => console.error('[door-checkin] sorry-for-the-wait not sent:', (err as Error)?.message));
    }
    return { raised };
  },

  /** What the door QR says and where it points, for printing the standee. */
  async doorQr(clientId: string, locationId: unknown) {
    if (typeof locationId !== 'string' || !locationId) throw badRequest('Say which store.');
    const store = await prisma.stockLocation.findFirst({ where: { id: locationId, clientId }, select: { id: true, name: true } });
    if (!store) throw notFound('That store could not be found.');
    const settings = await prisma.clientSettings.findUnique({ where: { clientId }, select: { businessName: true, businessPhone: true, logoUrl: true } });
    const shop = settings?.businessName?.trim() || 'the shop';
    const code = doorCode(clientId, store.id);
    const text = `Hi! I'm at ${shop}, ${store.name}. Check-in code: IN-${code}`;
    const { shopNumber } = await import('../whatsapp/service');
    const linked = await shopNumber(clientId).catch(() => null);
    const base = { shop, store: store.name, logo: settings?.logoUrl ?? null, code: `IN-${code}`, text, number: null as string | null, link: null as string | null };
    const n = doorNumber(linked, settings?.businessPhone);
    if ('reason' in n) return { ...base, ...n };
    return { ...base, fix: null, number: n.digits, link: `https://wa.me/${n.digits}?text=${encodeURIComponent(text)}`, reason: null };
  }
};

/**
 * Which number the door QR opens. The WhatsApp service only ever gives the last 4 digits of the
 * linked phone (it masks on purpose), so the full number is the shop's own verified phone, and it
 * must end the same way -- otherwise the QR would open a chat nobody reads.
 */
export function doorNumber(linked: { status: string; digits: string | null } | null, businessPhone: string | null | undefined): { digits: string } | { fix: string; reason: string } {
  if (linked?.status !== 'CONNECTED') return { fix: 'WHATSAPP', reason: "Link the shop's WhatsApp number in Settings first. The QR opens a chat with that number." };
  const own = normalisePhone(businessPhone);
  const digits = own.ok ? own.value.replace(/\D/g, '') : null;
  const last4 = (linked.digits ?? '').replace(/\D/g, '').slice(-4);
  if (!digits) return { fix: 'GENERAL', reason: "Add the shop's phone number in Settings → Profile and shop details. The QR opens a WhatsApp chat with it." };
  if (last4.length < 4 || !digits.endsWith(last4)) {
    return { fix: 'GENERAL', reason: `The shop phone in Settings (••••${digits.slice(-4)}) is not the number linked to WhatsApp (••••${last4 || '????'}). Make them the same so the QR reaches your WhatsApp.` };
  }
  return { digits };
}
