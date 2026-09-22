import { monthDay } from './loyalty/rules';
import { normaliseTags } from './offers/rules';
import { literal } from '../utils/likeText';
import { prisma } from '../lib/prisma';
import { generateSequentialCode, generateFreeSequentialCode } from '../utils/codeGenerator';
import { notFound, badRequest } from '../utils/httpError';
import { normalisePhone, phoneSearchDigits } from '../lib/phone';
import { CustomerStatus, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Who already has this number, locked for the rest of the transaction.
 *
 * The lock is keyed on the shop and the number, so two tills saving DIFFERENT people never wait for
 * each other, and two saving the same number one after the other see each other's write.
 */
async function holderOf(tx: Tx, clientId: string, phone: string, exceptId?: string) {
  const key = `customer:${clientId}:${phone}`;
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and Prisma cannot
  // deserialise a void column -- $queryRaw fails the whole request with a message about
  // Unsupported types that has nothing to do with what went wrong.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  return tx.customer.findFirst({
    where: { clientId, phone, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true, customerCode: true }
  });
}

/**
 * The number in its stored form, or a 400 saying why not. The route's schema has normally done this
 * already; it is repeated here because scripts, imports and other services call the service directly,
 * and a raw "98480 22338" stored by one of them would never match the same person typed at the till.
 */
function storedPhone(raw: unknown): string {
  const result = normalisePhone(raw);
  if (!result.ok) throw badRequest(result.reason);
  return result.value;
}

/** "Priya Sharma (CUS-000041) is already saved with that number", carrying who, for a link. */
function takenBy(holder: { id: string; name: string; customerCode: string }) {
  return Object.assign(
    new Error(`${holder.name} (${holder.customerCode}) is already saved with that number.`),
    {
      statusCode: 409, existingCustomerId: holder.id, existingCustomerName: holder.name, existingCustomerCode: holder.customerCode,
      // The same, in the shape respondWithError passes on, for routes that answer through it.
      details: { code: 'PHONE_TAKEN', existingCustomerId: holder.id, existingCustomerName: holder.name, existingCustomerCode: holder.customerCode }
    }
  );
}

/**
 * The database's own refusal of a second customer on one number, said the same way. The lock above
 * means it should not happen through this service; it is here for writes that do not go through it,
 * so the person still reads a sentence rather than a constraint name.
 */
async function explainDuplicate(error: any, clientId: string, phone?: string | null) {
  if (error?.code === 'P2002' && phone && String(error?.meta?.target ?? '').includes('phone')) {
    const holder = await prisma.customer.findFirst({ where: { clientId, phone, deletedAt: null }, select: { id: true, name: true, customerCode: true } });
    if (holder) return takenBy(holder);
  }
  return error;
}

/**
 * The phone for a customer arriving from outside the shop -- a website checkout, a Shopify order.
 *
 * Not required: an online checkout may carry none. Stored in its one form when it is a real number.
 * But when that number already belongs to another customer, the new one is saved WITHOUT it: a
 * number typed at somebody else's checkout is not proof of who they are, and matching on it would
 * put a stranger's web orders on a regular's page. The number still travels on the order itself.
 *
 * Must run inside a transaction: the lock it takes is what stops two orders arriving together from
 * both claiming the same free number.
 */
export async function phoneForOutsideCustomer(tx: Tx, clientId: string, raw: unknown): Promise<{ onCustomer: string | null; onOrder: string | null }> {
  const typed = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!typed) return { onCustomer: null, onOrder: null };
  const result = normalisePhone(typed);
  if (!result.ok) return { onCustomer: null, onOrder: typed };
  const holder = await holderOf(tx, clientId, result.value);
  return { onCustomer: holder ? null : result.value, onOrder: result.value };
}

/**
 * The customer at the counter: the one chosen, the one saved with this number, or a new one.
 *
 * Inside the sale's transaction, so a sale that fails leaves no customer behind, and under the
 * number's lock, so two tills ringing up the same new person at once make one customer, not two.
 * A number already saved is that customer -- the screen looked them up a moment ago, and if another
 * till saved them in between, it is still the same person standing there.
 *
 * A customer chosen by id who was saved before phones were required gets the number now, if the
 * screen sent one; a counter sale is how a shop finds people, so it does not go ahead without one.
 */
