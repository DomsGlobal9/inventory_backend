import { Request, Response } from 'express';
import { supportTicketService } from '../services/support-ticket.service';
import { createSupportTicketSchema } from '../validations/support-ticket.schema';

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
    res.status(500).json({ success: false, message: 'Failed to create ticket', error: error.message });
  }
};

export const listMyClientTickets = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const tickets = await supportTicketService.listTicketsForClient(user.clientId);
    res.json({ success: true, data: tickets });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load tickets', error: error.message });
  }
};

export const getMyClientTicket = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const ticket = await supportTicketService.getTicket(req.params.id as string, user.clientId);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    res.json({ success: true, data: ticket });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to load ticket', error: error.message });
  }
};

export const replyToMyClientTicket = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { body } = req.body;
    if (!body) return res.status(400).json({ success: false, message: 'body is required' });

    const message = await supportTicketService.addMessage(
      req.params.id as string,
      { authorType: 'CLIENT', authorName: user.name || user.email, body },
      user.clientId
    );
    if (!message) return res.status(404).json({ success: false, message: 'Ticket not found' });
    res.status(201).json({ success: true, data: message });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to send reply', error: error.message });
  }
};
