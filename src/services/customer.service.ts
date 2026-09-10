import { prisma } from '../lib/prisma';
import { generateSequentialCode } from '../utils/codeGenerator';
import { CustomerStatus } from '@prisma/client';
import { notFound } from '../utils/httpError';

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
   * A unique index would be stronger still, and is the right thing eventually -- but tenants
   * already hold duplicates created before this existed, so that migration needs a clean-up
   * first and cannot be slipped in underneath a running shop.
   */
  async createCustomer(clientId: string, data: any) {
    // Phone first: it is what a shop actually recognises somebody by. Email only when there is
    // no number. Neither present means we have nothing to match on, and two walk-ins called
    // "Priya" are genuinely two customers.
    const identity: string | null =
      (data.phone && String(data.phone).trim()) || (data.email && String(data.email).trim()) || null;

    return prisma.$transaction(async tx => {
      if (identity) {
        const key = `customer:${clientId}:${identity.toLowerCase()}`;
        // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and Prisma cannot
        // deserialise a void column -- $queryRaw fails the whole request with a message about
        // Unsupported types that has nothing to do with what went wrong.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

        const existing = await tx.customer.findFirst({
          where: {
            clientId,
            deletedAt: null,
            OR: [
              ...(data.phone ? [{ phone: String(data.phone).trim() }] : []),
              ...(data.email ? [{ email: String(data.email).trim() }] : [])
            ]
          },
          select: { id: true, name: true, customerCode: true, phone: true, email: true }
        });

        if (existing) {
          // Says who it already is, so the person at the counter can go straight to them
          // instead of guessing what they typed wrong.
          throw Object.assign(
            new Error(`${existing.name} (${existing.customerCode}) is already saved with that ${data.phone ? 'number' : 'email address'}.`),
            { statusCode: 409, existingCustomerId: existing.id }
          );
        }
      }

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
          phone: data.phone,
          email: data.email,
          gstNumber: data.gstNumber,
          billingAddress: data.billingAddress,
          shippingAddress: data.shippingAddress,
          status: data.status || 'ACTIVE',
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
    });
  }

  async getCustomers(clientId: string, filters: any = {}) {
    const where: any = { clientId, deletedAt: null };
    
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { customerCode: { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } }
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
          take: 10,
          // The Dispatches tab derives its list from customer.salesOrders[i].dispatches,
          // and the "Create Return Request" flow then reads dispatch.items to work out
          // what's still returnable -- both were undefined before, so the tab showed
          // "No dispatches" for everyone and the return button threw on .filter().
          include: { dispatches: { include: { items: true } } }
        }
      }
    });

    if (!customer) {
      throw notFound(`Customer ${id} not found`);
    }

    return customer;
  }

  async updateCustomer(clientId: string, id: string, data: any) {
    // Ensure customer belongs to client
    const existing = await prisma.customer.findFirst({ where: { clientId, id } });
    if (!existing) throw notFound('Customer not found');

    return prisma.customer.update({
      where: { id },
      data: {
        name: data.name,
        companyName: data.companyName,
        phone: data.phone,
        email: data.email,
        gstNumber: data.gstNumber,
        billingAddress: data.billingAddress,
        shippingAddress: data.shippingAddress,
        status: data.status,
      }
    });
  }
}

export const customerService = new CustomerService();