export async function counterCustomer(
  tx: Tx, clientId: string, input: { id?: string | null; phone?: unknown; name?: unknown; email?: unknown }
) {
  const select = { id: true, name: true, phone: true } as const;

  if (input.id) {
    const chosen = await tx.customer.findFirst({ where: { id: input.id, clientId, deletedAt: null }, select });
    if (!chosen) throw notFound('That customer was not found.');
    if (chosen.phone) return chosen;

    const typed = input.phone === null || input.phone === undefined ? '' : String(input.phone).trim();
    if (!typed) {
      throw Object.assign(badRequest(`Add a phone number for ${chosen.name} to sell to them.`), {
        details: { code: 'CUSTOMER_NEEDS_PHONE', customerId: chosen.id }
      });
    }
    const phone = storedPhone(typed);
    const holder = await holderOf(tx, clientId, phone, chosen.id);
    if (holder) throw takenBy(holder);
    return tx.customer.update({ where: { id: chosen.id }, data: { phone }, select });
  }

  const phone = storedPhone(input.phone);
  const holder = await holderOf(tx, clientId, phone);
  if (holder) return tx.customer.findFirstOrThrow({ where: { id: holder.id }, select });

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw badRequest("Add the customer's name.");
  const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim() : null;
  const customerCode = await generateFreeSequentialCode(clientId, 'CUS', 'CUSTOMER', tx,
    async (code) => !!(await tx.customer.findFirst({ where: { clientId, customerCode: code }, select: { id: true } })));
  return tx.customer.create({ data: { clientId, customerCode, name, phone, email, status: 'ACTIVE' }, select });
}

export class CustomerService {
  /**
   * The same customer, saved twice.
   *
   * Nothing checked, so a double-click created two rows -- proven with two identical requests
   * fired together, both answered 201. That is not a tidiness problem. A shop identifies a
   * customer by their phone number, and two rows for one person splits their order history in
   * half: the returns screen, their spend, and "has she bought this before" all quietly answer
   * from whichever copy the till happened to pick.
   *
   * Guarded with an advisory lock rather than a plain look-up-then-insert, because a look-up
   * loses the exact race it is meant to catch -- both requests read "nobody has this number"
   * before either writes. The lock is held for the length of the transaction and keyed on the
   * tenant and the number, so two people adding DIFFERENT customers never wait for each other.
   * The same reasoning as the FOR UPDATE in inventory-mutation.service.ts.
   *
   * Behind it, a unique index on (client_id, phone) for live customers is the last word: the lock
   * gives the person a sentence naming who has the number, the index makes sure no path that
   * skips this service can store a second one.
   */
  async createCustomer(clientId: string, data: any) {
    // The phone arrives already in its one stored form (validations/customer.schema), and it is the
    // identity: one number, one customer. Email is not -- a family shares one far more often than a
    // mobile -- so two people on one email address are two customers.
    const phone = storedPhone(data.phone);

    return prisma.$transaction(async tx => {
      const holder = await holderOf(tx, clientId, phone);
      // Says who it already is, so the person at the counter can go straight to them instead of
      // guessing what they typed wrong.
      if (holder) throw takenBy(holder);

      // `tx` threaded through deliberately. Called on the base client it would open a SECOND
      // connection while this transaction still holds one -- which is both the pool deadlock
      // this codebase warns about elsewhere and, measured here, a five-second wait that blew
      // the interactive transaction timeout outright. It also means a number taken by a create
      // that then fails rolls back with it, instead of leaving a permanent hole in the
      // customer numbering that nobody can account for.
      const customerCode = await generateSequentialCode(clientId, 'CUS', 'CUSTOMER', tx as any);
      return tx.customer.create({
        data: {
          clientId,
          customerCode,
          name: String(data.name).trim(),
          companyName: data.companyName,
          phone,
          email: data.email,
          gstNumber: data.gstNumber,
          billingAddress: data.billingAddress,
          shippingAddress: data.shippingAddress,
          status: data.status || 'ACTIVE',
          // Groups sent with a new customer are kept. Only the update path wrote them, so a customer
          // created as a VIP came back in no group and no VIP offer ever reached them.
          tags: normaliseTags(data.tags),
          birthday: monthDay(data.birthday),
          anniversary: monthDay(data.anniversary),
        }
      });
    }, {
      // Four round trips -- lock, look up, take the next number, insert -- against a database
      // that is not in the same region as this server, so each one costs a few hundred
      // milliseconds before it does any work. Prisma's default 5s ceiling was fine for one
      // request at a time and failed the moment ten arrived together: measured at 6.3s each,
      // every one of them rejected with a timeout the shopkeeper would read as "save failed"
      // for no reason they could see.
      //
      // maxWait covers queueing for a pooled connection when several arrive at once; timeout
      // covers the work itself. Both are generous rather than tight because the cost here is
      // latency, not computation -- and a customer that saves slowly is much better than one
      // that does not save at all.
      maxWait: 15000,
      timeout: 20000
    }).catch(async error => { throw await explainDuplicate(error, clientId, phone); });
  }

