import { prisma } from '../lib/prisma';

// Shared by both the client-facing controller (a tenant user managing their own client's
// tickets) and the platform-admin controller (cross-tenant) -- the two callers differ only
// in whether a clientId filter is applied, not in the underlying operations.
export class SupportTicketService {
  async createTicket(params: {
    clientId: string;
    userId: string;
    userName: string;
    userEmail: string;
    subject: string;
    description: string;
    category?: string;
    priority?: string;
    linkedErrorId?: string;
  }) {
    return prisma.supportTicket.create({
      data: {
        clientId: params.clientId,
        createdByUserId: params.userId,
        createdByName: params.userName,
        createdByEmail: params.userEmail,
        subject: params.subject,
        category: (params.category as any) || 'OTHER',
        priority: (params.priority as any) || 'NORMAL',
        linkedErrorId: params.linkedErrorId,
        messages: {
          create: { authorType: 'CLIENT', authorName: params.userName, body: params.description }
        }
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } }
    });
  }

  async listTicketsForClient(clientId: string) {
    return prisma.supportTicket.findMany({
      where: { clientId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { messages: true } } }
    });
  }

  async listAllTickets() {
    return prisma.supportTicket.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { messages: true } } }
    });
  }

  async getTicket(ticketId: string, clientId?: string) {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { messages: { orderBy: { createdAt: 'asc' } } }
    });
    // clientId is passed for client-side reads only -- a tenant user must never be able to
    // pull another tenant's ticket by guessing/incrementing an id.
    if (!ticket || (clientId && ticket.clientId !== clientId)) return null;
    return ticket;
  }

  async addMessage(ticketId: string, params: { authorType: 'CLIENT' | 'PLATFORM_ADMIN'; authorName: string; body: string }, clientId?: string) {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket || (clientId && ticket.clientId !== clientId)) return null;

    const [message] = await prisma.$transaction([
      prisma.supportTicketMessage.create({ data: { ticketId, ...params } }),
      // A reply reopens a resolved/closed ticket implicitly when it comes from the client
      // side (they're telling you it's not actually resolved); a platform-admin reply just
      // bumps updatedAt so it re-sorts to the top of the queue without changing status.
      prisma.supportTicket.update({
        where: { id: ticketId },
        data: params.authorType === 'CLIENT' && (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED')
          ? { status: 'OPEN', updatedAt: new Date() }
          : { updatedAt: new Date() }
      })
    ]);

    return message;
  }

  async updateStatus(ticketId: string, status: string) {
    return prisma.supportTicket.update({ where: { id: ticketId }, data: { status: status as any } });
  }
}

export const supportTicketService = new SupportTicketService();
