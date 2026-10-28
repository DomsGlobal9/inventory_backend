import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../utils/httpError';

/**
 * Deleting a customer (owner only, 29 Oct 2026).
 *
 * A customer with NO money history -- no bill, no points or credit movement, no offer used -- is
 * REMOVED for good: the row, their addresses, and everything tied to their number (try-ons, hearts,
 * door check-ins, counter look-ups, phone codes, campaign sends).
 *
 * A customer WITH bills cannot be removed: the bills point at them, and GST law keeps invoices for
 * eight years. They are ERASED instead: the personal details on the customer go (name -> "Removed
 * customer", phone, email, addresses, birthday, anniversary, notes, groups, GSTIN, company), WhatsApp
 * offers are switched off, the same number-tied records are removed, and the row is marked deleted so it
 * leaves every list and the number is free to come back as somebody new. The bills themselves are not
 * touched -- they are the tax record, kept as they were printed.
 *
 * Refused while money is still owed or goods are still to go: store credit to pay out, or an order not
 * yet sent. The database triggers tell CRM (customer.updated / customer.deleted).
 */

const OPEN_ORDER = ['DRAFT', 'CONFIRMED', 'PARTIALLY_DISPATCHED'] as const;

async function load(clientId: string, id: string) {
  const c = await prisma.customer.findFirst({
    where: { id, clientId, deletedAt: null },
    select: { id: true, name: true, phone: true, loyaltyPoints: true, storeCreditPaise: true }
  });
  if (!c) throw notFound('That customer was not found.');
  const [bills, open, points, credit, offers] = await Promise.all([
    prisma.salesOrder.count({ where: { clientId, customerId: id } }),
    prisma.salesOrder.findFirst({ where: { clientId, customerId: id, deletedAt: null, status: { in: [...OPEN_ORDER] } }, select: { orderNumber: true } }),
    prisma.loyaltyEntry.count({ where: { customerId: id } }),
    prisma.storeCreditEntry.count({ where: { customerId: id } }),
    prisma.offerRedemption.count({ where: { customerId: id } })
  ]);
  const last4 = (c.phone ?? '').replace(/\D/g, '').slice(-4) || null;
  const blocked = c.storeCreditPaise > 0
    ? `${c.name} has ₹${(c.storeCreditPaise / 100).toLocaleString('en-IN')} store credit. Pay it out, or let them use it, first.`
    : open ? `${c.name} has an order still to go out (${open.orderNumber}). Send it or cancel it first.`
    : null;
  return { c, last4, mode: (bills || points || credit || offers ? 'ERASE' : 'REMOVE') as 'ERASE' | 'REMOVE', bills, blocked };
}

/** What deleting would do, for the confirmation box. */
export async function preview(clientId: string, id: string) {
  const { c, last4, mode, bills, blocked } = await load(clientId, id);
  return { name: c.name, phoneLast4: last4, mode, bills, loyaltyPoints: c.loyaltyPoints, blocked };
}

/** Delete (remove or erase). `confirm` must be the last 4 digits of their number, or their name when they have none. */
export async function deleteCustomer(clientId: string, id: string, confirmRaw: unknown) {
  const { c, last4, mode, blocked } = await load(clientId, id);
  if (blocked) throw conflict(blocked);
  const confirm = String(confirmRaw ?? '').trim();
  const expected = last4 ?? c.name.trim();
  if (!confirm || confirm.toLowerCase() !== expected.toLowerCase()) {
    throw badRequest(last4 ? 'Type the last 4 digits of their number to confirm.' : 'Type their name to confirm.');
  }
  const phone = c.phone;

  await prisma.$transaction(async (tx) => {
    // Tied to the number: what they looked at and tried on, their phone code, door check-ins, look-ups.
    if (phone) {
      await tx.shopProductView.deleteMany({ where: { clientId, phone } });
      await tx.onlineShopPhoneCode.deleteMany({ where: { clientId, phone } });
    }
    // By customer, and by number: a check-in from before they were a customer carries only the number.
    await tx.storeCheckin.deleteMany({ where: { clientId, OR: [{ customerId: id }, ...(phone ? [{ phone }] : [])] } });
    await tx.counterLookup.deleteMany({ where: { clientId, customerId: id } });
    await tx.customerAddress.deleteMany({ where: { customerId: id } });
    // Links that are not records of them: cleared.
    await tx.pricingQuote.updateMany({ where: { customerId: id }, data: { customerId: null } });
    await tx.posHold.updateMany({ where: { customerId: id }, data: { customerId: null } });

    if (mode === 'REMOVE') {
      await tx.campaignRecipient.deleteMany({ where: { customerId: id } });
      await tx.customer.delete({ where: { id } });
    } else {
      await tx.customer.update({
        where: { id },
        data: {
          name: 'Removed customer', companyName: null, phone: null, email: null, gstNumber: null,
          billingAddress: null, shippingAddress: null, notes: null, tags: [], birthday: null, anniversary: null,
          whatsappOffers: false, whatsappOffersAt: null, whatsappOffersBy: null,
          // Points are left as the ledger says (the balance must match its history); a deleted customer
          // cannot spend them, so they go with the customer.
          externalCustomerId: null, deletedAt: new Date()
        }
      });
    }
  });
  return { mode, name: c.name };
}
