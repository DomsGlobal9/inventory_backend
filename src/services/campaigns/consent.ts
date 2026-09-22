/**
 * Who may hear about offers on WhatsApp.
 *
 * A campaign reaches only customers the shop has recorded as agreeing -- ticked at the counter, or
 * on the customer's page -- and never anyone who replied STOP. Who recorded the yes, and when, is
 * kept: under the DPDP Act the shop must be able to show that the customer agreed.
 *
 * STOP is the customer's own word and outranks everything here. Only the customer can undo it (by
 * messaging the shop), so no screen in this app turns it back on.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, forbidden, notFound } from '../../utils/httpError';
import { grants, holdsEverything } from '../../config/permissions';

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; clientId: string; permissions?: string[]; roles?: string[] };
const may = (a: Actor, key: string) => holdsEverything(a.permissions, a.roles) || grants(a.permissions ?? [], key);

/** Record a yes, inside the caller's transaction. A customer who replied STOP stays stopped. */
export async function recordOffersConsent(tx: Tx, clientId: string, customerId: string, byUserId: string | null) {
  await tx.customer.updateMany({
    where: { id: customerId, clientId, whatsappOffers: false, whatsappStoppedAt: null },
    data: { whatsappOffers: true, whatsappOffersAt: new Date(), whatsappOffersBy: byUserId }
  });
}

/** Yes or no from the customer's page. */
export async function setOffersConsent(actor: Actor, customerId: string, agreed: unknown) {
  if (!may(actor, 'customer:update')) throw forbidden('Changing a customer is not part of your role.');
  if (typeof agreed !== 'boolean') throw badRequest('Say whether the customer agreed.');
  const c = await prisma.customer.findFirst({
    where: { id: customerId, clientId: actor.clientId, deletedAt: null },
    select: { id: true, whatsappStoppedAt: true, phone: true }
  });
  if (!c) throw notFound('Customer not found');
  if (agreed && c.whatsappStoppedAt) {
    throw badRequest('This customer replied STOP on WhatsApp. Only they can start offers again, by sending the shop a message.');
  }
  if (agreed && !c.phone) throw badRequest('Add a phone number for this customer first.');
  await prisma.customer.update({
    where: { id: c.id },
    data: agreed
      ? { whatsappOffers: true, whatsappOffersAt: new Date(), whatsappOffersBy: actor.id }
      : { whatsappOffers: false, whatsappOffersAt: new Date(), whatsappOffersBy: actor.id }
  });
  return offersState(actor.clientId, c.id);
}

/**
 * Many customers at once, for a shop that has always asked its customers and wants its list in.
 * The person must confirm that these customers agreed; the confirmation is kept as their user id
 * on every customer marked.
 */
export async function markManyAgreed(actor: Actor, input: { customerIds?: unknown; confirmed?: unknown }) {
  if (!may(actor, 'campaign:send')) throw forbidden('Sending campaigns is not part of your role.');
  if (input.confirmed !== true) throw badRequest('Confirm that these customers agreed to hear about offers on WhatsApp.');
  const ids = Array.isArray(input.customerIds) ? input.customerIds.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length === 0) throw badRequest('Choose the customers who agreed.');
  if (ids.length > 5000) throw badRequest('Mark at most 5,000 customers at a time.');
  const r = await prisma.customer.updateMany({
    where: { id: { in: ids }, clientId: actor.clientId, deletedAt: null, whatsappOffers: false, whatsappStoppedAt: null, phone: { not: null } },
    data: { whatsappOffers: true, whatsappOffersAt: new Date(), whatsappOffersBy: actor.id }
  });
  return { marked: r.count, skipped: ids.length - r.count };
}

export async function offersState(clientId: string, customerId: string) {
  const c = await prisma.customer.findFirst({
    where: { id: customerId, clientId },
    select: { whatsappOffers: true, whatsappOffersAt: true, whatsappOffersBy: true, whatsappStoppedAt: true, birthday: true, anniversary: true }
  });
  if (!c) throw notFound('Customer not found');
  const by = c.whatsappOffersBy
    ? await prisma.user.findFirst({ where: { id: c.whatsappOffersBy }, select: { name: true } }).catch(() => null)
    : null;
  return {
    agreed: c.whatsappOffers && !c.whatsappStoppedAt,
    changedAt: c.whatsappOffersAt,
    changedBy: by?.name ?? null,
    stoppedAt: c.whatsappStoppedAt,
    birthday: c.birthday,
    anniversary: c.anniversary
  };
}

/**
 * STOP from the service: the number in digits ("919848022338"). Every live customer of that shop
 * with that number stops getting offers.
 */
export async function markStopped(clientId: string, digits: string) {
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 8) return 0;
  const r = await prisma.customer.updateMany({
    where: { clientId, phone: `+${clean}`, whatsappStoppedAt: null },
    data: { whatsappStoppedAt: new Date(), whatsappOffers: false }
  });
  return r.count;
}
