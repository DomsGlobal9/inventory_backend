import { Request, Response } from 'express';
import { supportTicketService } from '../services/support-ticket.service';
import { createSupportTicketSchema } from '../validations/support-ticket.schema';
import { respondWithError } from '../utils/respondWithError';
import { grants, holdsEverything } from '../config/permissions';

/**
 * Whether this person sees every ticket the shop has raised, or only their own.
 *
 * Tickets were open to everyone signed in: a cashier with no permissions at all could read, and reply
 * to, what the owner wrote to support about money, staff or a customer. Anyone can still raise a
 * ticket and follow their own; the whole list belongs to the owner and to whoever manages the team.
 */
function seesAllTickets(user: any): boolean {
  return holdsEverything(user?.permissions, user?.roles) || grants(user?.permissions ?? [], 'admin:users');
}

export const createTicket = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    // Validate before anything reaches Prisma: an out-of-enum category/priority used to
    // surface as a 500 with a raw stack trace rather than a 400 naming the bad field.
    const parsed = createSupportTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.errors });
    }
    const { subject, description, category, priority, linkedErrorId } = parsed.data;

    const ticket = await supportTicketService.createTicket({
      clientId: user.clientId,
      userId: user.id,
      userName: user.name || user.email,
      userEmail: user.email,
      subject,
      description,
      category,
      priority,
      // schema allows null ("explicitly not linked"); the service takes string | undefined
      linkedErrorId: linkedErrorId ?? undefined
    });
    res.status(201).json({ success: true, data: ticket });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to create ticket' });
  }
};

export const listMyClientTickets = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const tickets = await supportTicketService.listTicketsForClient(user.clientId, seesAllTickets(user) ? undefined : user.id);
    res.json({ success: true, data: tickets });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to load tickets' });
  }
};

export const getMyClientTicket = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const ticket = await supportTicketService.getTicket(req.params.id as string, user.clientId);
    // Somebody else's ticket is "not found" to a person who only sees their own.
    if (!ticket || (!seesAllTickets(user) && ticket.createdByUserId !== user.id)) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    res.json({ success: true, data: ticket });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to load ticket' });
  }
};

export const replyToMyClientTicket = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { body } = req.body;
    if (!body) return res.status(400).json({ success: false, message: 'body is required' });

    if (!seesAllTickets(user)) {
      const ticket = await supportTicketService.getTicket(req.params.id as string, user.clientId);
      if (!ticket || ticket.createdByUserId !== user.id) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }
    }

    const message = await supportTicketService.addMessage(
      req.params.id as string,
      { authorType: 'CLIENT', authorName: user.name || user.email, body },
      user.clientId
    );
    if (!message) return res.status(404).json({ success: false, message: 'Ticket not found' });
    res.status(201).json({ success: true, data: message });
  } catch (error: any) {
    return respondWithError(res, error, { status: 500, message: 'Failed to send reply' });
  }
};