  /**
   * The customer with exactly this number, for the counter's lookup. The number arrives in its
   * stored form; null when nobody has it, which at a counter just means "new customer".
   */
  async findByPhone(clientId: string, phone: string) {
    return prisma.customer.findFirst({
      where: { clientId, phone, deletedAt: null },
      select: {
        id: true, customerCode: true, name: true, phone: true, email: true, tags: true, status: true,
        // The counter shows whether they agreed to offers (so the tick is not asked twice) and their points.
        whatsappOffers: true, whatsappStoppedAt: true, loyaltyPoints: true,
        salesOrders: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true, orderNumber: true } }
      }
    });
  }

  async getCustomers(clientId: string, filters: any = {}) {
    const where: any = { clientId, deletedAt: null };

    if (filters.search) {
      const search = String(filters.search).trim();
      // Numbers are stored as "+919848022338", so the digits typed are what to look for: "98480
      // 22338" and "098480-22338" both have to find her, and neither is a substring as typed.
      const digits = phoneSearchDigits(search);
      where.OR = [
        { name: { contains: literal(search), mode: 'insensitive' } },
        { customerCode: { contains: literal(search), mode: 'insensitive' } },
        { phone: { contains: literal(search), mode: 'insensitive' } },
        ...(digits ? [{ phone: { contains: digits } }] : []),
        { email: { contains: literal(search), mode: 'insensitive' } }
      ];
    }

    if (filters.status) {
      where.status = filters.status;
    }

    return prisma.customer.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });
  }

  async getCustomerById(clientId: string, id: string) {
    const customer = await prisma.customer.findFirst({
      where: { clientId, id, deletedAt: null },
      include: {
        salesOrders: {
          orderBy: { createdAt: 'desc' },
          // Returns are started from this page, so an order that is not listed cannot be returned.
          // Ten meant a regular's eleventh-latest sale could never come back.
          take: 100,
          // The Dispatches tab derives its list from customer.salesOrders[i].dispatches,
          // and the "Create Return Request" flow then reads dispatch.items to work out
          // what's still returnable -- both were undefined before, so the tab showed
          // "No dispatches" for everyone and the return button threw on .filter().
          include: {
            dispatches: {
              include: {
                items: {
                  include: {
                    // What each line IS, so a return can say "Cotton Blouse, Green, M" instead of Item 2.
                    salesOrderItem: { select: { variant: { select: { sku: true, colorName: true, size: true, product: { select: { title: true } } } } } },
                    // Pieces already on a return that is still open, so the screen does not offer them twice.
                    returnItems: { where: { salesReturn: { status: { in: ['REQUESTED', 'RECEIVED', 'INSPECTED'] } } }, select: { quantity: true } }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!customer) {
      throw notFound(`Customer ${id} not found`);
    }

    for (const order of customer.salesOrders as any[]) {
      for (const dispatch of order.dispatches) {
        for (const item of dispatch.items) {
          item.openReturnQty = item.returnItems.reduce((sum: number, r: any) => sum + r.quantity, 0);
          delete item.returnItems;
        }
      }
    }

    return customer;
  }

  async updateCustomer(clientId: string, id: string, data: any) {
    // Ensure customer belongs to client
    // Not a deleted one: an edit brought a deleted customer's number back into use under them.
    const existing = await prisma.customer.findFirst({ where: { clientId, id, deletedAt: null } });
    if (!existing) throw notFound('Customer not found');

    // A new number is checked against everybody else under the same lock a new customer takes, so
    // an edit cannot quietly give this customer somebody else's number.
    if (data.phone !== undefined) {
      if (data.phone === null || String(data.phone).trim() === '') {
        throw badRequest('A customer needs a phone number. Enter the new one instead of clearing it.');
      }
      data = { ...data, phone: storedPhone(data.phone) };
    }
    if (data.phone !== undefined && data.phone !== existing.phone) {
      return prisma.$transaction(async tx => {
        const holder = await holderOf(tx, clientId, data.phone, id);
        if (holder) throw takenBy(holder);
        return tx.customer.update({ where: { id }, data: this.editable(data) });
      }, { maxWait: 15000, timeout: 20000 })
        .catch(async error => { throw await explainDuplicate(error, clientId, data.phone); });
    }

    return prisma.customer.update({ where: { id }, data: this.editable(data) });
  }

  private editable(data: any) {
    return {
        name: data.name,
        companyName: data.companyName,
        phone: data.phone,
        email: data.email,
        gstNumber: data.gstNumber,
        billingAddress: data.billingAddress,
        shippingAddress: data.shippingAddress,
        status: data.status,
        ...(data.tags !== undefined ? { tags: normaliseTags(data.tags) } : {}),
        ...(data.birthday !== undefined ? { birthday: monthDay(data.birthday) } : {}),
        ...(data.anniversary !== undefined ? { anniversary: monthDay(data.anniversary) } : {}),
    };
  }
}

export const customerService = new CustomerService();
